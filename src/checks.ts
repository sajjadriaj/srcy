import { spawn } from "node:child_process";
import { access, constants, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

// One compiler or test failure, anchored to a place in the tree. `line` is
// 1-based; 0 means the tool named a file but no line.
export interface Problem {
  path: string; // repo-relative, POSIX separators — same space as the repo map
  line: number;
  message: string;
  // Errors before warnings, everywhere a list of these is shown. A linter
  // that exits non-zero over three errors and forty warnings would otherwise
  // bury the three under the forty, in a pane with room for four rows.
  severity: "error" | "warning";
  // The gate that found it. The parser cannot know — it is reading text —
  // so this is stamped on by whoever ran the command.
  check: string;
}

// How long a check may run before it is killed. A check is something the
// human is waiting on between turns, not a CI job.
const TIMEOUT_MS = 120_000;
// Enough of the output to show what happened without pushing the pane off
// the terminal; the full run stays in the user's own project tooling.
const TAIL_LINES = 12;
// A wall of problems is noise — the first few are what get fixed.
const MAX_PROBLEMS = 20;
// How far into the output to keep looking. Errors are sorted ahead of
// warnings before the cap is applied, so the scan has to outrun the cap —
// otherwise a run whose first twenty lines are warnings hides every error
// under them, which is the exact failure MAX_PROBLEMS was meant to prevent.
const MAX_SCAN = 400;

// checkCommand decides what to run. `.srcy/check` (executable, in the user's
// real repo) wins outright: it is the escape hatch for any project whose
// build is not one command. Otherwise we fall back to the one npm script
// that is nearly always a fast correctness check.
//
// ponytail: two cases, not a build-system detector. Cargo, Go, Maven and
// friends each want their own command and their own error format; add
// `.srcy/check` and you have all of them. Grow this only if one ecosystem
// turns out to be worth special-casing.
export async function checkCommand(repo: string): Promise<string[] | null> {
  const script = join(repo, ".srcy", "check");
  try {
    await access(script, constants.X_OK);
    return [script];
  } catch {
    // no executable .srcy/check — fall through
  }
  try {
    const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    for (const name of ["typecheck", "build"]) {
      if (typeof pkg.scripts?.[name] === "string") return ["npm", "run", name, "--silent"];
    }
  } catch {
    // no package.json, or not JSON — nothing to run
  }
  return null;
}

// Matches "src/a.ts:41:5: message" and "src/a.ts:41: message" — the format
// every compiler except tsc's default uses.
const COLON_RE = /^\s*(?:[-*✖✗x]\s+)?([\w./@+-]+\.[A-Za-z][\w]*):(\d+)(?::(\d+))?[:\s]\s*(.*)$/;
// Matches tsc's own default: "src/a.ts(41,5): error TS2322: message".
const PAREN_RE = /^\s*([\w./@+-]+\.[A-Za-z][\w]*)\((\d+),(\d+)\):\s*(.*)$/;
// Matches a stack or runner frame: "at fn (/abs/test/a.test.ts:22:10)" and
// node:test's own "test at test/a.test.ts:99:1".
const FRAME_RE = /(?:^|\s|\()((?:[\w./@+-]|\\)+\.[A-Za-z][\w]*):(\d+):(\d+)\)?\s*$/;
// Matches rustc and cargo: "  --> src/main.rs:4:5". The message is on the
// line above it, which is why CARGO_HEAD exists.
const ARROW_RE = /^\s*-->\s+((?:[\w./@+-]|\\)+\.[A-Za-z][\w]*):(\d+):(\d+)\s*$/;
const CARGO_HEAD_RE = /^(error|warning)(?:\[[^\]]+\])?:\s*(.+)$/;
// Matches eslint's default formatter, which names the file once and then
// indents every finding under it:
//
//   /abs/src/a.js
//     12:5  error  Unexpected console statement  no-console
//
// Neither line is a location on its own, so a parser that reads one line at
// a time finds nothing at all in an eslint run — which is how a lint gate
// ends up saying only "failing" with a list of locations right there.
const BARE_PATH_RE = /^\s*((?:[\w./@+-]|\\)+\.[A-Za-z][\w]*)\s*$/;
const UNDER_PATH_RE = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.*)$/;

function toRepoRelative(cwd: string, path: string): string {
  const p = isAbsolute(path) ? relative(cwd, path) : path;
  return sep === "/" ? p : p.split(sep).join("/");
}

