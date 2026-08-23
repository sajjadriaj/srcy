#!/usr/bin/env node
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { render } from "ink";
import { git, createWorktree, why, type Provenance } from "./git.js";
import { startSession, type AgentSession, type AgentUpdate, type PermissionRequest } from "./acp.js";
import { App } from "./ui.js";
import { renderPanel } from "./panels.js";
import { attach, have, launch, resize, sessionExists } from "./tmux.js";

// installSignalCleanup makes closing the terminal (SIGHUP) or a plain
// SIGTERM close the agent's own process group instead of orphaning it.
// `close()` normally only runs after waitUntilExit() resolves, but that
// never resolves on a signal — Ink's stdin/stdout may already be gone with
// the terminal — so this can't wait for that path; it closes the session
// directly. Node's default action for both signals is immediate
// termination, and adding a listener replaces that default, so this must
// terminate the process itself once cleanup is done. Exported so the
// cleanup logic itself — not real OS signals or process.exit — is what
// gets tested.
export function installSignalCleanup(
  session: Pick<AgentSession, "close">,
  proc: Pick<NodeJS.Process, "once" | "exit"> = process,
): void {
  let handled = false;
  const handler = (): void => {
    if (handled) return;
    handled = true;
    // A rejected session.close() must still exit the process — an agent
    // stuck mid-close can't be left hanging around after the terminal that
    // launched it is gone — and .catch() before the continuation (not
    // .finally(), which propagates the rejection onward unhandled) is what
    // keeps that failure from surfacing as an unhandled rejection.
    session
      .close()
      .catch(() => {})
      .then(() => proc.exit(0));
  };
  proc.once("SIGTERM", handler);
  proc.once("SIGHUP", handler);
}

// Which adapter `--agent <name>` spawns. Both speak ACP, so nothing
// downstream of startSession cares which one is running.
const AGENTS: Record<string, string[]> = {
  claude: ["npx", "-y", "@zed-industries/claude-code-acp"],
  codex: ["npx", "-y", "@zed-industries/codex-acp"],
};

// Throws on bad usage rather than exiting, so main() prints one line and
// the parser stays testable.
export function parseArgs(argv: string[]): { name: string; explain: boolean; agentArgv: string[] } {
  let name = "s1";
  let explain = false;
  let agent = "claude";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name" || argv[i] === "--agent") {
      const flag = argv[i]!;
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      if (flag === "--name") name = value;
      else agent = value;
      i++;
    } else if (argv[i] === "--explain") {
      explain = true;
    }
  }
  const agentArgv = AGENTS[agent];
  // An unknown name must not fall back to claude: someone who typed
  // `--agent codx` would get a working session driven by the wrong agent
  // and no sign of it.
  if (agentArgv === undefined) {
    throw new Error(`unknown --agent ${JSON.stringify(agent)} (known: ${Object.keys(AGENTS).join(", ")})`);
  }
  return { name, explain, agentArgv };
}

// Attempts to pin the session to "default" mode, per the invariant that
// nothing the agent writes should land unreviewed regardless of the user's
// ambient adapter config. If we can't confirm "default", the caller must
// show the actual mode prominently rather than silently trust it.
async function resolveMode(session: AgentSession): Promise<{ mode: string; degraded: boolean }> {
  const modes = session.modes;
  if (!modes) return { mode: "unknown", degraded: true };
  if (modes.currentModeId === "default") return { mode: "default", degraded: false };
  const hasDefault = modes.availableModes.some((m) => m.id === "default");
  if (!hasDefault) return { mode: modes.currentModeId, degraded: true };
  try {
    await session.setMode("default");
    return { mode: "default", degraded: false };
  } catch {
    return { mode: modes.currentModeId, degraded: true };
  }
}

