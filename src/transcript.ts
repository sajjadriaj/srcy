import { open, readdir, readFile, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
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
// dash: /home/u/p/.srcy/wt/s1 -> -home-u-p--srcy-wt-s1.
// `home` is a parameter so a fixture can be written where a panel running
// under a scratch HOME will actually look for it. The preview does exactly
// that, and without it the transcript half of the picture — the plan, the
// gauge, the goal — was blank in every frame it has ever produced.
export function projectDir(cwd: string, home = homedir()): string {
  return join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
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

// Record timestamps are ISO strings. Undefined rather than a guess when one
// is missing or unparseable: an elapsed time counted from the wrong epoch is
// worse than no elapsed time.
export function when(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
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
  return usageOf(foldAll(text));
}

// The rest of the transcript: what the agent is doing, and what it plans to do.
//
// These come from the same file as the token counts, and for the same reason.
// srcy no longer drives the agent — the agent is the real binary, running in
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
  type?: unknown;
  timestamp?: unknown;
  message?: { content?: unknown };
}

// Tools that cannot change the working tree. Everything else is treated as
// though it can — including anything unrecognised, an MCP tool, or a
// subagent — because the cost of the two mistakes is not symmetric: a
// baseline that quietly contains half the agent's work hides exactly the
// change the reader opened it to see, while a missing one says so out loud.
const READS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "NotebookRead",
  "ExitPlanMode",
  "AskUserQuestion",
]);

export function writes(tool: string): boolean {
  return !READS.has(tool);
}

// What the reader actually typed, or "" if this user record is machinery.
//
// A tool result is a user record too — that is how the transcript carries
// it — and so are slash-command expansions, hook output and system
// reminders, which arrive wrapped in a tag. None of them is a request, and
// treating one as the turn would move the baseline under the agent's feet.
function userText(content: unknown): string {
  if (typeof content === "string") return spoken(content);
  if (!Array.isArray(content)) return "";
  if (content.some((b) => (b as Block).type === "tool_result")) return "";
  return spoken(
    content
      .filter((b) => (b as Block).type === "text")
      .map((b) => String((b as { text?: unknown }).text ?? ""))
      .join(" "),
  );
}

// Exported so the Codex reader applies the same rule: both agents wrap the
// machinery they inject into a user turn in a tag, and two copies of this
// test would drift apart the first time one of them added a new one.
export function spoken(text: string): string {
  const t = text.trim();
  return t.startsWith("<") ? "" : t;
}

// What the agent is doing right now, for the header line. Null once the
// last tool call has a result — an agent that is thinking, or waiting on
// you, is not running anything.
export interface Activity {
  tool: string;
  target: string;
  // When the call started, from the record's own timestamp. The rail shows
  // how long it has been running, which is the difference between an agent
  // working and an agent wedged — and the one thing a still picture of
  // "running npm test" cannot tell you.
  since?: number;
}

// The request the agent is working on, as the reader typed it.
export interface Turn {
  at: number;
  text: string;
}

export interface State {
  plan: PlanEntry[];
  activity: Activity | null;
  // The newest thing the reader asked for. It is the rail's GOAL line, and
  // the moment a TURN baseline is taken from.
  turn?: Turn;
  // When the agent last started a tool call that could change the tree. A
  // baseline is only honest if nothing like this happened after the request
  // it claims to start from.
  wrote?: number;
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
  return stateOf(foldAll(text));
}

// ---------------------------------------------------------------------------
// One pass, resumable.
//
// Everything the panels read out of a transcript is a fold over its lines:
// the plan is the last TodoWrite, the in-flight call is the tool_use with no
// tool_result after it, the occupancy is the last usage record, and the
// output total is a sum. None of them needs a line twice.
//
// That matters because the file is not this session's — it is every turn the
// reader has taken in this directory, and it reaches megabytes inside a day.
// Re-reading and re-splitting it once a second, in two panel processes, cost
// 53ms a tick and a couple of hundred megabytes of string churn. Folding from
// a byte offset costs the new bytes only.

export interface Fold {
  plan: PlanEntry[];
  open: Map<string, Activity>;
  turn?: Turn;
  wrote?: number;
  output: number;
  last: { used: number; cached: number } | null;
  // Set only by agents that record it. Codex writes the real number with
  // every token count; Claude Code writes none, so there it stays undefined
  // and windowFor infers one.
  window?: number;
}

// What one agent's on-disk session looks like. Two implementations — the
// Claude Code reader below and the Codex one next door — because those are
// the two formats that exist, not because a third is expected.
export interface Source {
  // The session file for work happening in `cwd`, or null if this agent has
  // not written one. Newest wins: it is the session being typed into.
  find: (cwd: string) => Promise<string | null>;
  fold: (f: Fold, line: string) => void;
}

export function emptyFold(): Fold {
  return { plan: [], open: new Map(), output: 0, last: null };
}

