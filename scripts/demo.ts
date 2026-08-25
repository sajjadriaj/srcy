// `npm run demo` — records the README's animation.
//
// Everything in the picture is real except the agent's turn. srcy builds its
// own layout, the panels are the ones that ship, and they read a real git
// repo, a real transcript and a real checker as all three change underneath
// them. The agent pane runs a script instead of a model, because a recording
// cannot wait on a live turn and reproduce the same frames twice.
//
// The recording is taken from inside a second tmux session attached to the
// first, so tmux's own pane borders and titles are in the frame. That second
// session is the camera; it runs a plain shell, and `srcy` there is a shell
// function that attaches — which is exactly what the real binary does when a
// session for this repo already exists.
//
// Output is an asciicast v2 file. Frames are captured on a timer and written
// only when they differ from the one before, so a second of nothing costs one
// event rather than five.
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
// Fast enough to catch a panel updating, slow enough that a thirty-second
// recording is a few dozen frames rather than a few hundred.
const FRAME_MS = 180;

const sh = (cmd: string, args: string[], cwd?: string): void => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${r.stderr ?? ""}`);
};
const cam = (args: string[]): string => spawnSync("tmux", args, { encoding: "utf8" }).stdout ?? "";
const camQuiet = (args: string[]): void => void spawnSync("tmux", args, { stdio: "ignore" });
const srcyQuiet = (args: string[]): void => void spawnSync("tmux", ["-L", SOCKET, ...args], { stdio: "ignore" });
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// The repo the demo works in

const TOKEN_BEFORE = [
  "export function verify(t: string) {",
  "  const exp = decode(t).exp",
  "",
  "  if (exp < now())",
  "    return null",
  "  return session",
  "}",
].join("\n");

const FILES: [string, string][] = [
  ["src/auth/token.ts", `${TOKEN_BEFORE}\n`],
  ["src/auth/session.ts", "export class Session {\n}\n"],
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

// Passes until the agent's second edit lands, so the recording shows CHECKS
// going red on a real run rather than starting there.
const CHECK = [
  "#!/bin/sh",
  "if grep -q renewals src/auth/session.ts 2>/dev/null; then",
  "  echo \"src/auth/session.ts(3,21): error TS2532: Object is possibly 'undefined'.\"",
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

const result = (id: string): string =>
  JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });

const todos = (...rows: [string, string][]): unknown => ({
  todos: rows.map(([content, status]) => ({ content, status, activeForm: content })),
});

// ---------------------------------------------------------------------------
// The agent pane
//
// A shell, paced to match the edits the script below makes for real. The
// title is set with the same OSC 2 escape Claude Code uses, which is why the
// border reads its name without srcy writing a character of it.
// Single-quoted, not JSON-quoted: JSON.stringify turns an escape byte into
// the six characters ``, and printf %s prints exactly those six.
const say = (s: string, after = 0.6): string => `printf '%s\\n' ${shq(s)}; sleep ${after}`;
const AGENT = [
  `printf '\\033]2; ✳ Claude Code \\007'`,
  "sleep 1.2",
  say("\u001b[36m>\u001b[0m fix the token expiry off-by-one", 1.4),
  say(""),
  say("\u001b[32m●\u001b[0m Read  src/auth/token.ts", 1.0),
  say("\u001b[32m●\u001b[0m Read  src/auth/session.ts", 1.6),
  say(""),
  say("The expiry check is exclusive: a token that expires on this", 0.35),
  say("exact millisecond is still accepted. Changing < to <= in", 0.35),
  say("verify(), and the same guard in Session.renew().", 1.6),
  say(""),
  say("\u001b[32m●\u001b[0m Edit  src/auth/token.ts", 3.4),
  say("\u001b[32m●\u001b[0m Edit  src/auth/session.ts", 3.6),
  say("\u001b[32m●\u001b[0m Write src/auth/expiry.test.ts", 2.2),
  say("\u001b[32m●\u001b[0m Bash  npm run typecheck", 0.4),
  say(""),
  say("\u001b[36m❯\u001b[0m", 600),
].join("; ");

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
  const transcript = projectDir(repo);
  const log = join(transcript, "demo.jsonl");
  const cast: Cast = { at: 0, events: [], last: "\u0000" };

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
    const append = async (line: string): Promise<void> => {
      const { appendFile } = await import("node:fs/promises");
      await appendFile(log, `${line}\n`);
    };

    const self = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

    srcyQuiet(["kill-session", "-t", SESSION]);
    build(
      {
        session: SESSION,
        repo,
        agent: ["sh", "-c", AGENT],
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
    //
    // Its HOME is a scratch directory, so no rc file of the machine doing the
    // recording is read and nothing of that machine can reach the frame.
    const home = await mkdtemp(join(tmpdir(), "srcy-demo-home-"));
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

    // A capture loop, and a script of things that happen while it runs.
    let running = true;
    const camera = (async (): Promise<void> => {
      while (running) {
        shot(cast);
        await wait(FRAME_MS);
        cast.at += FRAME_MS / 1000;
      }
      shot(cast);
    })();

    const at = async (ms: number, fn: () => Promise<void> | void): Promise<void> => {
      await wait(ms);
      await fn();
    };

    // Typing `srcy`, one keystroke at a time.
    await wait(900);
    for (const ch of "srcy") {
      camQuiet(["send-keys", "-t", CAMERA, ch]);
      await wait(130);
    }
    await wait(500);
    camQuiet(["send-keys", "-t", CAMERA, "Enter"]);

    // The turn. Each step is the real thing the panels are reading: a file on
    // disk, a line in the transcript, a checker that now fails.
    await at(2600, () => append(record({ input_tokens: 4, cache_creation_input_tokens: 18_400, cache_read_input_tokens: 0, output_tokens: 923 })));
    await at(4200, async () => {
      await append(call("t1", "TodoWrite", todos(
        ["find the expiry comparison", "in_progress"],
        ["fix the off-by-one", "pending"],
        ["add a regression test", "pending"],
      )));
      await append(result("t1"));
    });
    await at(3000, () => writeFile(join(repo, "src/auth/token.ts"), `${TOKEN_BEFORE.replace("exp < now()", "exp <= now()")}\n`));
    await at(1200, async () => {
      await append(call("t2", "TodoWrite", todos(
        ["find the expiry comparison", "completed"],
        ["fix the off-by-one", "in_progress"],
        ["add a regression test", "pending"],
      )));
      await append(result("t2"));
      await append(record({ input_tokens: 2, cache_creation_input_tokens: 1_200, cache_read_input_tokens: 61_400, output_tokens: 4_100 }));
    });
    await at(2600, () =>
      writeFile(join(repo, "src/auth/session.ts"), "export class Session {\n  private renewals = 0\n  renew() { this.renewals++ }\n}\n"));
    await at(2400, async () => {
      await append(call("t3", "TodoWrite", todos(
        ["find the expiry comparison", "completed"],
        ["fix the off-by-one", "completed"],
        ["add a regression test", "in_progress"],
      )));
      await append(result("t3"));
      await writeFile(join(repo, "src/auth/expiry.test.ts"), "test('a token expiring now is expired', () => {})\n");
    });
    await at(2200, async () => {
      await append(record({ input_tokens: 3, cache_creation_input_tokens: 900, cache_read_input_tokens: 104_900, output_tokens: 12_050 }));
      // Left unanswered: an open call is what the rail's border reads as
      // running, and the clock beside it is the point of that border.
      await append(call("t4", "Bash", { command: "npm run typecheck", description: "Typecheck the worktree" }));
    });

    // Long enough for the debounce and a check run: CHECKS goes red, and the
    // dock prints the message the rail has no room for.
    await wait(6000);

    // The keyboard moves to the rail, walks the tree, and pins the dock.
    srcyQuiet(["select-pane", "-t", `${SESSION}.0`]);
    await wait(1600);
    // Three rows down from where the cursor parked itself — on the session's
    // own work — is token.ts, which the agent changed but the dock is not
    // showing. Enter pins it.
    for (let i = 0; i < 3; i++) {
      srcyQuiet(["send-keys", "-t", `${SESSION}.0`, "j"]);
      await wait(520);
    }
    await wait(700);
    srcyQuiet(["send-keys", "-t", `${SESSION}.0`, "Enter"]);
    await wait(4000);

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
    await rm(transcript, { recursive: true, force: true });
    await rm(join(tmpdir(), "srcy-demo-home"), { recursive: true, force: true });
  }
}

await main();
