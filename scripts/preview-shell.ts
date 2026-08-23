// `npm run preview` — builds the real tmux layout over a fixture repo and
// prints a photograph of it.
//
// Layout work has to be looked at. Looking at this layout means looking at
// tmux's pane borders as well as ctui's panes, so a component-level render
// would be a picture of half the product. This builds the session the way
// `ctui` builds it, attaches to it from inside a second tmux session sized
// exactly, and captures that — borders, titles and all.
//
// The only fixture is the agent: a real one would need a real turn. The
// panes around it are the ones that ship, reading a real git repo and a real
// transcript file.
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOCKET, build } from "../src/tmux.js";
import { projectDir } from "../src/transcript.js";

const SESSION = "ctui-preview";
const CAMERA = "ctui-preview-camera";
// Overridable so a frame can be captured at the size it will be pasted at.
const COLS = Number(process.env.PREVIEW_COLS ?? 118);
const ROWS = Number(process.env.PREVIEW_ROWS ?? 34);

const sh = (cmd: string, args: string[], cwd?: string): void => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${r.stderr ?? ""}`);
};
// The camera is an ordinary tmux session on the default server; the layout
// being photographed lives on ctui's own socket. Keeping the two straight is
// the whole reason these are separate helpers.
const cam = (args: string[]): string => spawnSync("tmux", args, { encoding: "utf8" }).stdout?.trim() ?? "";
const camQuiet = (args: string[]): void => void spawnSync("tmux", args, { stdio: "ignore" });
const ctuiQuiet = (args: string[]): void => void spawnSync("tmux", ["-L", SOCKET, ...args], { stdio: "ignore" });

const BEFORE = [
  "export function verify(t: string) {",
  "  const exp = decode(t).exp",
  "",
  "  if (exp < now())",
  "    return null",
  "  return session",
  "}",
].join("\n");

// What the agent pane shows. Printed by a shell, because a real agent would
// need a real turn — everything else in the picture is live.
const AGENT_SCRIPT = [
  `printf '\\033]2; ✳ Claude Code \\007'`,
  `echo '> fix the token expiry off-by-one'`,
  `echo`,
  `echo '● Read  src/auth/token.ts'`,
  `echo '● Read  src/auth/session.ts'`,
  `echo`,
  `echo 'The expiry check is exclusive: a token that expires on this exact'`,
  `echo 'millisecond is still accepted. Changing < to <= in verify().'`,
  `echo`,
  `echo '● Edit  src/auth/token.ts'`,
  `echo '● Edit  src/auth/session.ts'`,
  `echo '● Bash  npm run typecheck'`,
  `echo`,
  `echo '❯ '`,
  `sleep 600`,
].join("; ");

const record = (usage: Record<string, number>): string =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-5", usage } });

const call = (id: string, name: string, input: unknown): string =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });

const result = (id: string): string =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

const todos = (...rows: [string, string][]): unknown => ({
  todos: rows.map(([content, status]) => ({ content, status, activeForm: content })),
});

async function main(): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), "ctui-preview-"));
  const transcript = projectDir(repo);

  try {
    await mkdir(join(repo, "src", "auth"), { recursive: true });
    await writeFile(join(repo, "src/auth/token.ts"), `${BEFORE}\n`);
    await writeFile(join(repo, "src/auth/session.ts"), "export class Session {\n}\n");
    // A checker that fails, because the red path is the one worth looking
    // at: it colours a row in the map, puts a count beside it, and fills
    // CHECKS. A preview where everything passes exercises none of that.
    await mkdir(join(repo, ".ctui"), { recursive: true });
    await writeFile(
      join(repo, ".ctui", "check"),
      ["#!/bin/sh", "echo \"src/auth/session.ts(3,21): error TS2532: Object is possibly 'undefined'.\"", "exit 1", ""].join("\n"),
    );
    await chmod(join(repo, ".ctui", "check"), 0o755);

    sh("git", ["init", "-q"], repo);
    sh("git", ["config", "user.email", "preview@ctui"], repo);
    sh("git", ["config", "user.name", "preview"], repo);
    sh("git", ["add", "-A"], repo);
    sh("git", ["commit", "-qm", "base"], repo);

    // The edits the fixture agent narrates, made for real so the map, the
    // counts and the dock are all reading git rather than a canned string.
    await writeFile(join(repo, "src/auth/token.ts"), `${BEFORE.replace("exp < now()", "exp <= now()")}\n`);
    await writeFile(
      join(repo, "src/auth/session.ts"),
      "export class Session {\n  private renewals = 0\n  renew() { this.renewals++ }\n}\n",
    );
    await writeFile(join(repo, "src/auth/expiry.test.ts"), "test('a token expiring now is expired', () => {})\n");

    await mkdir(transcript, { recursive: true });
    await writeFile(
      join(transcript, "preview.jsonl"),
      [
        record({ input_tokens: 4, cache_creation_input_tokens: 18_400, cache_read_input_tokens: 0, output_tokens: 923 }),
        call("t1", "TodoWrite", todos(
          ["find the expiry comparison", "completed"],
          ["fix the off-by-one", "completed"],
          ["add a regression test", "in_progress"],
        )),
        result("t1"),
        record({ input_tokens: 2, cache_creation_input_tokens: 1_200, cache_read_input_tokens: 103_598, output_tokens: 11_300 }),
        // Left open on purpose: an unanswered call is what the rail's border
        // reads as "running", which is the state worth photographing.
        call("t2", "Bash", { command: "npm run typecheck", description: "Typecheck the worktree" }),
        // Trailing newline, because the reader deliberately holds an
        // unterminated final line back as one the agent is still writing.
        "",
      ].join("\n"),
    );

    const self = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

    ctuiQuiet(["kill-session", "-t", SESSION]);
    build(
      {
        session: SESSION,
        repo,
        agent: ["sh", "-c", AGENT_SCRIPT],
        // "claude" names the session format the fixture transcript is in;
        // the pane itself runs a canned shell, since a real turn is the one
        // thing a preview cannot have.
        panel: (which) => [tsx, self, "panel", which, "claude", SESSION],
        resize: [tsx, self, "resize"],
        cols: COLS,
        rows: ROWS,
      },
      { agent: " ✳ Claude Code ", rail: " starting… ", dock: " DIFF " },
    );

    // Photograph it from inside a second session sized exactly, so the pane
    // borders tmux draws are in the picture too. `env -u TMUX` is what lets
    // one tmux attach to another on the same server.
    camQuiet(["kill-session", "-t", CAMERA]);
    sh("tmux", ["new-session", "-d", "-s", CAMERA, "-x", String(COLS), "-y", String(ROWS),
      `env -u TMUX tmux -L ${SOCKET} attach -t ${SESSION}`]);
    camQuiet(["set-option", "-t", CAMERA, "status", "off"]);
    // tmux's default `window-size latest` sizes every window to whichever
    // client on the server most recently did anything — so -x/-y at creation
    // is only a hint, and a preview would come out the size of whatever
    // terminal the user happens to have open elsewhere. Both sessions are
    // pinned so the frame is the size that was asked for. The real ctui
    // session leaves this alone: there, tracking the terminal is correct.
    camQuiet(["set-option", "-t", CAMERA, "window-size", "manual"]);
    camQuiet(["resize-window", "-t", CAMERA, "-x", String(COLS), "-y", String(ROWS)]);
    ctuiQuiet(["set-option", "-t", SESSION, "window-size", "manual"]);
    ctuiQuiet(["resize-window", "-t", SESSION, "-x", String(COLS), "-y", String(ROWS)]);
    // Long enough for a poll, a debounce and a check run to have happened.
    await new Promise((r) => setTimeout(r, 6000));
    console.log(cam(["capture-pane", "-p", "-t", CAMERA]).replace(/\s+$/gm, ""));
  } finally {
    camQuiet(["kill-session", "-t", CAMERA]);
    ctuiQuiet(["kill-session", "-t", SESSION]);
    await rm(repo, { recursive: true, force: true });
    await rm(transcript, { recursive: true, force: true });
  }
}

await main();
