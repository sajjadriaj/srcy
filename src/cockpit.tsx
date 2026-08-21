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
export function diffStats(f: FileDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of f.hunks) {
    for (const line of hunk.body.split("\n")) {
      if (line.startsWith("+")) added++;
      else if (line.startsWith("-")) removed++;
    }
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

const MARK: Record<Touch, string> = { wrote: "●", read: "○" };

// Column the +/- counts line up in, measured from the start of the name.
const NAME_WIDTH = 17;

// RepoMap is the left column: where in the tree this session has been
// working, and how much of each file it changed. The marker sits in its own
// gutter so nesting stays readable no matter how deep the path goes.
export function RepoMap({ entries }: { entries: MapEntry[] }): React.JSX.Element {
  const rows = buildTree(entries);
  return (
    <Box flexDirection="column">
      <Text dimColor>REPO</Text>
      {rows.length === 0 ? (
        <Text dimColor>{"   (nothing touched yet)"}</Text>
      ) : (
        rows.map((row, i) => {
          const indent = "  ".repeat(row.depth);
          if (row.dir) {
            return (
              <Text key={i} dimColor>{`   ${indent}${row.name}`}</Text>
            );
          }
          const entry = row.entry!;
          // Counts share a column so the eye can compare sizes down the
          // list; a name long enough to overflow it pushes its own counts
          // right rather than being truncated, since the path is what
          // identifies the file.
          const label = `${indent}${row.name}`;
          const stat = entry.touch === "wrote" ? `${label.padEnd(NAME_WIDTH)} +${entry.added} -${entry.removed}` : label;
          // A file with failing checks reads as broken first and changed
          // second: the marker and the whole row go red, because "this one
          // does not compile" outranks "this one grew by 12 lines".
          if (entry.problems > 0) {
            return (
              <Text key={i} color="red">
                {`✖  ${stat}`}
              </Text>
            );
          }
          return (
            <Text key={i} color={entry.touch === "wrote" ? "green" : undefined} dimColor={entry.touch === "read"}>
              {`${MARK[entry.touch]}  ${stat}`}
            </Text>
          );
        })
      )}
      <Text dimColor>{"● wrote  ○ read  ✖ failing"}</Text>
    </Box>
  );
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
  return (
    <Box flexDirection="column">
      <Text dimColor>{`${file.path}:${hunk.newStart}`}</Text>
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
        return (
          <Text key={i} dimColor={done} color={active ? "cyan" : undefined}>
            {`  ${done ? "✔" : active ? "▸" : "☐"} ${entry.content}`}
          </Text>
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
}: {
  result: CheckResult | null;
  running: boolean;
}): React.JSX.Element | null {
  if (running) {
    return <Text dimColor>{"CHECKS  running…"}</Text>;
  }
  if (result === null) {
    // Deliberately not silent: a project with no check configured should
    // learn that it could have one, exactly when it would have mattered.
    return <Text dimColor>{"CHECKS  none configured — add an executable .ctui/check"}</Text>;
  }
  if (result.ok) {
    return <Text color="green">{`CHECKS  ${result.command}  ✔ passing`}</Text>;
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
