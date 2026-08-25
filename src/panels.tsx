import React, { useEffect, useMemo, useRef, useState } from "react";
import { renameSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Box, Text, render, useInput } from "ink";
import { LiveDiff, PlanBar, gauge, tokens, type PlanEntry, type Usage } from "./cockpit.js";
import type { FileDiff } from "./diff.js";
import { runChecks, type CheckResult, type Problem } from "./checks.js";
import { listPaths, repoState, type RepoState } from "./repo.js";
import { NOTHING, openForChanges, openSet, rows as treeRows, toggle, window as treeWindow, type Manual, type Row } from "./tree.js";
import { CLAUDE, readSession, type Activity, type Source } from "./transcript.js";
import { CODEX } from "./codex.js";

// The panels around the agent's pane.
//
// Each one is its own process in its own tmux pane, and none of them talks
// to the agent. They read git and the transcript on a timer, which is why
// they work the same whether the pane beside them is running Claude Code,
// Codex, opencode, or a person with an editor open.

// Fast enough that a file the agent just wrote shows up while you are still
// reading the sentence that announced it; slow enough that `git diff` on a
// large repo never stacks up. Checks are far more expensive and run on
// change instead (see below).
const POLL_MS = 1200;

// After the diff stops moving, wait this long before running the project's
// checker. An agent mid-edit produces a broken tree on purpose, and a rail
// that goes red between two halves of one edit is noise.
const CHECK_QUIET_MS = 2500;

// A pane sets its own tmux title with OSC 2 — the same escape any terminal
// program uses to name its window. tmux reads it into #{pane_title}, which
// the border format prints. So the border can say which file the dock is
// showing without srcy drawing a single border character itself.
function setPaneTitle(title: string): void {
  // Only to a real terminal. Anywhere else — a pipe, a test — this is an
  // escape sequence printed into somebody's output as literal text.
  if (process.stdout.isTTY !== true) return;
  process.stdout.write(`\u001b]2;${title}\u0007`);
}

// A pane's size is not fixed: tmux resizes it whenever the terminal changes,
// and the rail clips its rows to fit. Reading the size once at startup means
// the first row scrolls off the top the first time anyone drags a window
// edge, which is exactly when a file list is least useful.
// Elapsed time has to advance while the transcript sits still — a wedged
// tool writes nothing, which is exactly when the number matters.
export function useNow(active: boolean): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) {
      setNow(0);
      return;
    }
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function useSize(): { cols: number; rows: number } {
  const read = (): { cols: number; rows: number } => ({
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const on = (): void => setSize(read());
    process.stdout.on("resize", on);
    return () => {
      process.stdout.off("resize", on);
    };
  }, []);
  return size;
}

// ---------------------------------------------------------------------------
// Between the panels
//
// The rail and the dock are separate processes, and the rail knows two things
// the dock cannot see for itself: which file the reader picked, and what the
// project's checker said. The dock will not run a typecheck the rail is
// already running.
//
// This was a tmux user option, which is the right store for a path and the
// wrong one for a check result. Measured on tmux 3.4: set-option refuses a
// value somewhere past 16 KB with "command too long", and a value holding
// `$name` reads back with a backslash inserted — enough on its own to make
// JSON.parse throw on a message that mentions a shell variable. A file has
// neither limit, costs no process per poll, and is named after the session,
// which is already unique per repo.

interface Shared {
  file?: string;
  checks?: CheckResult | null;
}

function statePath(session: string): string {
  return join(tmpdir(), `${session}.json`);
}

let shared: Shared = {};

// Written whole and renamed into place: the dock reads this on a timer, and a
// half-written file is a JSON.parse away from the pane blanking mid-poll.
export function publish(session: string, patch: Shared): void {
  if (session === "") return;
  shared = { ...shared, ...patch };
  const path = statePath(session);
  try {
    writeFileSync(`${path}.tmp`, JSON.stringify(shared));
    renameSync(`${path}.tmp`, path);
  } catch {
    // The dock keeps the last state it read, which beats a crashed rail.
  }
}