// parseProblems pulls file/line pairs out of whatever the check printed. It
// is deliberately format-agnostic: anything that looks like a location is
// one, because the alternative is a parser per tool that silently reports
// "no problems" the first time a tool changes its output.
//
// Duplicates collapse by path and line — a compiler that repeats a location
// in a summary block should not double the count — and the first message
// for a location wins, since that is the one with the detail.
export function parseProblems(output: string, cwd: string, check = ""): Problem[] {
  const seen = new Set<string>();
  const problems: Problem[] = [];
  // The two formats that split one finding across two lines. Both are reset
  // by nothing: a stale header can only mislabel a finding, where clearing
  // it on the wrong line would drop the finding entirely.
  let underFile = "";
  let cargoSays = "";

  const add = (path: string, lineNo: number, message: string, severity: Problem["severity"]): void => {
    const rel = toRepoRelative(cwd, path);
    // A location outside the tree (node internals, a dependency's own
    // stack frame) is never something the reviewer can act on here.
    if (rel.startsWith("../") || rel.startsWith("node_modules/") || rel.startsWith("node:")) return;
    if (!Number.isFinite(lineNo) || lineNo <= 0) return;
    const key = `${rel}:${lineNo}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({ path: rel, line: lineNo, message, severity, check });
  };

  for (const raw of output.split("\n").slice(0, MAX_SCAN)) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();

    const arrow = ARROW_RE.exec(line);
    if (arrow) {
      // rustc puts the sentence above the location, so the location alone
      // reads as "something is wrong at src/main.rs:4" — true, and useless.
      add(arrow[1]!, Number(arrow[2]), cargoSays === "" ? line.trim() : cargoSays, severityOf(cargoSays));
      continue;
    }
    const head = CARGO_HEAD_RE.exec(line);
    if (head) {
      cargoSays = `${head[1]}: ${head[2]!.trim()}`;
      continue;
    }

    const m = PAREN_RE.exec(line) ?? COLON_RE.exec(line) ?? FRAME_RE.exec(line);
    if (m) {
      const message = (m[4] ?? "").trim();
      const text = message === "" ? line.trim() : message;
      add(m[1]!, Number(m[2]), text, severityOf(text));
      continue;
    }

    const under = UNDER_PATH_RE.exec(line);
    if (under && underFile !== "") {
      add(underFile, Number(under[1]), under[4]!.trim(), under[3] === "warning" ? "warning" : "error");
      continue;
    }
    const bare = BARE_PATH_RE.exec(line);
    if (bare) underFile = bare[1]!;
  }

  // Errors first, and stable within each: the order a tool printed them in
  // is the order it thinks they happened in, which is better than any
  // re-sort this could invent.
  return problems
    .map((p, i) => [p, i] as const)
    .sort(([a, i], [b, j]) => (a.severity === b.severity ? i - j : a.severity === "error" ? -1 : 1))
    .map(([p]) => p)
    .slice(0, MAX_PROBLEMS);
}

// What the tool called it. Anything that says warning and does not also say
// error is one; everything else is an error, because a check that exited
// non-zero over something this cannot classify is not a warning.
function severityOf(text: string): Problem["severity"] {
  return /\bwarn(ing)?\b/i.test(text) && !/\berror\b/i.test(text) ? "warning" : "error";
}

// runCommand runs one of the project's own commands inside the worktree and
// collects everything it printed.
//
// The child gets its own process group so a timeout kills what it spawned
// rather than the wrapper: npm execs into the real tool through a shell, and
// killing npm alone leaves a compiler running for the rest of the session.
export interface Ran {
  text: string;
  code: number | null;
  // Distinct from a non-zero exit. A gate that ran out of time has not
  // failed — nothing was proved either way — and rewriting it to "failing"
  // sends the reader looking for a bug that may not exist.
  timedOut: boolean;
  // Stopped on purpose, before it could say anything: the tree moved under
  // it, or the panel is going away.
  killed: boolean;
}


export interface Run {
  done: Promise<Ran>;
  // Stop it early. The result still arrives, marked killed, so a caller
  // waiting on `done` is never left waiting on a process that is gone.
  kill: () => void;
}

// Everything started here and not yet finished. A gate's child is in its own
// process group so a timeout can kill what it spawned — which also means the
// panel exiting does not take it along, and a session ending mid-run left a
// compiler going for the rest of the day. killAll is what the panel calls on
// its way out.
const live = new Set<() => void>();

export function killAll(): void {
  for (const kill of live) kill();
}

export function startCommand(argv: string[], cwd: string, timeoutMs = TIMEOUT_MS): Run {
  let stop: () => void = () => {};
  const done = new Promise<Ran>((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let text = "";
    let timedOut = false;
    let killed = false;
    const collect = (chunk: Buffer): void => {
      text += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const end = (): void => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      end();
      text += `\nsrcy: timed out after ${Math.round(timeoutMs / 1000)}s`;
    }, timeoutMs);
    timer.unref();
    stop = (): void => {
      if (killed) return;
      killed = true;
      end();
    };
    live.add(stop);
    child.on("error", (err) => {
      clearTimeout(timer);
      live.delete(stop);
      resolve({ text: `srcy: could not run ${argv[0]}: ${err.message}`, code: 1, timedOut, killed });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      live.delete(stop);
      resolve({ text, code, timedOut, killed });
    });
  });
  return { done, kill: () => stop() };
}

export async function runCommand(argv: string[], cwd: string, timeoutMs = TIMEOUT_MS): Promise<Ran> {
  return startCommand(argv, cwd, timeoutMs).done;
}

// The last lines of a run, which is all any pane has room for — and the only
// thing there is to show when a failure names no file at all.
export function tailOf(text: string): string {
  return text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-TAIL_LINES)
    .join("\n");
}
