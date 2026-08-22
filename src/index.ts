#!/usr/bin/env node
import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { render } from "ink";
import { git, createWorktree, why, type Provenance } from "./git.js";
import { startSession, type AgentSession, type AgentUpdate, type PermissionRequest } from "./acp.js";
import { App } from "./ui.js";

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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "why") {
    await whyCmd(argv[1]);
    return;
  }
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