// Clearing is its own verb. Merging an empty patch reads like a clear and is
// not one: `shared` outlives the call, so the write would put the last pick
// straight back on disk.
export function reset(session: string): void {
  shared = {};
  publish(session, {});
}

export async function readShared(session: string): Promise<Shared> {
  if (session === "") return {};
  try {
    return JSON.parse(await readFile(statePath(session), "utf8")) as Shared;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Polling

interface Watched {
  repo: RepoState;
  plan: PlanEntry[];
  usage: Usage | null;
  activity: Activity | null;
  checks: CheckResult | null | undefined;
  // The tree has moved since that check ran, so its verdict describes code
  // that no longer exists. A red CHECKS from thirty seconds ago reads
  // exactly like a red CHECKS from now, and only one of them is worth
  // interrupting the agent over.
  stale: boolean;
}

const EMPTY: Watched = {
  repo: { files: [], diffs: [] },
  plan: [],
  usage: null,
  activity: null,
  checks: undefined,
  stale: false,
};

// A cheap identity for "has the working tree changed" — path plus churn per
// file. Comparing full diff text would re-run the checker on a whitespace
// edit inside an unchanged line count; comparing file names alone would miss
// every edit that does not add or remove a file.
export function fingerprint(s: RepoState): string {
  return s.files.map((f) => `${f.path}:${f.added}:${f.removed}`).join("|");
}

// When to run the project's checker. Pure, because the decision has three
// conditions and one of them already hid a bug: a clean tree fingerprints to
// the empty string, so a `mark` starting at "" read as "nothing changed" and
// the checker never ran at all on a repo that was already clean when srcy
// opened. `mark` is null until the first observation for exactly that reason.
//
// The wait exists because an agent mid-edit produces a broken tree on
// purpose: a rail that goes red between two halves of one edit is noise.
export interface CheckStep {
  mark: string;
  quietSince: number;
  run: boolean;
}

export function checkStep(
  fp: string,
  mark: string | null,
  quietSince: number,
  now: number,
  busy: boolean,
): CheckStep {
  // Still moving: restart the clock, and never run on a tree the agent is
  // partway through rewriting.
  if (fp !== mark) return { mark: fp, quietSince: now, run: false };
  // Already ran for this fingerprint, or a run is in flight.
  if (quietSince === 0 || busy) return { mark, quietSince, run: false };
  if (now - quietSince < CHECK_QUIET_MS) return { mark, quietSince, run: false };
  // Zeroed so the same quiet tree is not checked once a second forever.
  return { mark, quietSince: 0, run: true };
}

// `rail` is the pane that shows everything. The dock shows one diff, so it
// neither runs the project's checker nor opens the transcript — work whose
// result it would never draw.
function useWatch(cwd: string, rail: boolean, source: Source | null, session = ""): Watched {
  const [state, setState] = useState<Watched>(EMPTY);
  // Refs, not state: these drive when work happens, and re-rendering because
  // a fingerprint changed would be a render per poll forever.
  //
  // null, not "": a clean tree fingerprints to the empty string, so starting
  // this at "" makes the first tick look like "nothing changed" and the
  // checker never runs at all on a repo that was already clean.
  const mark = useRef<string | null>(null);
  const quietSince = useRef(0);
  const checking = useRef(false);
  const problems = useRef<CheckResult | null | undefined>(undefined);
  // The fingerprint the current result was measured against.
  const checkedFor = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    let timer: NodeJS.Timeout;
    // A session name is reused when you reopen the same repo, so the file may
    // still hold the last run's pick. Cleared before the dock can read it.
    if (rail) reset(session);

    const tick = async (): Promise<void> => {
      try {
        const repo = await repoState(cwd, problems.current?.problems ?? []);
        const t = rail && source !== null ? await readSession(cwd, source) : null;
        if (!live) return;
        const fp = fingerprint(repo);
        setState({
          repo,
          plan: t?.plan ?? [],
          usage: t?.usage ?? null,
          activity: t?.activity ?? null,
          checks: problems.current,
          stale: problems.current !== undefined && checkedFor.current !== null && checkedFor.current !== fp,
        });

        if (rail) {
          const step = checkStep(fp, mark.current, quietSince.current, Date.now(), checking.current);
          mark.current = step.mark;
          quietSince.current = step.quietSince;
          if (step.run) {
            checking.current = true;
            // Deliberately not awaited inside the tick: a typecheck can take
            // ten seconds, and the rail must keep updating while it runs.
            const ranFor = step.mark;
            void runChecks(cwd, cwd)
              .then((r) => {
                problems.current = r;
                checkedFor.current = ranFor;
                // The rail has room for `session.ts:3`. The message goes to
                // the pane with the width to print it.
                publish(session, { checks: r });
              })
              .catch(() => {})
              .finally(() => {
                checking.current = false;
              });
          }
        }
      } catch {
        // Panels are display-only. A failed poll leaves the last good frame
        // on screen, which is a better answer than a stack trace in a pane
        // the reader cannot scroll.
      }
      if (live) timer = setTimeout(() => void tick(), POLL_MS);
    };

    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [cwd, rail, source, session]);

  return state;
}

// ---------------------------------------------------------------------------
// Rail

export function Rule({ label, width }: { label: string; width: number }): React.JSX.Element {
  return <Text dimColor>{`─ ${label} ${"─".repeat(Math.max(0, width - label.length - 3))}`}</Text>;
}

// How many failing locations fit in a column this narrow before the list is
// doing more harm than the count alone.
const RAIL_PROBLEMS = 3;

export function NarrowChecks({
  result,
  width,
  stale = false,
}: {
  result: CheckResult | null | undefined;
  width: number;
  // The code moved since this ran. Said out loud rather than shown as a
  // current verdict, because acting on a stale pass is the expensive mistake.
  stale?: boolean;
}): React.JSX.Element {
  if (result === undefined) return <Text dimColor>{"  not run yet"}</Text>;
  if (result === null) return <Text dimColor>{"  none configured"}</Text>;
  const age = stale ? " · code moved since" : "";
  if (result.ok) {
    return stale ? (
      <Text dimColor>{`  ✔ ${result.command}${age}`.slice(0, width)}</Text>
    ) : (
      <Text color="green">{`  ✔ ${result.command}`.slice(0, width)}</Text>
    );
  }
  const shown = result.problems.slice(0, RAIL_PROBLEMS);
  const files = new Set(result.problems.map((p) => p.path)).size;
  return (
    <Box flexDirection="column">
      <Text color={stale ? undefined : "red"} dimColor={stale}>
        {`  ✖ ${result.problems.length} in ${files} file${files === 1 ? "" : "s"}${age}`.slice(0, width)}
      </Text>
      {shown.map((p, i) => (
        // Truncated rather than wrapped: a TypeScript message is longer than
        // this column and wrapping one costs four rows that the next failure
        // needed. The dock has the width to show it in full.
        <Text key={i} dimColor>
          {`  ${p.path.split("/").pop() ?? p.path}:${p.line}`.slice(0, width)}
        </Text>
      ))}
      {result.problems.length > shown.length ? (
        <Text dimColor>{`  …and ${result.problems.length - shown.length} more`}</Text>
      ) : null}
    </Box>
  );
}

// One line, and no heading above it.
//
// Claude Code prints a context percentage in its own status line and again
// under /context, so a four-row panel here was spending the rail's scarcest
// resource on a number the reader already had. What no agent prints is the
// cache share — the reading that says whether a session is re-sending its
// whole context every turn — so that is the part worth a row.
//
// `out` is gone with the rows it cost. It was the one number here nobody
// acts on: knowing the agent has written twelve thousand tokens changes
// nothing you would do next.
export function NarrowUsage({ usage, width }: { usage: Usage | null; width: number }): React.JSX.Element {
  if (usage === null) return <Text dimColor>{clipTo("  context not measured", width)}</Text>;
  const frac = usage.used / usage.size;
  const color = frac >= 0.85 ? "red" : frac >= 0.6 ? "yellow" : "green";
  const cache = usage.cached === undefined ? "" : ` cache ${Math.round(usage.cached * 100)}%`;
  const text = `${String(Math.round(frac * 100)).padStart(2)}% ${tokens(usage.used)}/${tokens(usage.size)}${cache}`;
  // The numbers are sized first and the bar takes what is left. A bar with a
  // fixed width pushes the counts off the right edge of a narrow rail, and
  // the counts are the half you read — the bar is only there to be glanced
  // at. One cell is held back so an exact fit cannot wrap.
  const bar = gauge(usage.used, usage.size, Math.max(0, width - text.length - 2));
  return (
    <Box>
      <Text color={color}>{bar}</Text>
      <Text dimColor>{clipTo(` ${text}`, width - bar.length)}</Text>
    </Box>
  );
}

// PlanBar draws its own "PLAN" heading, which the rule above already drew.
// Dropping it here keeps one labelling style down the whole rail instead of
// two that disagree about capitalisation and spacing.
export function PlanBody({ entries }: { entries: PlanEntry[] }): React.JSX.Element {
  if (entries.length === 0) return <Text dimColor>{"  (no plan)"}</Text>;
  const bar = PlanBar({ entries });
  if (bar === null) return <Text dimColor>{"  (no plan)"}</Text>;
  const kids = React.Children.toArray((bar.props as { children?: React.ReactNode }).children);
  return <Box flexDirection="column">{kids.slice(1)}</Box>;
}

// The pane border says what the agent is doing right now — the one fact that
// belongs where the eye already is rather than in a row it has to find.
export const TITLE_MAX = 28;

// Coarse on purpose. Under ten seconds the decimal is the whole signal —
// 0.2s is a cache hit, 4.1s is a real call — and past a minute nobody reads
// the seconds, they read "this has been going for four minutes".
export function elapsed(ms: number): string {
  if (ms < 0) return "0s";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

export function activityTitle(a: Activity | null, now = 0, width = TITLE_MAX): string {
  if (a === null) return " idle ";
  // A path gets its basename — the directory is already on screen in the
  // rail. A command keeps its head: `npm run build` identifies itself in
  // its first words, where a pipeline's tail identifies nothing.
  const looksLikePath = a.target.includes("/") && !a.target.includes(" ");
  const short = looksLikePath ? (a.target.split("/").pop() ?? "") : a.target;
  // The age leads. tmux truncates a pane border to the pane's width and the
  // rail is narrow, so anything at the end is the first thing cut — and how
  // long this has been running is the one part you cannot get by looking at
  // the agent's own pane.
  const age = a.since === undefined || now === 0 ? "" : `${elapsed(now - a.since)} `;
  const body = `⟳ ${age}${a.tool}${short === "" ? "" : ` ${short}`}`;
  return ` ${body.length <= width ? body : `${body.slice(0, Math.max(1, width - 1))}…`} `;
}

// How many lines each fixed section will occupy. Exported and used by the
// budget below rather than eyeballed: a section that renders one line more
// than the budget assumed pushes the gauge off the bottom of the pane, and
// Ink overdraws rather than scrolling — rows land on top of each other.
export function checksRows(result: CheckResult | null | undefined): number {
  if (result === undefined || result === null || result.ok) return 1;
  const shown = Math.min(RAIL_PROBLEMS, result.problems.length);
  return 1 + shown + (result.problems.length > shown ? 1 : 0);
}

// One line whatever it holds. Still measured through this function rather
// than written as 1 in the budget, so the two can never drift apart.
export function usageRows(_usage: Usage | null): number {
  return 1;
}

// Lines left for the file list once the plan, the failures, the gauge and
// the two rules between them have taken theirs.
export function mapBudget(height: number, plan: number, checks: number, usage: number): number {
  return Math.max(3, height - 2 - Math.max(1, plan) - checks - usage);
}

// How often the project's file list is refreshed. Slower than the poll
// because files appear and vanish far less often than they change, and
// `git ls-files` on a large repo is not free.
const TREE_MS = 5000;

function useTree(cwd: string): string[] {
  const [paths, setPaths] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    const tick = async (): Promise<void> => {
      const next = await listPaths(cwd).catch(() => []);
      if (live && next.length > 0) setPaths(next);
    };
    void tick();
    const id = setInterval(() => void tick(), TREE_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [cwd]);
  return paths;
}

// Where the cursor sits, given the row the reader picked.
//
// A path, not a row number: the agent adds and removes files while you are
// reading, and an index silently means a different file every time the list
// shifts under it. Falling back also covers a picked row that went away — a
// file the agent deleted, or one hidden when a directory closed — and an
// untouched cursor, which starts on the session's work rather than on
// whichever dotfile directory sorts first.
export function cursorAt(visible: Row[], picked: string | null): number {
  if (picked !== null) {
    const found = visible.findIndex((r) => r.path === picked);
    if (found >= 0) return found;
  }
  return Math.max(0, visible.findIndex((r) => r.entry !== undefined));
}

export function Rail({
  cwd,
  width,
  height,
  source = null,
  session = "",
  interactive = true,
}: {
  cwd: string;
  width: number;
  height?: number;
  // Null for an agent whose session format srcy cannot read: PLAN and
  // CONTEXT stay blank rather than showing another agent's numbers.
  source?: Source | null;
  // Where to publish the file the cursor picks, for the dock to read.
  session?: string;
  interactive?: boolean;
}): React.JSX.Element {
  const s = useWatch(cwd, true, source, session);
  const paths = useTree(cwd);
  const changed = useMemo(() => new Map(s.repo.files.map((f) => [f.path, f])), [s.repo.files]);

  // Directories the reader opened or closed by hand, layered over the ones
  // the work opens by itself.
  const [manual, setManual] = useState<Manual>(NOTHING);
  const auto = useMemo(() => openForChanges(changed.keys()), [changed]);
  const open = useMemo(() => openSet(auto, manual), [auto, manual]);

  const visible = useMemo(() => treeRows(paths, open, changed), [paths, open, changed]);

  const [picked, setPicked] = useState<string | null>(null);
  const at = cursorAt(visible, picked);

  const now = useNow(s.activity !== null);
  useEffect(() => {
    // Sized to the pane, minus the corners and padding tmux draws around it.
    setPaneTitle(activityTitle(s.activity, now, Math.max(8, width - 6)));
  }, [s.activity?.tool, s.activity?.target, now, width]);

  // tmux only delivers keystrokes to the focused pane, so this is inert
  // until the reader moves the keyboard here — the agent keeps every key
  // otherwise, which is the point.
  useInput(
    (input, key) => {
      if (visible.length === 0) return;
      const row = visible[at];
      const go = (i: number): void => setPicked(visible[Math.max(0, Math.min(i, visible.length - 1))]?.path ?? null);
      if (input === "j" || key.downArrow) go(at + 1);
      else if (input === "k" || key.upArrow) go(at - 1);
      else if (row !== undefined && (key.return || input === " ")) {
        if (row.dir) setManual(toggle(manual, row.path, open.has(row.path)));
        // A file the reader picked outranks the file the agent wrote last:
        // they are looking at something on purpose.
        else publish(session, { file: row.path });
      }
    },
    // Ink turns on raw mode to read keys, which a pane that is not a
    // terminal cannot do. Guarded so the rail still renders there — under a
    // pipe, or in a test — instead of throwing on mount.
    { isActive: interactive && process.stdin.isTTY === true },
  );

  const budget = height === undefined ? undefined : mapBudget(height, s.plan.length, checksRows(s.checks), usageRows(s.usage));
  const view = treeWindow(visible.length, at, Math.max(1, (budget ?? visible.length) - 1));

  return (
    <Box flexDirection="column" height={height}>
      <Text dimColor>REPO</Text>
      {visible.length === 0 ? (
        <Text dimColor>{"  (reading the project…)"}</Text>
      ) : (
        visible.slice(view.start, view.end).map((row, i) => (
          <TreeLine key={row.path} row={row} width={width} cursor={view.start + i === at} />
        ))
      )}
      <Rule label="PLAN" width={width} />
      <PlanBody entries={s.plan} />
      <Rule label="CHECKS" width={width} />
      <NarrowChecks result={s.checks} width={width} stale={s.stale} />
      {/* Pushes the gauge to the bottom edge, so it is in the same place
          whether the session has touched two files or twenty. A number you
          have to hunt for is a number you stop reading. It carries no
          heading: `47% 94.6k/200k` says what it is, and a rule above it
          would cost a row of the tree to repeat that. */}
      <Box flexGrow={1} />
      <NarrowUsage usage={s.usage} width={width} />
    </Box>
  );
}

// One row of the tree. The marker column is the same width whether or not a
// file changed, so nesting reads straight down and does not jog when the
// agent touches something.
export function TreeLine({ row, width, cursor }: { row: Row; width: number; cursor: boolean }): React.JSX.Element {
  const indent = "  ".repeat(row.depth);
  const caret = cursor ? "\u25ba" : " ";
  if (row.dir) {
    return (
      <Text dimColor inverse={cursor}>
        {clipTo(`${row.open === true ? "\u25be" : "\u25b8"}${caret} ${indent}${row.name}/`, width)}
      </Text>
    );
  }
  const e = row.entry;
  if (e === undefined) {
    return (
      <Text dimColor inverse={cursor}>
        {clipTo(`  ${caret} ${indent}${row.name}`, width)}
      </Text>
    );
  }
  const stat = e.problems > 0 ? `\u2716${e.problems}` : `+${e.added} -${e.removed}`;
  const label = `${indent}${row.name}`.padEnd(Math.max(0, width - 12));
  return (
    <Text color={e.problems > 0 ? "red" : "green"} inverse={cursor}>
      {clipTo(`${e.problems > 0 ? "\u2716" : "\u25aa"}${caret} ${label} ${stat}`, width)}
    </Text>
  );
}

function clipTo(s: string, width: number): string {
  return s.length <= width ? s : `${s.slice(0, width - 1)}\u2026`;
}

// ---------------------------------------------------------------------------
// Dock

// newest picks the file the agent touched last, by mtime. That is what a
// reader wants the dock showing without having to steer it: the edit that
// just scrolled past in the pane above.
export async function newest(cwd: string, diffs: FileDiff[]): Promise<FileDiff | undefined> {
  let best: { f: FileDiff; at: number } | undefined;
  for (const f of diffs) {
    try {
      const at = (await stat(join(cwd, f.path))).mtimeMs;
      if (best === undefined || at > best.at) best = { f, at };
    } catch {
      continue; // deleted by the edit we are trying to show
    }
  }
  return best?.f;
}

// How much of an unchanged file to show. The dock is a preview, not an
// editor: enough to see what the file is, and no scrollback to get lost in.
const PREVIEW_LINES = 400;

// How many rows of failure the dock spends before the diff. Four is what the
// rail already caps at, and a fifth line of TypeScript is rarely the one that
// tells you something the first four did not.
const DOCK_PROBLEMS = 4;

// The rail says `session.ts:3`, which is where — never what. The message is
// the half that says what to do about it, and this is the pane with the
// width to print it.
//
// Returned as strings rather than rendered here so the dock can count them:
// the diff below has to give up exactly these rows, and Ink overdraws rather
// than scrolling when it does not.
export function problemLines(
  checks: CheckResult | null | undefined,
  focus: string | undefined,
  width: number,
): string[] {
  if (checks === undefined || checks === null || checks.ok) return [];
  // The file on screen first: its failures are the ones the diff underneath
  // is about. The rest still show, because a tree that does not compile is
  // worth reading whichever file you happened to be looking at.
  const ordered = [
    ...checks.problems.filter((p) => p.path === focus),
    ...checks.problems.filter((p) => p.path !== focus),
  ];
  if (ordered.length === 0) {
    // A failure that named no location at all: the raw output is the only
    // thing there is to go on, and nowhere else shows it.
    return checks.tail
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-DOCK_PROBLEMS)
      .map((l) => `  ${l}`.slice(0, width));
  }
  const out = ordered
    .slice(0, DOCK_PROBLEMS)
    .map((p: Problem) => `  ✖ ${p.path}:${p.line}  ${p.message}`.slice(0, width));
  if (ordered.length > out.length) out.push(`  …and ${ordered.length - out.length} more`);
  return out;
}

export function Dock({
  cwd,
  rows,
  width = 80,
  session = "",
}: {
  cwd: string;
  rows: number;
  width?: number;
  session?: string;
}): React.JSX.Element {
  const s = useWatch(cwd, false, null);
  const [file, setFile] = useState<FileDiff | undefined>(undefined);
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);
  const [checks, setChecks] = useState<CheckResult | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    void (async () => {
      const state = await readShared(session);
      if (!live) return;
      setChecks(state.checks);
      // A file the reader picked in the rail outranks the file the agent
      // wrote last: they are looking at something on purpose.
      const picked = state.file ?? "";
      if (picked !== "") {
        const diff = s.repo.diffs.find((f) => f.path === picked);
        if (diff !== undefined) {
          if (live) {
            setFile(diff);
            setPreview(null);
          }
          return;
        }
        // Picked, but unchanged. Showing "no diff" would make every
        // unmodified file a dead end, so the dock reads it instead.
        const text = await readFile(join(cwd, picked), "utf8").catch(() => null);
        if (live) {
          setFile(undefined);
          setPreview(text === null ? null : { path: picked, text });
        }
        return;
      }
      const newestFile = await newest(cwd, s.repo.diffs);
      if (live) {
        setFile(newestFile);
        setPreview(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [cwd, session, s.repo.diffs]);

  const title = file?.path ?? preview?.path;
  useEffect(() => {
    setPaneTitle(title === undefined ? " DIFF  (clean) " : ` ${file === undefined ? "FILE" : "DIFF"}  ${title} `);
  }, [title, file === undefined]);

  const failures = problemLines(checks, title, width);
  const room = Math.max(3, rows - 2 - failures.length);
  const body =
    file !== undefined ? (
      <LiveDiff file={file} maxLines={room} />
    ) : preview !== null ? (
      <Box flexDirection="column">
        {preview.text
          .split("\n")
          .slice(0, Math.min(PREVIEW_LINES, room))
          .map((line, i) => (
            <Text key={i} dimColor>{`${String(i + 1).padStart(4)}  ${line}`}</Text>
          ))}
      </Box>
    ) : (
      <Text dimColor>{"  working tree clean — nothing to review"}</Text>
    );

  if (failures.length === 0) return body;
  return (
    <Box flexDirection="column">
      {failures.map((line, i) => (
        <Text key={i} color="red">
          {line}
        </Text>
      ))}
      {body}
    </Box>
  );
}

// ---------------------------------------------------------------------------

// Entry point for `srcy panel <which>`, run by tmux inside the pane.
function Panel({ which, source, session }: { which: string; source: Source | null; session: string }): React.JSX.Element {
  const { cols, rows } = useSize();
  const cwd = process.cwd();
  return which === "dock" ? (
    <Dock cwd={cwd} rows={rows} width={cols} session={session} />
  ) : (
    <Rail cwd={cwd} width={cols} height={rows} source={source} session={session} />
  );
}

// Which on-disk session format to read, from the command the agent pane is
// running. The name is a command, not an enum, so anything unrecognised gets
// no source at all — REPO, CHECKS and DIFF still work, because those come
// from git.
export function sourceFor(agent: string): Source | null {
  const name = agent.split("/").pop() ?? agent;
  if (name === "claude") return CLAUDE;
  if (name === "codex") return CODEX;
  return null;
}

export function renderPanel(which: string, agent = "", session = ""): void {
  render(<Panel which={which} source={sourceFor(agent)} session={session} />);
}
