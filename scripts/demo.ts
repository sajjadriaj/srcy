// `npm run demo` — records the README's animation.
//
// Everything in the picture is real except the agent's turn. srcy builds its
// own layout, the panels are the ones that ship, and they read a real git
// repo, a real transcript and a real checker as all three change underneath
// them. The agent pane replays a script instead of calling a model, because a
// recording cannot wait on a live turn and reproduce the same frames twice.
//
// The recording is taken from inside a second tmux session attached to the
// first, so tmux's own pane borders and titles are in the frame. That second
// session is the camera; it runs a plain shell, and `srcy` there is a shell
// function that attaches — which is exactly what the real binary does when a
// session for this repo already exists. Its HOME is a scratch directory, so
// no rc file of the recording machine is read and nothing of that machine can
// reach a frame.
//
// Output is an asciicast v2 file. Frames are captured on a timer and written
// only when they differ from the one before, so a second of nothing costs one
// event rather than five.
import { spawnSync } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOCKET, build, shq } from "../src/tmux.js";
import { projectDir } from "../src/transcript.js";

const SESSION = "srcy-demo";
const CAMERA = "srcy-demo-camera";
const COLS = Number(process.env.DEMO_COLS ?? 104);
const ROWS = Number(process.env.DEMO_ROWS ?? 30);
const OUT = process.env.DEMO_OUT ?? fileURLToPath(new URL("../docs/demo.cast", import.meta.url));
// Fast enough to catch a panel updating, slow enough that a forty-second
// recording is a few dozen frames rather than a few hundred.
const FRAME_MS = 180;
// Panels poll at 1.2s and the checker waits 2.5s for the diff to stop moving,
// so anything that has to show a fresh verdict waits at least this long.
const CHECK_MS = 5200;

