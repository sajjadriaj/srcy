import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { remember, spoken, when, type Fold, type Source } from "./transcript.js";

// Reading Codex's session log.
//
// Codex records more than Claude Code does, and better. Every token count
// carries the model's real context window, so the gauge does not have to
// infer one; and the session's own header names the directory it is working
// in, so finding the right file is a lookup rather than a guess.
//
// What it does not reliably record is a plan. `update_plan` exists as a tool
// and is folded in below, but no session on this machine has ever called it,
// so that path is written from the tool's shape and has never run against
// real data — unlike the token path, which is checked against a real log.

const SESSIONS = join(homedir(), ".codex", "sessions");

interface Payload {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  name?: unknown;
  call_id?: unknown;
  input?: unknown;
  arguments?: unknown;
  cwd?: unknown;
  model?: unknown;
  info?: {
    last_token_usage?: Record<string, unknown>;
    total_token_usage?: Record<string, unknown>;
    model_context_window?: unknown;
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Sessions are filed by date — sessions/YYYY/MM/DD/rollout-*.jsonl — but the
// nesting is walked rather than counted. Counting it is how the first version
// of this looked one level short of the files and found nothing at all, and a
// layout that gains a level should cost a slower scan, not a blank rail.
const MAX_DEPTH = 6;

async function allSessions(root = SESSIONS, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  let names: string[];
  try {
    names = await readdir(root, { withFileTypes: true }).then((es) => es.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)));
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    if (name.endsWith("/")) {
      out.push(...(await allSessions(join(root, name.slice(0, -1)), depth + 1)));
    } else if (name.endsWith(".jsonl")) {
      out.push(join(root, name));
    }
  }
  return out;
}

// The working directory is in the session's first record, so identifying a
// session costs one line rather than a whole file. Newest first, stopping at
// the first match: the session being typed into is the one most recently
// written, and a machine with years of logs should not read all of them to
// learn that.
//
// Only the first record is read, and only its first few kilobytes: reading
// whole files to see line one meant a hundred megabytes a poll on a machine
// with a hundred sessions, which is worse than the cost this lookup exists
// to avoid.
//
// ponytail: re-scans the directory each poll — a readdir plus a stat per
// file, stopping at the first match. Cache on the newest mtime if a machine
// with tens of thousands of sessions ever makes this show up.
// The session header is the first line, and headers are small. This caps the
// read so one enormous session cannot make identifying it expensive.
const HEAD_BYTES = 64 * 1024;

async function firstLine(path: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(path, "r");
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    const text = buf.toString("utf8", 0, bytesRead);
    const nl = text.indexOf("\n");
    // No newline in the whole window means the first record is bigger than
    // the cap, which no session header is; treat it as unidentifiable.
    return nl === -1 ? null : text.slice(0, nl);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

export async function findSession(cwd: string, root = SESSIONS): Promise<string | null> {
  const paths = await allSessions(root);
  const dated: { path: string; at: number }[] = [];
  for (const path of paths) {
    try {
      dated.push({ path, at: (await stat(path)).mtimeMs });
    } catch {
      continue;
    }
  }
  dated.sort((a, b) => b.at - a.at);
  // Exact first, then anything running below it. An agent started in a
  // package of a monorepo, or in a worktree checked out under the root, is
  // working on this repo -- git is repo-wide either way -- and srcy finding
  // nothing there means a blank PLAN, GOAL and gauge with no word about why.
  let below: string | null = null;
  for (const { path } of dated) {
    const head = await firstLine(path);
    if (head === null) continue;
    try {
      const rec = JSON.parse(head) as { payload?: Payload };
      const at = rec.payload?.cwd;
      if (at === cwd) return path;
      if (below === null && typeof at === "string" && at.startsWith(`${cwd}/`)) below = path;
    } catch {
      continue;
    }
  }
  return below;
}

// The subset of a call's arguments worth a one-line status.
function targetOf(payload: Payload): string {
  const raw = typeof payload.input === "string" ? payload.input : payload.arguments;
  if (typeof raw !== "string") return "";
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    for (const key of ["description", "command", "file_path", "path", "cmd", "task_name"]) {
      const v = o[key];
      if (typeof v === "string" && v !== "") return v;
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) return (v as string[]).join(" ");
    }
  } catch {
    // Not JSON — `custom_tool_call.input` is raw source for the exec tool.
  }
  return raw.slice(0, 80);
}

