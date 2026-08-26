# Vibe Cockpit Design

## Summary

srcy will become a complete supervision loop around a native coding agent:
understand the requested outcome, watch the work, review the latest change, and
verify the result. The agent remains an unmodified terminal program. srcy owns
only the panes around it and never injects prompts, stages files, commits work,
or claims success without evidence.

The upgrade preserves the existing workbench layout and terminal-native visual
language. It adds interaction depth through modes and focused controls rather
than permanent panes or dashboard cards.

## Audience, job, and tone

- **Audience:** developers supervising Claude Code, Codex, or another native
  coding agent in an existing Git repository.
- **Primary job:** answer four questions without searching terminal scrollback:
  what is the agent trying to accomplish, what changed in this turn, what has
  been verified, and what needs attention?
- **Tone:** technical, austere, and evidence-led. Colour continues to mean
  state: green wrote or passed, red failed, cyan is active, and dim content is
  background information.

## Product principles

1. **The agent stays native.** Its command, PTY, keys, scrollback, slash
   commands, and permission prompts remain its own.
2. **State is truthful.** Unknown, not run, stale, running, passing, and failing
   are distinct states.
3. **Observation before control.** srcy may run configured checks and a
   configured development process, but it does not alter source control or send
   input to the agent.
4. **Compact by structure, not omission.** Narrow layouts switch modes instead
   of squeezing three unreadable panes together.
5. **Configuration is optional.** Existing zero-config behavior remains useful.
6. **Every added signal must support a decision.** No decorative analytics,
   activity charts, or cumulative token vanity metrics.

## Chosen architecture

The existing multi-process design remains:

- tmux owns the real agent PTY and pane layout.
- The rail process watches repository, transcript, task, gate, and runtime
  state.
- The dock process becomes an interactive review surface.
- The processes exchange a versioned, atomically-written session snapshot in
  the temporary directory.

There will be no central daemon. Focused pure modules will isolate configuration,
Git scopes, gate execution, runtime lifecycle, task parsing, review navigation,
and risk classification. The rail remains the owner of expensive or mutating
work such as gates, baselines, and the configured runtime. The dock only reads
snapshots and repository state.

This keeps panel failure isolated: a crashed dock cannot kill the agent, and a
failed poll leaves the last truthful frame visible.

## Wide interaction model

At 100 columns or wider, the existing workbench remains recognizable:

```text
REPO [CHANGED]       | native agent
changed tree         |
-- GOAL -------------|
current request      |
-- PLAN -------------|
agent execution      |
-- GATES 2/4 --------|
verification states  |
-- APP --------------|
runtime status       |
---------------------+------------------------------------------
 REVIEW | TURN | FOLLOW | file 2/5 | hunk 1/3
 complete navigable diff
 [/] hunk | n/p file | f follow | r gate | ? help
```

The layout does not add a fourth pane. GOAL, GATES, and APP share the rail's
vertical budget; low-value empty states collapse to one row. The dock footer is
shown only while the dock has focus or help is open.

### Rail controls

- `j`, `k`, arrows: move the tree cursor.
- `Tab`: cycle `CHANGED`, `FAILING`, and `ALL` tree modes.
- `/`: enter path search; typing filters; `Escape` clears; `Enter` accepts.
- `Enter` or `Space`: toggle a directory or pin a file in review.
- `f`: clear the pinned file and resume following the newest write.
- `c`: create a manual turn checkpoint.
- `r`: run the gate selected by the gate cursor.
- `R`: run every configured gate.
- `s`: start or stop the configured runtime.
- `?`: show contextual help.

### Dock controls

- `n`, `p`: next or previous changed file.
- `]`, `[`: next or previous hunk.
- `j`, `k`, arrows: scroll one line.
- `PageDown`, `PageUp`: scroll one viewport.
- `g`, `G`: first or last line.
- `f`: clear the pin and follow the newest changed file.
- `1`, `2`, `3`: select `TURN`, `SESSION`, or `HEAD` review scope.
- `?`: show contextual help.

Input remains active only in the focused panel. No binding steals keys from the
agent pane.

## Responsive model

- **100 columns or wider:** rail, agent, and dock are simultaneously visible.
- **72-99 columns:** all panes remain visible, but the rail uses its narrow
  representation and hides optional detail rows. The dock footer stays hidden
  unless focused.
