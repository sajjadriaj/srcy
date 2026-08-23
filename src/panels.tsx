import React, { useEffect, useRef, useState } from "react";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Box, Text, render } from "ink";
import { LiveDiff, PlanBar, RepoMap, gauge, tokens, type PlanEntry, type Usage } from "./cockpit.js";
import type { FileDiff } from "./diff.js";
import { runChecks, type CheckResult } from "./checks.js";
import { repoState, type RepoState } from "./repo.js";
import { readTranscript, type Activity } from "./transcript.js";

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

function useWatch(cwd: string, withChecks: boolean): Watched {
  const [state, setState] = useState<Watched>(EMPTY);
  // Refs, not state: these drive when work happens, and re-rendering because
  // a fingerprint changed would be a render per poll forever.
  const mark = useRef("");
  const quietSince = useRef(0);
  const checking = useRef(false);
  const problems = useRef<CheckResult | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    let timer: NodeJS.Timeout;

    const tick = async (): Promise<void> => {
      try {
        const repo = await repoState(cwd, problems.current?.problems ?? []);
        const t = await readTranscript(cwd);
        if (!live) return;
        setState({
          repo,
          plan: t?.plan ?? [],
          usage: t?.usage ?? null,
          activity: t?.activity ?? null,
          checks: problems.current,
        });

        if (withChecks) {
          const fp = fingerprint(repo);
          if (fp !== mark.current) {
            mark.current = fp;
            quietSince.current = Date.now();
          } else if (
            quietSince.current !== 0 &&
            Date.now() - quietSince.current >= CHECK_QUIET_MS &&
            !checking.current
          ) {
            quietSince.current = 0;
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
  }, [cwd, withChecks]);

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

export function Rail({ cwd, width, height }: { cwd: string; width: number; height?: number }): React.JSX.Element {
  const s = useWatch(cwd, true);
  useEffect(() => {
    setPaneTitle(activityTitle(s.activity));
  }, [s.activity?.tool, s.activity?.target]);

  return (
    <Box flexDirection="column" height={height}>
      <RepoMap
        entries={s.repo.files}
        width={width}
        maxRows={height === undefined ? undefined : mapBudget(height, s.plan.length, checksRows(s.checks), usageRows(s.usage))}
      />
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

export function Dock({ cwd, rows }: { cwd: string; rows: number }): React.JSX.Element {
  const s = useWatch(cwd, false);
  const [file, setFile] = useState<FileDiff | undefined>(undefined);

  useEffect(() => {
    void newest(cwd, s.repo.diffs).then(setFile);
  }, [cwd, s.repo.diffs]);

  useEffect(() => {
    setPaneTitle(file === undefined ? " DIFF  (clean) " : ` DIFF  ${file.path} `);
  }, [file?.path]);

  if (file === undefined) {
    return <Text dimColor>{"  working tree clean — nothing to review"}</Text>;
  }
  return <LiveDiff file={file} maxLines={Math.max(3, rows - 2)} />;
}

// ---------------------------------------------------------------------------

// Entry point for `ctui panel <which>`, run by tmux inside the pane.
function Panel({ which }: { which: string }): React.JSX.Element {
  const { cols, rows } = useSize();
  const cwd = process.cwd();
  return which === "dock" ? <Dock cwd={cwd} rows={rows} /> : <Rail cwd={cwd} width={cols} height={rows} />;
}

export function renderPanel(which: string): void {
  render(<Panel which={which} />);
}