// Codex's read-only tools. As with Claude Code, anything unrecognised is
// assumed to write: `shell` and `apply_patch` are the two that do, and a
// custom tool nobody here has heard of is not evidence of anything.
const READS = new Set(["update_plan", "view_image"]);

export function foldLine(f: Fold, line: string): void {
  if (
    !line.includes('"token_count"') &&
    !line.includes('"call_id"') &&
    !line.includes('"role":"user"') &&
    !line.includes('"turn_context"')
  ) {
    return;
  }
  let p: Payload;
  let at: number | undefined;
  let kind: unknown;
  try {
    const rec = JSON.parse(line) as { type?: unknown; payload?: Payload; timestamp?: unknown };
    p = (rec.payload ?? {}) as Payload;
    at = when(rec.timestamp);
    kind = rec.type;
  } catch {
    return; // a half-written last line is normal: the agent is still going
  }

  // Codex opens every turn with its context, and the model is in it. Unlike
  // Claude Code it also records the window, so this is not load-bearing for
  // the gauge's arithmetic — it is what puts a name next to the number.
  if (at !== undefined && at > (f.at ?? 0)) f.at = at;

  if (kind === "turn_context") {
    if (typeof p.model === "string" && p.model !== "") f.model = p.model;
    return;
  }

  if (p.type === "token_count" && p.info) {
    // `total_token_usage` is cumulative — it reaches twenty million against a
    // 258k window — so occupancy comes from the last request, exactly as it
    // does for Claude Code. The total is still the right source for output,
    // which really is a running sum.
    const last = p.info.last_token_usage ?? {};
    const used = num(last.input_tokens);
    if (used > 0) f.last = { used, cached: num(last.cached_input_tokens) / used };
    f.output = num((p.info.total_token_usage ?? {}).output_tokens);
    // Recorded rather than inferred: no other agent tells us this.
    const window = num(p.info.model_context_window);
    if (window > 0) f.window = window;
    return;
  }

  // What the reader asked for. Codex opens every session by injecting the
  // environment as a user message, and `spoken` is what tells the two apart.
  if (p.type === "message" && p.role === "user") {
    const text = Array.isArray(p.content)
      ? spoken(
          p.content
            .map((b) => String((b as { text?: unknown }).text ?? ""))
            .join(" "),
        )
      : "";
    if (text !== "" && at !== undefined) f.turn = { at, text };
    return;
  }

  const id = typeof p.call_id === "string" ? p.call_id : undefined;
  if (id === undefined) return;
  if (p.type === "function_call" || p.type === "custom_tool_call") {
    if (p.name === "update_plan") {
      const raw = typeof p.arguments === "string" ? p.arguments : p.input;
      if (typeof raw === "string") {
        try {
          const steps = (JSON.parse(raw) as { plan?: unknown }).plan;
          if (Array.isArray(steps)) {
            f.plan = steps
              .map((s) => s as { step?: unknown; status?: unknown })
              .filter((s): s is { step: string; status?: unknown } => typeof s.step === "string" && s.step !== "")
              .map((s) => ({ content: s.step, status: typeof s.status === "string" ? s.status : "pending" }));
          }
        } catch {
          // leave the plan as it was
        }
      }
    }
    const name = typeof p.name === "string" ? p.name : "?";
    // Codex's shell takes an argv, where Claude Code's Bash takes a line.
    // Joined, so both sides of this comparison are the same kind of string.
    if (name === "shell" && at !== undefined) {
      const raw = typeof p.arguments === "string" ? p.arguments : "";
      try {
        const argv = (JSON.parse(raw) as { command?: unknown }).command;
        if (Array.isArray(argv) && argv.every((w) => typeof w === "string")) {
          const cmd = (argv as string[]).join(" ");
          if (cmd !== "") remember(f.ran, cmd, at);
        }
      } catch {
        // not JSON we can read; the call still counts as a write below
      }
    }
    if (at !== undefined && !READS.has(name)) f.wrote = at;
    f.open.set(id, { tool: name, target: targetOf(p), since: at });
  } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
    f.open.delete(id);
  }
}

export const CODEX: Source = { find: findSession, fold: foldLine };
