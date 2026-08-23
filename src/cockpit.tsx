import React from "react";
import { Box, Text } from "ink";
import type { CheckResult, Problem } from "./checks.js";
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

export interface TreeRow {
  depth: number;
  name: string;
  dir: boolean;
  entry?: MapEntry; // set on file rows only
}

// buildTree turns a sorted list of paths into indented rows, emitting each
// directory once. "Same segment as the row above" is what collapses
// repeated directories, and that test only holds on sorted input —
// mapEntries sorts, and callers must not reorder afterwards.
export function buildTree(entries: MapEntry[]): TreeRow[] {
  const rows: TreeRow[] = [];
  let prev: string[] = [];
  for (const entry of entries) {
    const parts = entry.path.split("/");
    const dirs = parts.slice(0, -1);
    for (let i = 0; i < dirs.length; i++) {
      if (prev[i] === dirs[i]) continue;
      rows.push({ depth: i, name: `${dirs[i]!}/`, dir: true });
    }
    rows.push({ depth: dirs.length, name: parts[parts.length - 1]!, dir: false, entry });
    prev = dirs;
  }
  return rows;
}

// Every glyph this file prints is East-Asian *Neutral*, which is one cell
// in every terminal. The obvious markers — ● ○ ▶ █ — are Ambiguous: a
// terminal set to ambiguous-width=double renders them two cells wide, and
// since ✖ is Neutral, one failing row would then sit a column off from
// every other row inside a fixed-width box. Check any replacement with
// `unicodedata.east_asian_width` before using it.
// PaneLabel is how a pane says whether it has the keyboard. Both panes use
// it so the two can never disagree about what focus looks like, and the
// marker sits after the name rather than before it: a prefix would shift
// the label sideways as focus moved, which is the reflow the caret column
// was built to avoid.
export function PaneLabel({ name, focused }: { name: string; focused: boolean }): React.JSX.Element {
  return focused ? <Text color="cyan">{`${name} ▸`}</Text> : <Text dimColor>{name}</Text>;
}

const MARK: Record<Touch, string> = { wrote: "▪", read: "▫" };

// Column the +/- counts line up in, measured from the start of the name.
const NAME_WIDTH = 17;

// RepoMap is the left column: where in the tree this session has been
// working, and how much of each file it changed. The marker sits in its own
// gutter so nesting stays readable no matter how deep the path goes.
// `cursor` indexes `entries` — file rows appear in that same order, since
// buildTree only interleaves directory headers between them. -1 means the
// pane is not focused. The caret sits in a column that is a blank space
// otherwise, so focusing never reflows the rows beside it.
export function RepoMap({
  entries,
  cursor = -1,
  width,
  maxRows,
}: {
  entries: MapEntry[];
  cursor?: number;
  // Clip rows to this many columns. Unset means don't clip, which is right
  // for the wide cockpit. In a narrow rail a row that overflows wraps to
  // column zero and shifts every row under it, so there the path gets cut
  // and the counts stay: which file it is, is already half-answered by the
  // directory header above it.
  width?: number;
  // Total lines this pane may occupy, label and legend included. The file
  // list is the elastic part of a rail — the plan, the failures and the
  // context gauge each have a fixed job, and a list long enough to push
  // them off the bottom has traded the answer for the inventory.
  maxRows?: number;
}): React.JSX.Element {
  const clip = (s: string): string => (width === undefined || s.length <= width ? s : `${s.slice(0, width - 1)}…`);
  const tree = buildTree(entries);
  // Three lines are spoken for: the label, the legend, and the "…and N more"
  // this truncation itself needs.
  const room = maxRows === undefined ? tree.length : Math.max(0, maxRows - 3);
  // A truncated tree spends its few rows on directory headers and hides the
  // files under them — the nesting is what got cut, so the rows that survive
  // name no file at all. Below the fit, drop the nesting instead and give
  // every row to a file, worst first: broken before merely large.
  const flat = room < tree.length;
  const rows: TreeRow[] = flat
    ? [...entries]
        .sort((a, b) => b.problems - a.problems || b.added + b.removed - (a.added + a.removed))
        .slice(0, room)
        .map((entry) => ({ name: entry.path, depth: 0, dir: false, entry }))
    : tree;
  const hidden = entries.length - rows.filter((r) => !r.dir).length;
  let fileIndex = -1;
  return (
    <Box flexDirection="column">
      <PaneLabel name="REPO" focused={cursor >= 0} />
      {rows.length === 0 ? (
        <Text dimColor>{"   (nothing touched yet)"}</Text>
      ) : (
        rows.map((row, i) => {
          const indent = "  ".repeat(row.depth);
          if (row.dir) {
            return (
              <Text key={i} dimColor>{clip(`   ${indent}${row.name}`)}</Text>
            );
          }
          fileIndex++;
          const at = fileIndex === cursor;
          const caret = at ? "►" : " ";
          const entry = row.entry!;
          // Counts share a column so the eye can compare sizes down the
          // list; a name long enough to overflow it pushes its own counts
          // right rather than being truncated, since the path is what
          // identifies the file.
          const label = `${indent}${row.name}`;
          // A failing file spends its count column on the failures rather
          // than the churn: "this one is broken in two places" is what the
          // reader does something about, and "+1 -1" is not. It also makes
          // the pane below a detail view of this number instead of a second
          // copy of it.
          const stat =
            entry.problems > 0
              ? `${label.padEnd(NAME_WIDTH)} ✖${entry.problems}`
              : entry.touch === "wrote"
                ? `${label.padEnd(NAME_WIDTH)} +${entry.added} -${entry.removed}`
                : label;
          // A file with failing checks reads as broken first and changed
          // second: the marker and the whole row go red, because "this one
          // does not compile" outranks "this one grew by 12 lines".
          if (entry.problems > 0) {
            return (
              <Text key={i} color="red" inverse={at}>
                {clip(`✖${caret} ${stat}`)}
              </Text>
            );
          }
          return (
            <Text
              key={i}
              color={entry.touch === "wrote" ? "green" : undefined}
              dimColor={entry.touch === "read" && !at}
              inverse={at}
            >
              {clip(`${MARK[entry.touch]}${caret} ${stat}`)}
            </Text>
          );
        })
      )}
      {/* A legend for markers that aren't on screen teaches the reader to
          look for something that isn't there — "✖ failing" while nothing is
          failing reads as a warning. */}
      {hidden > 0 ? <Text dimColor>{clip(`  …and ${hidden} more`)}</Text> : null}
      <Text dimColor>{clip(legend(entries))}</Text>
    </Box>
  );
}

