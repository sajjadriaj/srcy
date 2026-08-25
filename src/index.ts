#!/usr/bin/env node
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { git } from "./git.js";
import { renderPanel } from "./panels.js";
import { attach, have, launch, resize, sessionExists } from "./tmux.js";

// repoRoot resolves the repository srcy is being run from, or explains why
// there isn't one. Every command needs it and none of them work without it.
async function repoRoot(): Promise<string> {
  try {
    return await git(process.cwd(), "rev-parse", "--show-toplevel");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`srcy must be run inside a git repository. (${detail})`);
    process.exit(1);
  }
}

function die(msg: string): never {
  console.error(`srcy: ${msg}`);
  process.exit(1);
}

// One tmux session per repo, so running srcy again from the same directory
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
  return `srcy-${safe(base)}${tail}-${id}`;
}

// The agent name IS the command. There is no adapter to pick and no
// protocol to support — whatever binary you name runs in the big pane
// exactly as it would in a bare terminal — so a whitelist here would only
// be a list of programs srcy had heard of.
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
      // untouched: `srcy -- claude --model opus --resume`.
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
  // Run by tmux inside a pane, never by a person.
  if (argv[0] === "panel") return renderPanel(argv[1] ?? "rail", argv[2] ?? "", argv[3] ?? "");
  // Run by tmux's window-resized hook, never by a person.
  if (argv[0] === "resize") return resize(argv[1] ?? "");

  let agent: string[], name: string | undefined;
  try {
    ({ agent, name } = parseShell(argv));
  } catch (err) {
    die(err instanceof Error ? err.message : String(err));
  }

  const repo = await repoRoot();
  const session = sessionName(repo, name);

  if (!have("tmux")) {
    die("tmux is required (apt install tmux / brew install tmux). srcy hosts the agent in a tmux pane so it stays the real binary.");
  }
  // Re-attaching must not check the agent binary: the session already has
  // one running, and the check would fail for a session started elsewhere.
  if (sessionExists(session)) return attach(session);

  if (!have(agent[0]!)) die(`${agent[0]} is not on your PATH`);

  // Panels re-enter this same file. process.execPath rather than argv[0]
  // because `npm link` puts a symlink on PATH whose directory has no node.
  const self = realpathSync(fileURLToPath(import.meta.url));
  const panel = (which: string): string[] => [process.execPath, self, "panel", which, agent[0]!, session];

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
// every installed `srcy` exit 0 having done nothing at all.
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
