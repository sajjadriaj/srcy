import { spawn } from "node:child_process";
import { access, constants, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

// One compiler or test failure, anchored to a place in the tree. `line` is
// 1-based; 0 means the tool named a file but no line.
export interface Problem {
  path: string; // repo-relative, POSIX separators — same space as the repo map
  line: number;
  message: string;
}

// How long a check may run before it is killed. A check is something the
// human is waiting on between turns, not a CI job.
const TIMEOUT_MS = 120_000;
// Enough of the output to show what happened without pushing the pane off
// the terminal; the full run stays in the user's own project tooling.
const TAIL_LINES = 12;
// A wall of problems is noise — the first few are what get fixed.
const MAX_PROBLEMS = 20;

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
export function parseProblems(output: string, cwd: string): Problem[] {
  const seen = new Set<string>();
  const problems: Problem[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
    const m = PAREN_RE.exec(line) ?? COLON_RE.exec(line) ?? FRAME_RE.exec(line);
    if (!m) continue;
    const path = toRepoRelative(cwd, m[1]!);
    // A location outside the tree (node internals, a dependency's own
    // stack frame) is never something the reviewer can act on here.
    if (path.startsWith("../") || path.startsWith("node_modules/") || path.startsWith("node:")) continue;
    const lineNo = Number(m[2]);
    if (!Number.isFinite(lineNo) || lineNo <= 0) continue;
    const key = `${path}:${lineNo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const message = (m[4] ?? "").trim();
    problems.push({ path, line: lineNo, message: message === "" ? line.trim() : message });
    if (problems.length >= MAX_PROBLEMS) break;
  }
  return problems;
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
}

export async function runCommand(argv: string[], cwd: string, timeoutMs = TIMEOUT_MS): Promise<Ran> {
  return new Promise<Ran>((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let text = "";
    let timedOut = false;
    const collect = (chunk: Buffer): void => {
      text += chunk.toString();
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        // already gone
      }
      text += `\nsrcy: timed out after ${Math.round(timeoutMs / 1000)}s`;
    }, timeoutMs);
    timer.unref();
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ text: `srcy: could not run ${argv[0]}: ${err.message}`, code: 1, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ text, code, timedOut });
    });
  });
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
