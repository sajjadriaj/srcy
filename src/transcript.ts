import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PlanEntry, Usage } from "./cockpit.js";

// ACP's usage_update carries three numbers — used, size, cost — and the
// default adapter (@zed-industries/claude-code-acp) never sends it at all:
// it receives the agent SDK's `result` message, which does carry the token
// counts, and returns only a stop reason. So the gauge this feeds is blank
// for the whole session unless we read the numbers from somewhere else.
//
// Claude Code writes them to disk itself, per session, as it goes. That file
// is the only place a client can see an input/output split at all — the
// protocol has no field for one.

// Claude Code names a session's transcript directory after the working
// directory it ran in, with every non-alphanumeric character replaced by a
// dash: /home/u/p/.ctui/wt/s1 -> -home-u-p--ctui-wt-s1.
export function projectDir(cwd: string): string {
  return join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

// The transcript never records how big the context window is, and the model
// string does not distinguish a 1M-context session from a 200k one. 200k is
// every current Claude model's default, and a session that has already
// passed it is its own proof of the larger window — which is the only
// evidence available. Guessing 200k unconditionally would paint a 1M session
// as permanently full, which is the one reading that changes what a user
// does next.
// ponytail: two buckets. If a third window size ships, read it from wherever
// the CLI starts recording it rather than growing a model table here.
function windowFor(used: number): number {
  return used > 200_000 ? 1_000_000 : 200_000;
}

// mtime is compared with slack because the two clocks are not the same one:
// file timestamps come from the kernel's coarse clock, which can sit a few
// milliseconds behind Date.now(), so a transcript created moments after this
// run started can carry an mtime just before it. What this filter exists to
// exclude is an earlier session, which is minutes or hours old — seconds of
// slack costs nothing there and removes a race that silently blanks the gauge.
const STALE_SLACK_MS = 5_000;

interface Line {
  isSidechain?: boolean;
  message?: { usage?: Record<string, unknown> };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// parseUsage reads a Claude Code transcript into the numbers the gauge shows.
//
// A record's usage describes one API request: `input_tokens` and
// `cache_creation_input_tokens` are what was re-sent uncached, and
// `cache_read_input_tokens` is what came from cache. Their sum is how full
// the window was for that request, so the last record is the current
// occupancy — not a running total, which would climb past the window size
// within a few turns.
export function parseUsage(text: string): Usage | null {
  let output = 0;
  let last: { used: number; cached: number } | null = null;
  for (const line of text.split("\n")) {
    // Most lines are user turns and tool results. JSON.parse across a
    // multi-megabyte transcript is the only part of this path anyone could
    // feel, so it runs on the lines that can possibly matter.
    if (!line.includes('"usage"')) continue;
    let rec: Line;
    try {
      rec = JSON.parse(line) as Line;
    } catch {
      continue; // a half-written last line is normal: the agent is still going
    }
    const u = rec.message?.usage;
    if (u === undefined) continue;

    // Subagent turns run in their own context and land in the same file.
    // Their tokens are real spend, so they count toward output, but their
    // occupancy is not this window's — letting one set `used` makes the
    // gauge jump to a stranger's context and back.
    output += num(u.output_tokens);
    if (rec.isSidechain === true) continue;

    const used = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
    if (used > 0) last = { used, cached: num(u.cache_read_input_tokens) / used };
  }
  if (last === null) return null;
  return { used: last.used, size: windowFor(last.used), output, cached: last.cached };
}

// transcriptUsage finds the transcript for a session running in `cwd` and
// reads its current totals. `since` is when this ctui run started: an older
// transcript in the same directory belongs to some earlier session, and
// reporting its totals would put a number on screen about work the reader
// never started.
//
// Returns null for every failure — no directory, no transcript, unreadable
// file — because the gauge's null state already means "not measured", and
// that is the honest answer in all of those cases.
// ponytail: re-reads the whole file each turn. A ctui session gets a fresh
// transcript, so it stays small; track a byte offset if a long session ever
// makes this show up.
export async function transcriptUsage(cwd: string, since: number, dir = projectDir(cwd)): Promise<Usage | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  let newest: { path: string; at: number } | null = null;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    try {
      const at = (await stat(path)).mtimeMs;
      if (at < since - STALE_SLACK_MS) continue;
      if (newest === null || at > newest.at) newest = { path, at };
    } catch {
      continue;
    }
  }
  if (newest === null) return null;
  try {
    return parseUsage(await readFile(newest.path, "utf8"));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The rest of the transcript: what the agent is doing, and what it plans to do.
//
// These come from the same file as the token counts, and for the same reason.
// ctui no longer drives the agent — the agent is the real binary, running in
// its own pane, with its own slash commands and keybinds intact — so there is
// no protocol to listen to. What the panels know, they know by watching the
// repo and reading this file.

// A todo list as Claude Code records it. The shape is TodoWrite's input,
// which is also PlanEntry's shape, so the existing PlanBar renders it as-is.
interface Todo {
  content?: unknown;
  status?: unknown;
}

interface Block {
  type?: unknown;
  name?: unknown;
  input?: unknown;
}

interface Entry {
  isSidechain?: boolean;
  message?: { content?: unknown };
}

// What the agent is doing right now, for the header line. Null once the
// last tool call has a result — an agent that is thinking, or waiting on
// you, is not running anything.
export interface Activity {
  tool: string;
  target: string;
}

export interface State {
  plan: PlanEntry[];
  activity: Activity | null;
}

// The subset of an Edit/Write/Read/Bash input worth putting in a one-line
// status: the file it names, or the command it runs.
function targetOf(input: unknown): string {
  const o = input as Record<string, unknown> | undefined;
  // `description` first because only Bash carries one, and it is a sentence
  // a person wrote about what the command is for — strictly better in a
  // border than the head of a shell pipeline.
  for (const key of ["description", "file_path", "path", "command", "pattern", "notebook_path"]) {
    const v = o?.[key];
    if (typeof v === "string" && v !== "") return v;
  }
  return "";
}

// parseState pulls the plan and the in-flight tool call out of a transcript.
//
// A tool call is in flight when no later record carries its tool_result. That
// is the whole liveness signal available from a file: the agent writes the
// call when it starts and the result when it finishes, so an id with no
// result is a call still running.
export function parseState(text: string): State {
  let plan: PlanEntry[] = [];
  const open = new Map<string, Activity>();
  for (const line of text.split("\n")) {
    // Cheap pre-filter, as in parseUsage: most lines carry neither.
    if (!line.includes('"tool_use"') && !line.includes('"tool_result"')) continue;
    let rec: Entry;
    try {
      rec = JSON.parse(line) as Entry;
    } catch {
      continue; // a half-written last line is normal: the agent is still going
    }
    // A subagent's plan is not the plan on screen, and its tool calls are not
    // what the session is doing — showing them makes the rail flicker between
    // two unrelated pieces of work.
    if (rec.isSidechain === true) continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const raw of content) {
      const b = raw as Block & { id?: unknown; tool_use_id?: unknown };
      if (b.type === "tool_use") {
        if (b.name === "TodoWrite") {
          const todos = (b.input as { todos?: unknown } | undefined)?.todos;
          if (Array.isArray(todos)) {
            plan = todos
              .map((t) => t as Todo)
              .filter((t): t is Todo & { content: string } => typeof t.content === "string" && t.content !== "")
              .map((t) => ({ content: t.content, status: typeof t.status === "string" ? t.status : "pending" }));
          }
        }
        if (typeof b.id === "string") {
          open.set(b.id, { tool: typeof b.name === "string" ? b.name : "?", target: targetOf(b.input) });
        }
      } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
        open.delete(b.tool_use_id);
      }
    }
  }
  // Several can be open at once when the agent batches calls. The last one
  // started is the one a reader is watching for.
  let activity: Activity | null = null;
  for (const v of open.values()) activity = v;
  return { plan, activity };
}

// newestTranscript finds the session file for `cwd`. Unlike transcriptUsage,
// there is no `since` filter: ctui now attaches to an agent the reader
// started themselves, possibly before ctui, so "newer than this process" is
// the wrong test. Newest-modified is the session being typed into.
export async function newestTranscript(cwd: string, dir = projectDir(cwd)): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  let newest: { path: string; at: number } | null = null;
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    try {
      const at = (await stat(path)).mtimeMs;
      if (newest === null || at > newest.at) newest = { path, at };
    } catch {
      continue;
    }
  }
  return newest?.path ?? null;
}

// readTranscript does both parses in one read. The panels want all three
// numbers on the same tick, and reading the file twice per second to get
// them separately is the kind of thing that shows up in a profile later.
//
// ponytail: re-reads the whole file each poll. Fine for a session's own
// transcript; track a byte offset if a day-long session ever drags.
export async function readTranscript(cwd: string): Promise<(State & { usage: Usage | null }) | null> {
  const path = await newestTranscript(cwd);
  if (path === null) return null;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  return { ...parseState(text), usage: parseUsage(text) };
}
