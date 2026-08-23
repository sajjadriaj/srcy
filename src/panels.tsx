import React, { useEffect, useMemo, useRef, useState } from "react";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Box, Text, render, useInput } from "ink";
import { LiveDiff, PlanBar, gauge, tokens, type PlanEntry, type Usage } from "./cockpit.js";
import type { FileDiff } from "./diff.js";
import { runChecks, type CheckResult } from "./checks.js";
import { listPaths, repoState, type RepoState } from "./repo.js";
import { openForChanges, rows as treeRows, toggle, window as treeWindow, type Row } from "./tree.js";
import { publishSelection, readSelection } from "./tmux.js";
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
// showing without ctui drawing a single border character itself.
function setPaneTitle(title: string): void {
  process.stdout.write(`\u001b]2;${title}\u0007`);
}

// A pane's size is not fixed: tmux resizes it whenever the terminal changes,
// and the rail clips its rows to fit. Reading the size once at startup means
// the first row scrolls off the top the first time anyone drags a window
// edge, which is exactly when a file list is least useful.
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
// Polling

interface Watched {
  repo: RepoState;
  plan: PlanEntry[];
  usage: Usage | null;
  activity: Activity | null;
  checks: CheckResult | null | undefined;
}

const EMPTY: Watched = {
  repo: { files: [], diffs: [] },
  plan: [],
  usage: null,
  activity: null,
  checks: undefined,
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
// the checker never ran at all on a repo that was already clean when ctui
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
function useWatch(cwd: string, rail: boolean, source: Source | null): Watched {
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

  useEffect(() => {
    let live = true;
    let timer: NodeJS.Timeout;

    const tick = async (): Promise<void> => {
      try {
        const repo = await repoState(cwd, problems.current?.problems ?? []);
        const t = rail && source !== null ? await readSession(cwd, source) : null;
        if (!live) return;
        setState({
          repo,
          plan: t?.plan ?? [],
          usage: t?.usage ?? null,
          activity: t?.activity ?? null,
          checks: problems.current,
        });

        if (rail) {
          const step = checkStep(fingerprint(repo), mark.current, quietSince.current, Date.now(), checking.current);
          mark.current = step.mark;
          quietSince.current = step.quietSince;
          if (step.run) {
            checking.current = true;
            // Deliberately not awaited inside the tick: a typecheck can take
            // ten seconds, and the rail must keep updating while it runs.
            void runChecks(cwd, cwd)
              .then((r) => {
                problems.current = r;
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
  }, [cwd, rail, source]);

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
}: {
  result: CheckResult | null | undefined;
  width: number;
}): React.JSX.Element {
  if (result === undefined) return <Text dimColor>{"  not run yet"}</Text>;
  if (result === null) return <Text dimColor>{"  none configured"}</Text>;
  if (result.ok) return <Text color="green">{`  ✔ ${result.command}`.slice(0, width)}</Text>;
  const shown = result.problems.slice(0, RAIL_PROBLEMS);
  const files = new Set(result.problems.map((p) => p.path)).size;
  return (
    <Box flexDirection="column">
      <Text color="red">{`  ✖ ${result.problems.length} in ${files} file${files === 1 ? "" : "s"}`}</Text>
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

// The wide UsageBar puts everything on one line, which a rail this narrow
// wraps into nonsense. Same numbers, stacked.
export function NarrowUsage({ usage, width }: { usage: Usage | null; width: number }): React.JSX.Element {
  if (usage === null) return <Text dimColor>{"  not measured"}</Text>;
  const frac = usage.used / usage.size;
  const color = frac >= 0.85 ? "red" : frac >= 0.6 ? "yellow" : "green";
  const bar = gauge(usage.used, usage.size, Math.max(6, width - 8));
  const extras: string[] = [];
  if (usage.output !== undefined) extras.push(`out ${tokens(usage.output)}`);
  if (usage.cached !== undefined) extras.push(`cache ${Math.round(usage.cached * 100)}%`);
  return (
    <Box flexDirection="column">
      <Text color={color}>{`${bar} ${String(Math.round(frac * 100)).padStart(3)}%`}</Text>
      <Text dimColor>{`  ${tokens(usage.used)}/${tokens(usage.size)}`}</Text>
      {extras.length > 0 ? <Text dimColor>{`  ${extras.join("  ")}`}</Text> : null}
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

export function activityTitle(a: Activity | null): string {
  if (a === null) return " idle ";
  // A path gets its basename — the directory is already on screen in the
  // rail. A command keeps its head: `npm run build` identifies itself in
  // its first words, where a pipeline's tail identifies nothing.
  const looksLikePath = a.target.includes("/") && !a.target.includes(" ");
  const short = looksLikePath ? (a.target.split("/").pop() ?? "") : a.target;
  const text = `⟳ ${a.tool}${short === "" ? "" : ` ${short}`}`;
  return ` ${text.length <= TITLE_MAX ? text : `${text.slice(0, TITLE_MAX - 1)}…`} `;
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

export function usageRows(usage: Usage | null): number {
  if (usage === null) return 1;
  return usage.output === undefined && usage.cached === undefined ? 2 : 3;
}

// Lines left for the file list once the plan, the failures, the gauge and
// the three rules between them have taken theirs.
export function mapBudget(height: number, plan: number, checks: number, usage: number): number {
  return Math.max(3, height - 3 - Math.max(1, plan) - checks - usage);
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
  // Null for an agent whose session format ctui cannot read: PLAN and
  // CONTEXT stay blank rather than showing another agent's numbers.
  source?: Source | null;
  // Where to publish the file the cursor picks, for the dock to read.
  session?: string;
  interactive?: boolean;
}): React.JSX.Element {
  const s = useWatch(cwd, true, source);
  const paths = useTree(cwd);
  const changed = useMemo(() => new Map(s.repo.files.map((f) => [f.path, f])), [s.repo.files]);

  // Directories the reader has opened or closed by hand. Null until they
  // touch one, so until then the view follows the work: everything on the
  // path to a change is open and nothing else is.
  const [manual, setManual] = useState<Set<string> | null>(null);
  const auto = useMemo(() => openForChanges(changed.keys()), [changed]);
  const open = manual ?? auto;

  const visible = useMemo(() => treeRows(paths, open, changed), [paths, open, changed]);
  const [cursor, setCursor] = useState(-1);

  // Until the reader moves it, the cursor sits on the first changed file
  // rather than on row zero — which is whichever dotfile directory sorts
  // first, and never what anyone opened the rail to look at.
  const firstChange = visible.findIndex((r) => r.entry !== undefined);
  const at = cursor >= 0 ? Math.min(cursor, Math.max(0, visible.length - 1)) : Math.max(0, firstChange);

  useEffect(() => {
    setPaneTitle(activityTitle(s.activity));
  }, [s.activity?.tool, s.activity?.target]);

  // tmux only delivers keystrokes to the focused pane, so this is inert
  // until the reader moves the keyboard here — the agent keeps every key
  // otherwise, which is the point.
  useInput(
    (input, key) => {
      if (visible.length === 0) return;
      const row = visible[at];
      if (input === "j" || key.downArrow) setCursor(Math.min(at + 1, visible.length - 1));
      else if (input === "k" || key.upArrow) setCursor(Math.max(at - 1, 0));
      else if (row !== undefined && (key.return || input === " ")) {
        if (row.dir) setManual(toggle(open, row.path));
        // A file the reader picked outranks the file the agent wrote last:
        // they are looking at something on purpose.
        else if (session !== "") publishSelection(session, row.path);
      }
    },
    { isActive: interactive },
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
      <NarrowChecks result={s.checks} width={width} />
      {/* Pushes CONTEXT to the bottom edge, so the gauge is in the same
          place whether the session has touched two files or twenty. A
          number you have to hunt for is a number you stop reading. */}
      <Box flexGrow={1} />
      <Rule label="CONTEXT" width={width} />
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

export function Dock({ cwd, rows, session = "" }: { cwd: string; rows: number; session?: string }): React.JSX.Element {
  const s = useWatch(cwd, false, null);
  const [file, setFile] = useState<FileDiff | undefined>(undefined);
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      // A file the reader picked in the rail outranks the file the agent
      // wrote last: they are looking at something on purpose.
      const picked = session === "" ? "" : readSelection(session);
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

  if (file !== undefined) return <LiveDiff file={file} maxLines={Math.max(3, rows - 2)} />;
  if (preview !== null) {
    const lines = preview.text.split("\n").slice(0, Math.min(PREVIEW_LINES, Math.max(3, rows - 2)));
    return (
      <Box flexDirection="column">
        {lines.map((line, i) => (
          <Text key={i} dimColor>{`${String(i + 1).padStart(4)}  ${line}`}</Text>
        ))}
      </Box>
    );
  }
  return <Text dimColor>{"  working tree clean — nothing to review"}</Text>;
}

// ---------------------------------------------------------------------------

// Entry point for `ctui panel <which>`, run by tmux inside the pane.
function Panel({ which, source, session }: { which: string; source: Source | null; session: string }): React.JSX.Element {
  const { cols, rows } = useSize();
  const cwd = process.cwd();
  return which === "dock" ? (
    <Dock cwd={cwd} rows={rows} session={session} />
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
