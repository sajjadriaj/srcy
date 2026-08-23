import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Usage } from "./cockpit.js";

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
