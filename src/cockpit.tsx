import React from "react";
import { Box, Text } from "ink";
import type { Problem } from "./checks.js";
import type { FileDiff } from "./diff.js";

// The two things a file can be to a session: changed against the base
// commit, or merely opened. There is deliberately no "untouched" state —
// the map shows what this session actually did, not the whole repo, so an
// untouched file is an absent row rather than a dimmer one.
export type Touch = "wrote" | "read";

export interface MapEntry {
  path: string; // repo-relative, POSIX separators (as git and ACP both give)
  touch: Touch;
  added: number;
  removed: number;
  problems: number; // failing check locations in this file
}

export interface PlanEntry {
  content: string;
  status: string; // ACP: "pending" | "in_progress" | "completed"
}

// diffStats counts one file's changed lines. Hunk bodies only ever carry
// ' ', '+', '-' and '\' prefixes — the "+++"/"---" header lines live in
// FileDiff.header, never in a body — so a first-character test is enough
// and cannot mistake a header for a changed line.
export function hunkStats(body: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of body.split("\n")) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

export function diffStats(f: FileDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of f.hunks) {
    const stats = hunkStats(hunk.body);
    added += stats.added;
    removed += stats.removed;
  }
  return { added, removed };
}

// mapEntries merges what the agent read with what it actually changed. The
// worktree diff is the authority for "wrote": a file the agent edited and
// then reverted has no diff section, so it correctly falls back to "read"
// rather than claiming a change that no longer exists.
export function mapEntries(
  diffFiles: FileDiff[],
  readPaths: Iterable<string>,
  problems: Problem[] = [],
): MapEntry[] {
  const byPath = new Map<string, MapEntry>();
  for (const path of readPaths) {
    byPath.set(path, { path, touch: "read", added: 0, removed: 0, problems: 0 });
  }
  for (const f of diffFiles) {
    const { added, removed } = diffStats(f);
    byPath.set(f.path, { path: f.path, touch: "wrote", added, removed, problems: 0 });
  }
  // A check can fail in a file this session never touched — a caller that
  // no longer compiles against a changed signature is exactly the failure
  // worth seeing, so it earns a row of its own rather than being dropped.
  for (const problem of problems) {
    const existing = byPath.get(problem.path);
    if (existing) existing.problems++;
    else byPath.set(problem.path, { path: problem.path, touch: "read", added: 0, removed: 0, problems: 1 });
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}




const MARK: Record<Touch, string> = { wrote: "▪", read: "▫" };

// Column the +/- counts line up in, measured from the start of the name.
const NAME_WIDTH = 17;



interface DiffLine {
  num: string;
  sign: string;
  text: string;
}

// hunkLines numbers a hunk the way a reader needs it: the new-side line
// number, shown against removed lines too so a replacement reads as one
// line changing rather than two unrelated ones. Only lines that exist on
// the new side advance the counter, and "\ No newline at end of file" is
// not a line of the file at all, so it gets neither.
export function hunkLines(body: string, newStart: number): DiffLine[] {
  const out: DiffLine[] = [];
  let n = newStart;
  for (const line of body.split("\n")) {
    if (line === "") continue;
    const sign = line[0]!;
    if (sign === "\\") {
      out.push({ num: "", sign: " ", text: line });
      continue;
    }
    out.push({ num: String(n), sign, text: line.slice(1) });
    if (sign !== "-") n++;
  }
  return out;
}

// PlanBar renders the agent's own plan as a live checklist. ACP sends the
// whole plan on every update, so this always reflects the current one
// rather than accumulating stale entries.
export function PlanBar({ entries }: { entries: PlanEntry[] }): React.JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <Box flexDirection="column">
      <Text dimColor>PLAN</Text>
      {entries.map((entry, i) => {
        const done = entry.status === "completed";
        const active = entry.status === "in_progress";
        const color = active ? "cyan" : undefined;
        // Marker and text are separate columns so a step too long for the
        // pane wraps under its own text rather than back to column zero,
        // where the continuation would read as another step.
        return (
          <Box key={i}>
            <Text dimColor={done} color={color}>{`  ${done ? "✔" : active ? "▸" : "☐"} `}</Text>
            <Box>
              <Text dimColor={done} color={color}>
                {entry.content}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

// planFrom reads a "plan" session update defensively: it is the one update
// whose payload we consume raw rather than through AgentUpdate's own
// fields, and an adapter that sends a shape we don't expect must degrade to
// "no plan", never throw inside the bridge listener.
export function planFrom(raw: unknown): PlanEntry[] {
  const entries = (raw as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return [];
  const out: PlanEntry[] = [];
  for (const item of entries) {
    const content = (item as { content?: unknown })?.content;
    if (typeof content !== "string" || content === "") continue;
    const status = (item as { status?: unknown })?.status;
    out.push({ content, status: typeof status === "string" ? status : "pending" });
  }
  return out;
}


// The name shown for hunks git could not attribute to any enclosing
// function — imports, module constants, a header comment.
export const TOP_LEVEL = "(top level)";


// Braille, not the eighth-blocks ramp: every braille pattern is Neutral
// (see MARK) where ▁▂▃…█ are Ambiguous, and mixing a Neutral empty bucket
// with Ambiguous filled ones tears the bar the same way it tore the gauge.
// Four levels instead of eight — the bar answers "where are the edits",
// which four buckets of height say as well as eight.
const BLOCKS = " ⣀⣤⣶⣿";



// Column the outline's counts line up in, as NAME_WIDTH does for the map.
const OUTLINE_WIDTH = 34;


// A tool that takes this long is worth noticing on the way past. Anything
// under it renders dim; anything over it renders plain, so scanning the
// transcript answers "where did the two minutes go" without reading it.
export const SLOW_MS = 10_000;


const GAUGE_WIDTH = 16;

// Filled and empty segment. Both Neutral, for the reason MARK explains —
// mixing █ (Ambiguous) with ░ (Neutral) makes the bar change length as it
// fills, which would slide the percentage beside it sideways.
const FULL = "▮";
const EMPTY = "▯";

// gauge is a plain fill bar: how much of the context window is spoken for.
// Deliberately not the BLOCKS ramp densityBar uses — that one encodes
// "how much" per column, this one encodes "how far along", and reusing the
// glyphs would make two different quantities look like the same thing.
export function gauge(used: number, size: number, width = GAUGE_WIDTH): string {
  // A caller with no room left asks for zero cells, and the fill below would
  // round up to one and then repeat the remainder -1 times, which throws.
  if (size <= 0 || width <= 0) return "";
  const frac = Math.min(1, Math.max(0, used / size));
  // A window with anything in it never reads as empty, and one with room
  // left never reads as full — the two states the reader acts on.
  let filled = Math.round(frac * width);
  if (used > 0 && filled === 0) filled = 1;
  if (frac < 1 && filled === width) filled = width - 1;
  return FULL.repeat(filled) + EMPTY.repeat(width - filled);
}

// tokens abbreviates a count to the precision anyone actually reads.
export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}


export interface Usage {
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
  // Only the local transcript can supply these two: ACP's usage_update has
  // no field for either, so they are absent whenever the numbers came from
  // the agent. output is everything the agent has written this session;
  // cached is the share of the last request that was served from cache,
  // which is what says whether a session is re-sending the world each turn.
  output?: number;
  cached?: number;
}