- **Below 72 columns:** the agent pane starts zoomed. tmux prefix bindings
  `1`, `2`, and `3` zoom agent, rail, and review respectively. A resize into
  compact mode auto-zooms only when no user-selected zoom is active; returning
  wide reverses only an automatic zoom.

The compact transition is recorded in a tmux session option so resize hooks do
not mistake a user's manual zoom for srcy's automatic state.

## Review state and navigation

The dock changes from a latest-hunk preview to a complete review model. Review
state contains:

```ts
type ReviewScope = "turn" | "session" | "head";
type FollowMode = "follow" | "pinned";

interface ReviewPosition {
  scope: ReviewScope;
  mode: FollowMode;
  file?: string;
  fileIndex: number;
  hunkIndex: number;
  lineOffset: number;
}
```

Navigation clamps when files or hunks disappear. In follow mode, a new write
moves review to the latest modified file and its latest hunk. In pinned mode,
the selected path remains stable. If a pinned file disappears, review returns
to follow mode and says why for one frame.

The title always exposes state:

```text
REVIEW  TURN  FOLLOW  2/5 files  1/3 hunks  src/auth/session.ts
REVIEW  HEAD  PINNED  4/8 files  2/2 hunks  package.json
```

Diff rendering includes every hunk, its enclosing function when Git provides
one, new-side line numbers, additions, removals, context, binary or metadata
status, and rename/delete information. It does not attempt syntax highlighting
or word-level diffing in this release.

## Turn, session, and HEAD scopes

Three Git baselines answer three different questions:

- **TURN:** changes since the newest user request or manual checkpoint.
- **SESSION:** changes since srcy launched this session.
- **HEAD:** all uncommitted work against `HEAD`, including staged changes.

Baselines are Git tree objects created without touching the real index:

1. Copy the current Git index to a temporary index path.
2. Run `git add -A` with `GIT_INDEX_FILE` pointing to the copy.
3. Run `git write-tree` against that temporary index.
4. Store the resulting tree ID in the session snapshot.
5. Remove the temporary index.

Git may retain unreachable blob/tree objects until normal garbage collection;
the worktree and real index remain unchanged. If baseline creation fails, the
scope is unavailable and the UI explains the failure. It never silently falls
back to `HEAD` while labelled TURN or SESSION.

Claude and Codex adapters expose a stable user-turn marker. A new marker creates
a turn baseline before subsequent repository changes are observed. Unsupported
agents use the manual `c` checkpoint. Session baseline creation occurs before
the agent command begins whenever possible; if the session is reattached, the
stored baseline is reused.

## Goal and acceptance state

The goal comes from two sources, in priority order:

1. `.srcy/task.md`, if it exists and parses.
2. The latest user message exposed by a supported transcript adapter.

The task file format is intentionally small:

```markdown
# Goal

Reject tokens that expire at the current instant.

## Acceptance

- [ ] Boundary behavior has a regression test
- [ ] All configured gates pass
```

Only Markdown task-list items under `## Acceptance` are acceptance criteria.
srcy does not invent or semantically infer criteria. Checked items display as
declared complete; unchecked items remain pending. Gate evidence may be shown
beside a criterion only when the criterion explicitly names a gate using
``gate:<name>``. Otherwise srcy does not claim the criterion is verified.

If no acceptance list exists, the rail says `acceptance not declared` rather
than `0/0` or `passing`.

## Attention state

Transcript adapters expose evidence sufficient for a conservative state:

```ts
type Attention = "idle" | "thinking" | "working" | "ready" | "needs_input";
```

- `working`: at least one tool call is open.
- `thinking`: a user turn is newer than any completed assistant response.
- `ready`: a completed assistant response is newer than the latest user turn.
- `needs_input`: only when the adapter format explicitly records a permission
  or input request.
- `idle`: no active or completed turn is known.

Unsupported agents display `telemetry unavailable for <agent>` instead of
claiming there is no plan or no activity. REPO, GATES, APP, and REVIEW continue
to work because they do not depend on transcript telemetry.

When notifications are enabled, the rail emits one terminal bell on transitions
to `ready`, `needs_input`, or a newly failing gate set. It does not repeatedly
ring on polling ticks.

## Gate configuration and execution

`.srcy/config.json` adds optional structured configuration:

```json
{
  "gates": [
    {
      "name": "typecheck",
      "command": ["npm", "run", "typecheck"],
      "auto": true,
      "timeoutMs": 120000
    },
    {
      "name": "unit",
      "command": ["npm", "test"],
      "auto": false
    }
  ],
  "runtime": {
    "command": ["npm", "run", "dev"],
    "url": "http://localhost:3000",
    "autoStart": false
  },
  "notify": true
}
```

Validation rules:

- Gate names are non-empty, unique, printable single-line labels.
- Commands are non-empty argv arrays. Shell strings are rejected.
- `timeoutMs` is positive and capped at ten minutes.
- Unknown fields are ignored for forward compatibility.
- A malformed config is reported in GATES or APP; it never crashes a panel.

Compatibility order when `gates` is absent:

1. An executable `.srcy/check` becomes one automatic gate named `check`.
2. An npm `typecheck` script becomes one automatic gate named `typecheck`.
3. An npm `build` script becomes one automatic gate named `build`.
4. Otherwise GATES says `none configured`.

Automatic gates run after the existing quiet period and only once per repository
fingerprint. Manual gates run on request. Gates run sequentially to avoid CPU
and output contention. Each result records command, status, duration, problems,
tail, measured fingerprint, and start/finish time.

The rail summary distinguishes:

```text
GATES  2/4 passing
  check      running 4.2s
  unit       failing
  e2e        not run
  visual     stale
```

The dock prints full messages for the reviewed file before diff content, as it
does today. A gate timing out kills its process group and reports a failure.

## Runtime surface

Runtime support exists only when `runtime.command` is configured. It never
guesses a command and never starts an unconfigured process.

- `autoStart: true` starts it after panels are ready.
- Otherwise `s` explicitly starts it from the rail.
- A second `s` sends SIGTERM to the process group, waits briefly, then SIGKILLs
  only if necessary.
- Agent exit or srcy session teardown stops the owned runtime.
- The latest non-empty output lines are retained in a bounded ring buffer.
- Lines matching `error`, `exception`, `fatal`, or a stack frame are surfaced
  as recent runtime errors but are not converted into gate failures.
- The configured URL is rendered with an OSC 8 hyperlink when supported and as
  plain text otherwise. srcy does not automatically open a browser.

Runtime states are `not configured`, `stopped`, `starting`, `running`, `failed`,
and `stopping`. Unexpected exit includes the exit code and recent output.

## Repository modes, search, and risk summary

Tree modes are pure filters over the existing project tree:

- `CHANGED`: changed files plus ancestors.
- `FAILING`: files named by fresh failing gates plus ancestors.
- `ALL`: current behavior, with change paths automatically opened.

Search applies after the mode filter and performs case-insensitive substring
matching on repository-relative paths. Matching files and their ancestors stay
visible. Search never shells out and does not modify manual directory overrides.

The deterministic risk summary contains total files and churn plus zero or more
path-derived signals:

- tests added or no changed test file,
- delete or rename,
- lockfile,
- migration,
- configuration,
- binary asset,
- generated-looking path,
- secret-like filename,
- large change threshold.

It describes review attention, not security findings. Example:

```text
5 files  +84 -21  tests +1  ! migration  lockfile
```

The summary never claims a vulnerability, safety, or adequate coverage.

## Session snapshot

The current shared file becomes a versioned snapshot:

```ts
interface SessionSnapshotV1 {
  version: 1;
  review: ReviewPosition;
  baselines: { session?: string; turn?: string; turnMarker?: string };
  goal?: GoalState;
  attention: AttentionState;
  gates: GateState[];
  runtime?: RuntimeState;
  risks: RiskSummary;
  tree: { mode: "changed" | "failing" | "all"; query: string };
}
```

Writes remain whole-file-plus-rename. Readers reject unknown major versions and
retain their last good state. Snapshot fields use bounded strings and arrays so
logs or error output cannot grow the file without limit.

## Error handling and safety

- Repository and transcript poll errors retain the last truthful frame.
- Configuration errors are visible and disable only the affected subsystem.
- Gate and runtime child processes have separate process groups and bounded
  output.
- Baseline failures disable only the unavailable review scope.
- Snapshot parse errors retain the previous in-memory state.
- Review navigation clamps after every repository update.
- No command is constructed through a shell unless an existing project-owned
  executable is invoked directly.
- No source-control command touches the real index, creates commits, or changes
  the worktree.