const sh = (cmd: string, args: string[], cwd?: string): void => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${r.stderr ?? ""}`);
};
const cam = (args: string[]): string => spawnSync("tmux", args, { encoding: "utf8" }).stdout ?? "";
const camQuiet = (args: string[]): void => void spawnSync("tmux", args, { stdio: "ignore" });
const srcyQuiet = (args: string[]): void => void spawnSync("tmux", ["-L", SOCKET, ...args], { stdio: "ignore" });
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const RAIL = `${SESSION}.0`;
const AGENT_PANE = `${SESSION}.1`;
const DOCK = `${SESSION}.2`;

// ---------------------------------------------------------------------------
// The repo the demo works in

// Two comparisons, far enough apart that git makes two hunks of the fix —
// which is the point of the pane that reads it: the second edit is the one
// the old preview could never show.
const TOKEN_BEFORE = [
  "export function verify(t: string) {",
  "  const exp = decode(t).exp",
  "",
  "  if (exp < now())",
  "    return null",
  "  return session",
  "}",
  "",
  "const WINDOW_MS = 60_000",
  "",
  "export function refresh(t: string) {",
  "  const exp = decode(t).exp",
  "",
  "  if (exp < now() + WINDOW_MS)",
  "    return renew(t)",
  "  return t",
  "}",
].join("\n");
const TOKEN_AFTER = `${TOKEN_BEFORE.replace(/exp < now\(\)/g, "exp <= now()")}\n`;

// The agent's first attempt at Session.renew: reads `expiresAt` without
// checking it exists, which is what the checker below objects to.
const SESSION_BROKEN = [
  "export class Session {",
  "  private expiresAt?: number",
  "  renew() { this.expiresAt = this.expiresAt + 3600 }",
  "}",
  "",
].join("\n");
const SESSION_FIXED = [
  "export class Session {",
  "  private expiresAt?: number",
  "  renew() { this.expiresAt = (this.expiresAt ?? now()) + 3600 }",
  "}",
  "",
].join("\n");

const FILES: [string, string][] = [
  ["src/auth/token.ts", `${TOKEN_BEFORE}\n`],
  ["src/auth/session.ts", "export class Session {\n  private expiresAt?: number\n}\n"],
  ["src/auth/hash.ts", "export const hash = (s: string): string => s\n"],
  ["src/index.ts", "export * from './auth/token.js'\n"],
  ["src/http/client.ts", "export const get = (u: string): string => u\n"],
  ["src/http/routes.ts", "export const routes = []\n"],
  ["src/util/clock.ts", "export const now = (): number => Date.now()\n"],
  ["src/util/log.ts", "export const log = console.log\n"],
  ["docs/api.md", "# api\n"],
  ["package.json", '{ "name": "api" }\n'],
  ["README.md", "# api\n"],
];

// Fails on the agent's first version of renew() and passes on its second, so
// the recording shows GATES go red and come back green off real runs.
const CHECK = [
  "#!/bin/sh",
  "if grep -q 'expiresAt + 3600' src/auth/session.ts 2>/dev/null; then",
  "  echo \"src/auth/session.ts(3,32): error TS18048: 'this.expiresAt' is possibly 'undefined'.\"",
  "  exit 1",
  "fi",
  "exit 0",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// The transcript, written a line at a time while the panels read it

const record = (usage: Record<string, number>): string =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-5", usage } });

const call = (id: string, name: string, input: unknown): string =>
  JSON.stringify({
    type: "assistant",
    timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
  });

// The request itself. GOAL and the TURN baseline both read this record, and
// without one the demo showed a rail whose GOAL row said "(no request read)"
// while the pane beside it plainly showed the request being typed.
const asked = (text: string): string =>
  JSON.stringify({
    type: "user",
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text }] },
  });

const result = (id: string): string =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

const todos = (...rows: [string, string][]): unknown => ({
  todos: rows.map(([content, status]) => ({ content, status, activeForm: content })),
});

// ---------------------------------------------------------------------------
// The agent pane
//
// `tail -f` on a file the script below appends to, rather than a shell full of
// sleeps. Two hand-paced timelines drift apart the moment either one changes,
// and every line the agent "says" has to land beside the file it actually
// wrote — so there is one timeline, and the agent pane reads from it.
//
// The title is set with the same OSC 2 escape Claude Code uses, which is why
// the border reads its name without srcy writing a character of it.
const agentCmd = (out: string): string =>
  `printf '\\033]2; ✳ Claude Code \\007'; exec tail -n +1 -f ${shq(out)}`;

const CY = "\u001b[36m";
const GN = "\u001b[32m";
const OFF = "\u001b[0m";

// ---------------------------------------------------------------------------
// The cast

interface Cast {
  at: number;
  events: [number, "o", string][];
  last: string;
}

function frame(cast: Cast, text: string): void {
  if (text === cast.last) return;
  cast.last = text;
  const lines = text.split("\n");
  while (lines.length < ROWS) lines.push("");
  // Home, erase, then the whole screen: a full repaint per frame keeps the
  // cast independent of what the frame before it left behind.
  const payload = `\u001b[H\u001b[2J${lines.slice(0, ROWS).map((l) => `${l}\u001b[0m`).join("\r\n")}`;
  cast.events.push([Number(cast.at.toFixed(3)), "o", payload]);
}

function shot(cast: Cast): void {
  frame(cast, cam(["capture-pane", "-e", "-p", "-t", CAMERA]).replace(/\n+$/, ""));
}

async function main(): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), "srcy-demo-"));
  const home = await mkdtemp(join(tmpdir(), "srcy-demo-home-"));
  const transcript = projectDir(repo);
  const log = join(transcript, "demo.jsonl");
  const out = join(home, "agent.out");
  const cast: Cast = { at: 0, events: [], last: " " };

  try {
    for (const [path, body] of FILES) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), body);
    }
    await mkdir(join(repo, ".srcy"), { recursive: true });
    await writeFile(join(repo, ".srcy", "check"), CHECK);
    await chmod(join(repo, ".srcy", "check"), 0o755);

    sh("git", ["init", "-q"], repo);
    sh("git", ["config", "user.email", "demo@srcy"], repo);
    sh("git", ["config", "user.name", "demo"], repo);
    sh("git", ["add", "-A"], repo);
    sh("git", ["commit", "-qm", "base"], repo);

    await mkdir(transcript, { recursive: true });
    await writeFile(log, "");
    await writeFile(out, "");
    const jsonl = (line: string): Promise<void> => appendFile(log, `${line}\n`);
    const say = (...lines: string[]): Promise<void> => appendFile(out, `${lines.join("\n")}\n`);

    const self = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

    srcyQuiet(["kill-session", "-t", SESSION]);
    build(
      {
        session: SESSION,
        repo,
        agent: ["sh", "-c", agentCmd(out)],
        panel: (which) => [tsx, self, "panel", which, "claude", SESSION],
        resize: [tsx, self, "resize"],
        cols: COLS,
        rows: ROWS,
      },
      { agent: " ✳ Claude Code ", rail: " starting… ", dock: " DIFF " },
    );
    srcyQuiet(["set-option", "-t", SESSION, "window-size", "manual"]);
    srcyQuiet(["resize-window", "-t", SESSION, "-x", String(COLS), "-y", String(ROWS)]);

    // The camera: a plain shell at a neutral prompt, with `srcy` bound to the
    // attach the real binary performs when the repo already has a session.
    const rc = join(home, "rc");
    await writeFile(
      rc,
      [
        `PS1='\\[\\e[38;5;42m\\]~/api\\[\\e[0m\\] $ '`,
        `srcy() { env -u TMUX tmux -L ${SOCKET} attach -t ${SESSION}; }`,
        "unset HISTFILE",
        "clear",
        "",
      ].join("\n"),
    );
    camQuiet(["kill-session", "-t", CAMERA]);
    sh("tmux", [
      "new-session", "-d", "-s", CAMERA, "-x", String(COLS), "-y", String(ROWS),
      `env -u TMUX HOME=${shq(home)} TERM=xterm-256color bash --noprofile --rcfile ${shq(rc)} -i`,
    ]);
    camQuiet(["set-option", "-t", CAMERA, "status", "off"]);
    camQuiet(["set-option", "-t", CAMERA, "window-size", "manual"]);
    camQuiet(["resize-window", "-t", CAMERA, "-x", String(COLS), "-y", String(ROWS)]);
    await wait(700);

    let running = true;
    const camera = (async (): Promise<void> => {
      while (running) {
        shot(cast);
        await wait(FRAME_MS);
        cast.at += FRAME_MS / 1000;
      }
      shot(cast);
    })();

    // -----------------------------------------------------------------------
    // Launch

    await wait(800);
    for (const ch of "srcy") {
      camQuiet(["send-keys", "-t", CAMERA, ch]);
      await wait(130);
    }
    await wait(450);
    camQuiet(["send-keys", "-t", CAMERA, "Enter"]);
    await wait(1600);

    // -----------------------------------------------------------------------
    // The turn. Every step is the real thing a panel is reading: a file on
    // disk, a line in the transcript, a checker that starts failing.

    await say(`${CY}>${OFF} fix the token expiry off-by-one`, "");
    await jsonl(asked("fix the token expiry off-by-one"));
    await wait(1100);
    await say(`${GN}●${OFF} Read  src/auth/token.ts`);
    await wait(800);
    await say(`${GN}●${OFF} Read  src/auth/session.ts`);
    await jsonl(record({ input_tokens: 4, cache_creation_input_tokens: 18_400, cache_read_input_tokens: 0, output_tokens: 923 }));
    await wait(1400);

    await say(
      "",
      "The expiry check is exclusive: a token that expires on this",
      "exact millisecond is still accepted. Changing < to <= in both",
      "verify() and refresh(), and the same guard in Session.renew().",
      "",
    );
    await jsonl(call("t1", "TodoWrite", todos(
      ["find the expiry comparison", "in_progress"],
      ["fix the off-by-one", "pending"],
      ["add a regression test", "pending"],
    )));
    await jsonl(result("t1"));
    await wait(1800);

    await say(`${GN}●${OFF} Edit  src/auth/token.ts`);
    await writeFile(join(repo, "src/auth/token.ts"), TOKEN_AFTER);
    await wait(1600);

    await jsonl(call("t2", "TodoWrite", todos(
      ["find the expiry comparison", "completed"],
      ["fix the off-by-one", "in_progress"],
      ["add a regression test", "pending"],
    )));
    await jsonl(result("t2"));
    await jsonl(record({ input_tokens: 2, cache_creation_input_tokens: 1_200, cache_read_input_tokens: 61_400, output_tokens: 4_100 }));
    await wait(1400);

    await say(`${GN}●${OFF} Edit  src/auth/session.ts`);
    await writeFile(join(repo, "src/auth/session.ts"), SESSION_BROKEN);
    await wait(1800);

    await say(`${GN}●${OFF} Write src/auth/expiry.test.ts`);
    await writeFile(join(repo, "src/auth/expiry.test.ts"), "test('a token expiring now is expired', () => {})\n");
    await jsonl(call("t3", "TodoWrite", todos(
      ["find the expiry comparison", "completed"],
      ["fix the off-by-one", "completed"],
      ["add a regression test", "in_progress"],
    )));
    await jsonl(result("t3"));
    await wait(1700);

    // A deletion, because agents delete things and the tree draws that
    // differently from an edit — which is the whole reason it draws it
    // differently.
    await say(`${GN}●${OFF} Bash  rm src/util/log.ts`);
    await rm(join(repo, "src/util/log.ts"));
    await jsonl(call("t5", "Bash", { command: "rm src/util/log.ts", description: "Remove the unused logger" }));
    await jsonl(result("t5"));
    await wait(1600);

    await say(`${GN}●${OFF} Bash  npm run typecheck`);
    await jsonl(record({ input_tokens: 3, cache_creation_input_tokens: 900, cache_read_input_tokens: 104_900, output_tokens: 12_050 }));
    // Left unanswered on purpose: an open call is what the rail's border reads
    // as running, and the clock beside it is the point of that border.
    await jsonl(call("t4", "Bash", { command: "npm run typecheck", description: "Typecheck the worktree" }));
    await wait(CHECK_MS);

    // -----------------------------------------------------------------------
    // Straight to what broke. GATES names a file and a line; `e` is the walk
    // between reading that and reading the code.

    srcyQuiet(["select-pane", "-t", RAIL]);
    await wait(1400);
    srcyQuiet(["send-keys", "-t", RAIL, "e"]);
    await wait(2600);

    // -----------------------------------------------------------------------
    // Pinning a file. The dock is on session.ts because that is what broke;
    // the reader wants token.ts, and the tree is quicker to read with
    // everything the turn never touched out of it.

    srcyQuiet(["send-keys", "-t", RAIL, "m"]);
    await wait(2000);
    for (let i = 0; i < 3; i++) {
      srcyQuiet(["send-keys", "-t", RAIL, "j"]);
      await wait(480);
    }
    await wait(600);
    srcyQuiet(["send-keys", "-t", RAIL, "Enter"]);
    await wait(2200);

    // -----------------------------------------------------------------------
    // Reading the change. The dock is a reviewer, not a preview: every hunk
    // of the file, side by side and back, then the file before it, then back
    // to following the agent.

    srcyQuiet(["select-pane", "-t", DOCK]);
    await wait(900);
    srcyQuiet(["send-keys", "-t", DOCK, "]"]);
    await wait(1400);
    // Side by side on the hunk already on screen, so the two views can be
    // compared against each other rather than against a memory of one.
    srcyQuiet(["send-keys", "-t", DOCK, "s"]);
    await wait(2400);
    srcyQuiet(["send-keys", "-t", DOCK, "s"]);
    await wait(1200);
    srcyQuiet(["send-keys", "-t", DOCK, "p"]);
    await wait(1600);
    srcyQuiet(["send-keys", "-t", DOCK, "f"]);
    await wait(1400);

    // -----------------------------------------------------------------------
    // Zoom. The panels are one keystroke from gone — ctrl-b z in a real
    // session, driven here through the command tmux binds it to so the
    // recording does not depend on the reader's prefix key.

    srcyQuiet(["select-pane", "-t", AGENT_PANE]);
    await wait(600);
    srcyQuiet(["resize-pane", "-Z", "-t", AGENT_PANE]);
    await wait(2600);
    srcyQuiet(["resize-pane", "-Z", "-t", AGENT_PANE]);
    await wait(1200);

    // -----------------------------------------------------------------------
    // Dragging the border. The panels reflow to whatever width they are given:
    // the gauge's bar gives up cells before its digits do, and the tree clips
    // rather than wrapping.

    srcyQuiet(["resize-pane", "-t", RAIL, "-R", "12"]);
    await wait(1500);
    srcyQuiet(["resize-pane", "-t", RAIL, "-L", "12"]);
    await wait(1200);

    // -----------------------------------------------------------------------
    // The fix. GATES comes back green off a real run of the same checker.

    await say(`${GN}●${OFF} Edit  src/auth/session.ts`);
    await writeFile(join(repo, "src/auth/session.ts"), SESSION_FIXED);
    await jsonl(result("t4"));
    await wait(1500);
    await say(`${GN}●${OFF} Bash  npm run typecheck`, "");
    await jsonl(call("t5", "Bash", { command: "npm run typecheck", description: "Typecheck the worktree" }));
    await jsonl(result("t5"));
    await jsonl(call("t6", "TodoWrite", todos(
      ["find the expiry comparison", "completed"],
      ["fix the off-by-one", "completed"],
      ["add a regression test", "completed"],
    )));
    await jsonl(result("t6"));
    await jsonl(record({ input_tokens: 2, cache_creation_input_tokens: 700, cache_read_input_tokens: 118_200, output_tokens: 13_400 }));
    await wait(CHECK_MS);
    await say(`Expiry is inclusive now, and renew() guards the optional.`, "", `${CY}❯${OFF}`);
    await wait(2600);

    running = false;
    await camera;

    const header = {
      version: 2,
      width: COLS,
      height: ROWS,
      timestamp: Math.floor(Date.now() / 1000),
      idle_time_limit: 1.5,
      env: { TERM: "xterm-256color", SHELL: "/bin/sh" },
    };
    await mkdir(dirname(OUT), { recursive: true });
    await writeFile(OUT, [JSON.stringify(header), ...cast.events.map((e) => JSON.stringify(e)), ""].join("\n"));
    console.log(`${OUT}  ${cast.events.length} frames  ${cast.at.toFixed(1)}s`);
  } finally {
    camQuiet(["kill-session", "-t", CAMERA]);
    srcyQuiet(["kill-session", "-t", SESSION]);
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(transcript, { recursive: true, force: true });
  }
}

await main();