export function foldLine(f: Fold, line: string): void {
  // Most lines are neither, and JSON.parse across a transcript this size is
  // the only part of this path anyone could feel.
  const usage = line.includes('"usage"');
  const tools = line.includes('"tool_use"') || line.includes('"tool_result"');
  const spoke = line.includes('"type":"user"');
  if (!usage && !tools && !spoke) return;

  let rec: Line & Entry;
  try {
    rec = JSON.parse(line) as Line & Entry;
  } catch {
    return; // a half-written last line is normal: the agent is still going
  }
  const at = when(rec.timestamp);

  const u = rec.message?.usage;
  if (u !== undefined) {
    // Subagent turns run in their own context and land in the same file.
    // Their tokens are real spend, so they count toward output, but their
    // occupancy is not this window's — letting one set `used` makes the
    // gauge jump to a stranger's context and back.
    f.output += num(u.output_tokens);
    if (rec.isSidechain !== true) {
      const used = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
      if (used > 0) f.last = { used, cached: num(u.cache_read_input_tokens) / used };
    }
  }

  // A subagent's plan is not the plan on screen, and its tool calls are not
  // what the session is doing — showing them makes the rail flicker between
  // two unrelated pieces of work.
  if (rec.isSidechain === true) return;
  const content = rec.message?.content;
  if (rec.type === "user") {
    const text = userText(content);
    if (text !== "" && at !== undefined) f.turn = { at, text };
  }
  if (!Array.isArray(content)) return;
  for (const raw of content) {
    const b = raw as Block & { id?: unknown; tool_use_id?: unknown };
    if (b.type === "tool_use") {
      if (b.name === "TodoWrite") {
        const todos = (b.input as { todos?: unknown } | undefined)?.todos;
        if (Array.isArray(todos)) {
          f.plan = todos
            .map((t) => t as Todo)
            .filter((t): t is Todo & { content: string } => typeof t.content === "string" && t.content !== "")
            .map((t) => ({ content: t.content, status: typeof t.status === "string" ? t.status : "pending" }));
        }
      }
      const name = typeof b.name === "string" ? b.name : "?";
      if (at !== undefined && writes(name)) f.wrote = at;
      if (typeof b.id === "string") {
        f.open.set(b.id, { tool: name, target: targetOf(b.input), since: at });
      }
    } else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
      f.open.delete(b.tool_use_id);
    }
  }
}

export function foldAll(text: string): Fold {
  const f = emptyFold();
  for (const line of text.split("\n")) foldLine(f, line);
  return f;
}

export function stateOf(f: Fold): State {
  // Several calls can be open at once when the agent batches them. The last
  // one started is the one a reader is watching for.
  let activity: Activity | null = null;
  for (const v of f.open.values()) activity = v;
  const s: State = { plan: f.plan, activity };
  if (f.turn !== undefined) s.turn = f.turn;
  if (f.wrote !== undefined) s.wrote = f.wrote;
  return s;
}

export function usageOf(f: Fold): Usage | null {
  if (f.last === null) return null;
  return {
    used: f.last.used,
    size: f.window ?? windowFor(f.last.used),
    output: f.output,
    cached: f.last.cached,
  };
}

// newestTranscript finds the session file for `cwd`. Unlike transcriptUsage,
// there is no `since` filter: srcy now attaches to an agent the reader
// started themselves, possibly before srcy, so "newer than this process" is
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

// A reader that remembers where it stopped. One per path, because a panel
// polls the same transcript for the life of the process.
export interface Reader {
  path: string;
  offset: number;
  // The final line of the last read, which is usually incomplete: the agent
  // is still writing it. Held back and prepended to the next chunk rather
  // than parsed twice or dropped.
  tail: string;
  fold: Fold;
}

export function newReader(path: string): Reader {
  return { path, offset: 0, tail: "", fold: emptyFold() };
}

// advance folds in whatever has been appended since the last call.
//
// Two things reset it: a different transcript (the reader started a new
// session in the same directory) and a file that has shrunk (rotated, or
// replaced). Folding new bytes onto state from a file that no longer exists
// would report a plan and a token count belonging to neither.
export async function advance(r: Reader, path: string, fold = foldLine): Promise<Fold> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return r.fold;
  }
  if (path !== r.path || size < r.offset) {
    r.path = path;
    r.offset = 0;
    r.tail = "";
    r.fold = emptyFold();
  }
  if (size === r.offset) return r.fold;

  let fh: FileHandle | undefined;
  try {
    fh = await open(path, "r");
    const buf = Buffer.allocUnsafe(size - r.offset);
    const { bytesRead } = await fh.read(buf, 0, buf.length, r.offset);
    const lines = (r.tail + buf.toString("utf8", 0, bytesRead)).split("\n");
    // The last element is either an incomplete line or the empty string after
    // a trailing newline. Both are correct to carry forward.
    r.tail = lines.pop() ?? "";
    r.offset += bytesRead;
    for (const line of lines) fold(r.fold, line);
  } catch {
    // Leave the reader where it was; the next tick tries again.
  } finally {
    await fh?.close().catch(() => {});
  }
  return r.fold;
}

// readTranscript gives a panel all three numbers on one tick, folding in only
// what the agent has written since the last one.
const readers = new Map<string, Reader>();

export const CLAUDE: Source = { find: newestTranscript, fold: foldLine };

export async function readSession(
  cwd: string,
  source: Source,
): Promise<(State & { usage: Usage | null }) | null> {
  const path = await source.find(cwd);
  if (path === null) return null;
  const key = `${cwd}\u0000${source.find.name}`;
  let r = readers.get(key);
  if (r === undefined) {
    r = newReader(path);
    readers.set(key, r);
  }
  const fold = await advance(r, path, source.fold);
  return { ...stateOf(fold), usage: usageOf(fold) };
}