- No destructive review action, staging, committing, or automatic revert is in
  scope.

## File boundaries

New production modules:

- `src/config.ts`: parse and validate `.srcy/config.json` with fallbacks.
- `src/scopes.ts`: create Git baseline trees and produce scoped repository state.
- `src/gates.ts`: define, schedule, execute, and summarize multiple gates.
- `src/runtime.ts`: own the configured development process and bounded logs.
- `src/task.ts`: parse `.srcy/task.md` and normalize goal state.
- `src/risk.ts`: classify deterministic review signals.
- `src/review.tsx`: review reducer, navigation, and complete diff rendering.
- `src/help.tsx`: rail and review help overlays.
- `src/session.ts`: versioned atomic snapshot storage.

Existing modules modified:

- `src/transcript.ts`, `src/codex.ts`: turn, goal, response, and attention events.
- `src/panels.tsx`: compose the rail subsystems and host interactive states.
- `src/tmux.ts`: responsive layout and prefixed pane-mode bindings.
- `src/repo.ts`: accept a base tree and expose change metadata.
- `src/diff.ts`: retain delete, rename, and mode metadata.
- `src/cockpit.tsx`: reuse shared formatting primitives; retire superseded preview
  rendering only after callers move.
- `src/index.ts`: baseline/runtime lifecycle wiring where tmux ownership requires
  it.
- `scripts/preview-shell.ts`, `scripts/demo.ts`, `README.md`: document and render
  the completed behavior.

No existing production file or capability is deleted.

## Testing strategy

Every behavior is developed red-green-refactor. Pure state transitions are
tested without tmux or timers; process and Git behavior use temporary
repositories and short real commands.

Test areas:

1. Review navigation clamps, follow/pin transitions, disappearing files, all
   scopes, and complete hunk rendering.
2. Baseline creation leaves the worktree and real index byte-for-byte unchanged
   while including staged, unstaged, untracked, deleted, and renamed files.
3. Gate config validation, fallback compatibility, quiet scheduling, sequential
   execution, timeout cleanup, stale results, and output bounds.
4. Task parsing, absent acceptance, explicit gate evidence, and malformed files.
5. Transcript attention state and unsupported-agent telemetry.
6. Runtime start, stop, unexpected exit, bounded logs, and cleanup.
7. Tree modes, search behavior, manual-directory overrides, and risk signals.
8. tmux layout planning at 60, 80, 118, and 160 columns, including preservation
   of user zoom.
9. Session snapshot versioning, atomic writes, size bounds, and corrupt reads.
10. Full preview captures for normal, compact, passing, failing, pinned, and
    unsupported-agent states.

The final verification gate is:

- complete test suite,
- TypeScript typecheck,
- production build,
- normal and compact preview inspection,
- Git status and diff review,
- README command/key accuracy check.

## Delivery slices

1. Interactive complete review with visible follow/pin state.
2. TURN, SESSION, and HEAD baselines plus manual checkpoints.
3. Multi-gate configuration and execution with backward compatibility.
4. Goal, acceptance, attention, notifications, and honest unsupported telemetry.
5. Configured runtime ownership and status.
6. Tree filters, search, risks, and contextual help.
7. Compact tmux modes and responsive previews.
8. Documentation, demo, cleanup, and full verification.

Each slice must leave the product working and the full suite green before the
next begins.

## Acceptance criteria

- A reviewer can inspect every changed file and hunk without leaving srcy.
- FOLLOW and PINNED are visible and reversible.
- TURN, SESSION, and HEAD show honestly distinct diffs without modifying the
  real Git index or worktree.
- Multiple gates expose not-run, running, stale, passing, failing, and timeout
  states, while existing `.srcy/check` projects continue to work unchanged.
- GOAL and declared acceptance remain visible; srcy never invents criteria.
- Supported agents expose evidence-based attention; unsupported agents say
  telemetry is unavailable.
- A configured runtime can be started, observed, and stopped without leaking a
  child process.
- CHANGED, FAILING, ALL, search, risk summary, and help are keyboard accessible.
- A 60-column terminal starts with a readable agent view and provides prefixed
  access to rail and review modes.
- No new permanent pane, embedded chat, model picker, automatic staging,
  automatic commit, or automatic browser launch is introduced.
- Tests, typecheck, build, and normal/compact previews pass at handoff.