// whyCmd handles `ctui why <file>:<line>`: resolve the file relative to the
// repo root and print every commit that touched that line, newest first.
async function whyCmd(target: string | undefined): Promise<void> {
  const i = target?.lastIndexOf(":") ?? -1;
  const line = i >= 0 ? Number(target!.slice(i + 1)) : NaN;
  if (target === undefined || i < 0 || !Number.isInteger(line) || line <= 0) {
    console.error("usage: ctui why <file>:<line>");
    process.exit(1);
  }
  const filePart = target.slice(0, i);

  let repo: string;
  try {
    repo = await git(process.cwd(), "rev-parse", "--show-toplevel");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`ctui must be run inside a git repository. (${detail})`);
    process.exit(1);
  }

  const rel = relative(repo, resolvePath(filePart));

  let prov: Provenance[];
  try {
    prov = await why(repo, rel, line);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (prov.length === 0) {
    console.log("no history for that line");
    return;
  }
  for (const p of prov) {
    console.log(`${p.date}  ${p.sha.slice(0, 8)}  ${p.session}`);
    if (p.prompt !== "") console.log(`  you asked: ${JSON.stringify(p.prompt)}`);
    for (const l of p.body.split("\n")) {
      if (l.startsWith("Ctui-")) continue; // the provenance trailers themselves, already shown above
      console.log(`  ${l}`);
    }
    console.log("");
  }
}