function legend(entries: MapEntry[]): string {
  const parts: string[] = [];
  if (entries.some((e) => e.touch === "wrote")) parts.push("▪ wrote");
  if (entries.some((e) => e.touch === "read")) parts.push("▫ read");
  if (entries.some((e) => e.problems > 0)) parts.push("✖ failing");
  return parts.join("  ");
}

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

// LiveDiff is the right column's lower half: the file the agent is editing
// right now, changing as it edits. Showing the tail (not the head) keeps
// the most recent edit on screen, which is the one being explained.
export function LiveDiff({ file, maxLines = 12 }: { file?: FileDiff; maxLines?: number }): React.JSX.Element {
  if (!file) {
    return <Text dimColor>(no changes yet)</Text>;
  }
  if (file.binary) {
    return <Text dimColor>{`${file.path} — binary`}</Text>;
  }
  const hunk = file.hunks[file.hunks.length - 1];
  if (!hunk) {
    return <Text dimColor>{`${file.path} — metadata only`}</Text>;
  }
  const lines = hunkLines(hunk.body, hunk.newStart).slice(-maxLines);
  // The heading names the first line actually on screen, not the hunk's
  // start: with a hunk longer than the pane, slicing the tail leaves a
  // heading pointing a hundred lines above anything the reader can see.
  const first = lines.find((l) => l.num.trim() !== "")?.num.trim() ?? String(hunk.newStart);
  return (
    <Box flexDirection="column">
      <Text dimColor>{`${file.path}:${first}`}</Text>
      {lines.map((line, i) => (
        <Text key={i} color={line.sign === "+" ? "green" : line.sign === "-" ? "red" : undefined}>
          {`${line.num.padStart(4)} ${line.sign} ${line.text}`}
        </Text>
      ))}
    </Box>
  );
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

// How many failing locations the pane lists before summarising the rest.
const PROBLEMS_SHOWN = 4;

// ChecksPane is the red-squiggle line: does the code the agent just wrote
// still build, and still pass. Four states, each of which has to look
// different from the others — "not checked" reading like "passed" is the
// one failure that would make the pane worse than not having it.
export function ChecksPane({
  result,
  running,
  focus,
}: {
  result: CheckResult | null | undefined;
  running: boolean;
  // The path the repo map's cursor is on, when the map has the keyboard.
  focus?: string;
}): React.JSX.Element | null {
  if (running) {
    return <Text dimColor>{"CHECKS  running…"}</Text>;
  }
  // Undefined is "we have not looked yet" — distinct from null, which is
  // "we looked and there is nothing to run". Claiming a project has no
  // checker before ever asking is the same class of lie as showing a pass.
  if (result === undefined) return null;
  if (result === null) {
    // Deliberately not silent: a project with no check configured should
    // learn that it could have one, exactly when it would have mattered.
    return <Text dimColor>{"CHECKS  none configured — add an executable .ctui/check"}</Text>;
  }
  if (result.ok) {
    return <Text color="green">{`CHECKS  ${result.command}  ✔ passing`}</Text>;
  }
  // Walking the cursor onto a failing file turns this pane into that file's
  // failures — all of them, since there is only one file's worth. It is also
  // the way out of "…and N more": the truncated list below is capped, and
  // moving the cursor is how a reader reaches what it cut.
  const scoped = focus === undefined ? [] : result.problems.filter((p) => p.path === focus);
  if (scoped.length > 0) {
    return (
      <Box flexDirection="column">
        <Text color="red">{`CHECKS  ${focus}  ✖ ${scoped.length}`}</Text>
        {scoped.map((problem, i) => (
          <Text key={i} color="red">
            {`  ✖ line ${problem.line}  ${problem.message}`}
          </Text>
        ))}
      </Box>
    );
  }
  const shown = result.problems.slice(0, PROBLEMS_SHOWN);
  const rest = result.problems.length - shown.length;
  return (
    <Box flexDirection="column">
      <Text color="red">{`CHECKS  ${result.command}  ✖ failing`}</Text>
      {shown.map((problem, i) => (
        <Text key={i} color="red">
          {`  ✖ ${problem.path}:${problem.line}  ${problem.message}`}
        </Text>
      ))}
      {rest > 0 && <Text dimColor>{`  …and ${rest} more`}</Text>}
      {/* With no parsed location the output is all there is to go on, so
          the pane shows it rather than an empty failing header. */}
      {result.problems.length === 0 && result.tail !== "" && <Text dimColor>{indent(result.tail)}</Text>}
    </Box>
  );
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
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
  if (size <= 0) return "";
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

// Above 80% of the window, a compaction is close enough that it changes what
// a reader should do next — finish the thought, or start a fresh session.
const CONTEXT_WARN = 0.8;