// The original review-gate cockpit: ctui drives the agent over ACP in a
// worktree and renders its own chat. Kept reachable as `ctui gate` because
// the accept/provenance flow has no equivalent yet in the panel layout, but
// it is no longer the default — an agent puppeted over a protocol loses its
// slash commands, its keybinds and its scrollback, which is the opposite of
// what the panels exist to preserve.
async function gateCmd(argv: string[]): Promise<void> {
  let name: string, explain: boolean, agentArgv: string[];
  try {
    ({ name, explain, agentArgv } = parseArgs(argv));
  } catch (err) {
    console.error(`ctui: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  let repo: string;
  try {
    repo = await git(process.cwd(), "rev-parse", "--show-toplevel");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`ctui must be run inside a git repository. (${detail})`);
    process.exit(1);
  }

  const worktree = await createWorktree(repo, name);

  const bridge = new EventEmitter();
  let session: AgentSession;
  try {
    session = await startSession({
      cwd: worktree.path,
      argv: agentArgv,
      onUpdate: (u: AgentUpdate) => bridge.emit("update", u),
      onPermission: (req: PermissionRequest) =>
        new Promise<string | null>((resolve) => bridge.emit("permission", req, resolve)),
    });
  } catch (err) {
    // Nothing ran, so there is no work to preserve.
    await worktree.destroy().catch(() => {});
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`ctui: failed to start agent session: ${detail}`);
    process.exit(1);
  }

  installSignalCleanup(session);

  const { mode: initialMode, degraded: modeDegraded } = await resolveMode(session);

  let agentDied = false;
  const instance = render(
    React.createElement(App, {
      branch: worktree.branch,
      session,
      bridge,
      worktree,
      initialMode,
      modeDegraded,
      explain,
      onExit: (result: { agentDied: boolean }) => {
        agentDied = result.agentDied;
      },
    }),
    // Ink's default Ctrl+C handling exits immediately and unconditionally,
    // bypassing App's own confirm-before-exit-while-running logic. Disabling
    // it hands every Ctrl+C to App's useInput handler instead.
    { exitOnCtrlC: false },
  );

  await instance.waitUntilExit();
  // Ordering matters: close() (see acp.ts) now waits for the agent's whole
  // process group to actually die — not just for its stdout pipe to close —
  // before resolving, so by the time worktree.destroy() runs below, nothing
  // is left that could still be writing into the worktree it force-removes.
  await session.close().catch(() => {});

  if (agentDied) {
    console.error(`Agent process exited unexpectedly. Worktree kept at ${worktree.path}`);
    return;
  }
  await worktree.destroy();
}

// repoRoot resolves the repository ctui is being run from, or explains why
// there isn't one. Every command needs it and none of them work without it.
async function repoRoot(): Promise<string> {
  try {
    return await git(process.cwd(), "rev-parse", "--show-toplevel");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`ctui must be run inside a git repository. (${detail})`);
    process.exit(1);
  }
}

function die(msg: string): never {
  console.error(`ctui: ${msg}`);
  process.exit(1);
}

// One tmux session per repo, so running ctui again from the same directory
// re-attaches to the agent already working there instead of starting a
// second one beside it. `--name` is for wanting two on purpose.
export function sessionName(repo: string, name?: string): string {
  const base = repo.split("/").filter(Boolean).pop() ?? "repo";
  // tmux treats . and : as target syntax, so they cannot appear in a name.
  const safe = (s: string): string => s.replace(/[.:\s]/g, "-");
  // The basename alone is not the repo: ~/work/api and ~/side/api are both
  // "api", and re-attaching by name would put the reader in front of an
  // agent working in the other one — with a rail describing a repo they are
  // not looking at. The suffix is what makes the name identify the path.
  const id = createHash("sha1").update(repo).digest("hex").slice(0, 6);
  const tail = name === undefined ? "" : `-${safe(name)}`;
  return `ctui-${safe(base)}${tail}-${id}`;
}

// The agent name IS the command. There is no adapter to pick and no
// protocol to support — whatever binary you name runs in the big pane
// exactly as it would in a bare terminal — so a whitelist here would only
// be a list of programs ctui had heard of.
export function parseShell(argv: string[]): { agent: string[]; name?: string } {
  let agent = ["claude"];
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--agent" || flag === "--name") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      if (flag === "--name") name = value;
      else agent = value.split(" ").filter((s) => s !== "");
      i++;
    } else if (flag === "--") {
      // Everything after -- is the agent's own argv, passed through
      // untouched: `ctui -- claude --model opus --resume`.
      agent = argv.slice(i + 1);
      break;
    } else {
      // Never ignored: a mistyped `--agnet codex` that silently starts the
      // default agent gives a working session driven by the wrong one, and
      // nothing on screen says so.
      throw new Error(`unknown option ${JSON.stringify(flag!)}`);
    }
  }
  if (agent.length === 0) throw new Error("no agent command given");
  return { agent, name };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "why") return whyCmd(argv[1]);
  // Run by tmux inside a pane, never by a person.
  if (argv[0] === "panel") return renderPanel(argv[1] ?? "rail");
  // Run by tmux's window-resized hook, never by a person.
  if (argv[0] === "resize") return resize(argv[1] ?? "");
  if (argv[0] === "gate") return gateCmd(argv.slice(1));

  let agent: string[], name: string | undefined;
  try {
    ({ agent, name } = parseShell(argv));
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  const repo = await repoRoot();
  const session = sessionName(repo, name);

  if (!have("tmux")) {
    die("tmux is required (apt install tmux / brew install tmux). ctui hosts the agent in a tmux pane so it stays the real binary.");
  }
  // Re-attaching must not check the agent binary: the session already has
  // one running, and the check would fail for a session started elsewhere.
  if (sessionExists(session)) return attach(session);

  if (!have(agent[0]!)) die(`${agent[0]} is not on your PATH`);

  // Panels re-enter this same file. process.execPath rather than argv[0]
  // because `npm link` puts a symlink on PATH whose directory has no node.
  const self = realpathSync(fileURLToPath(import.meta.url));
  const panel = (which: string): string[] => [process.execPath, self, "panel", which];

  try {
    launch(
      {
        session,
        repo,
        agent,
        panel,
        resize: [process.execPath, self, "resize"],
        cols: process.stdout.columns ?? 120,
        rows: process.stdout.rows ?? 40,
      },
      { agent: ` ${agent[0]} `, rail: " starting… ", dock: " DIFF " },
    );
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }
}

// Only run when this file is the entry point, not merely imported — index.test.ts
// imports installSignalCleanup for direct testing, and main() is a real CLI
// run (spawns the agent, renders Ink, touches the real filesystem): that must
// never fire as a side effect of importing this module for its exports.
// Both sides go through realpathSync: `npm link` and `npm install -g` put a
// symlink in node_modules/.bin, so argv[1] is that symlink while
// import.meta.url is always the real file. Comparing them unresolved makes
// every installed `ctui` exit 0 having done nothing at all.
const isEntryPoint = ((): boolean => {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolvePath(invoked));
  } catch {
    return false;
  }
})();
if (isEntryPoint) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
}
