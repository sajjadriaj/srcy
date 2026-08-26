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
- The rail is the single authoritative state writer. It publishes a versioned,
  atomically-written session snapshot in the temporary directory.
- Interactive panels send small commands to the rail through a per-session
  intent spool directory. Each intent carries a session ID, writer PID, local
  sequence, creation time, and bounded payload. A panel writes one temporary
  file and atomically renames it to `<time>-<pid>-<sequence>.json`; no process
  truncates or rewrites another process's mailbox.

There will be no central daemon. Focused pure modules will isolate configuration,
Git scopes, gate execution, runtime lifecycle, task parsing, review navigation,
and risk classification. The rail remains the owner of expensive or mutating
work such as gates, baselines, and the configured runtime. The dock reads
snapshots and repository state, applies navigation optimistically for immediate
feedback, and emits an intent. The next authoritative snapshot confirms or
clamps that position. Rapid commands cannot overwrite unrelated gate, runtime,
or review state because panels never rewrite the snapshot.

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
 [/] hunk | n/p file | f follow | 1/2/3 scope | ? help
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
- `g`: move focus from REPO to GATES; `j` and `k` then move the gate cursor;
  `Escape` returns focus to REPO.
- `r` or `Enter` while GATES has focus: run the selected gate.
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

Initial review state is TURN plus FOLLOW when an exact automatic turn baseline
is available. Otherwise it is HEAD plus FOLLOW. FOLLOW starts on the most
recently modified changed file and its latest hunk; a clean scope has no file or
hunk position.

Empty and unavailable states are explicit:

```text
REVIEW  HEAD  clean -- nothing to review
REVIEW  TURN  unavailable -- press c before the next change
REVIEW  SESSION  unavailable -- session baseline could not be created
REVIEW  TURN  FOLLOW -- pinned file disappeared
```

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

Claude and Codex adapters expose a stable user-turn marker plus every tool start
after it. Tools are conservative: only calls the adapter explicitly classifies
as read-only (for example file reads, search, listing, and inspection) are safe.
Shell/exec calls, extension tools, unknown tools, edit/write/patch calls, and
notebook operations are mutation-capable. The transcript is watched for appends
rather than waiting for the normal repository poll.

When a new marker is observed with no mutation-capable tool after it, the rail
records both the transcript position and repository fingerprint, snapshots the
current tree, then immediately re-reads the transcript and repository. TURN is
accepted only if no mutation-capable tool started during capture and the before
and after fingerprints match. Otherwise the new tree object is discarded and
TURN is unavailable.

If the first observation already contains a mutation-capable tool after the marker,
srcy cannot prove that the tree is still the pre-turn tree. TURN is therefore
labelled unavailable instead of absorbing early edits into a dishonest
baseline. The user may press `c` before the next change to establish an exact
manual checkpoint. Unsupported agents always use `c`. Session baseline creation
occurs synchronously before the agent command begins; an attached session reuses
its stored baseline.

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

If `.srcy/task.md` is unreadable or contains an Acceptance section with malformed
task-list syntax, GOAL shows a one-line task-file error and falls back to the
latest supported transcript goal. Acceptance becomes unavailable; partially
parsed criteria are not shown.

## Attention state

Transcript adapters expose evidence sufficient for a conservative state:

```ts
type Attention = "idle" | "thinking" | "working" | "ready" | "needs_input";
```

The precedence is strict: `needs_input` > `working` > `thinking` > `ready` >
`idle`.

- `needs_input`: the adapter explicitly records a permission or input request,
  even if the corresponding tool call remains open.
- `working`: at least one tool call is open and no input request is present.
- `thinking`: a user turn is newer than any completed assistant response and no
  tool or input request is open.
- `ready`: a completed assistant response is newer than the latest user turn.
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
- Configured gates default to `auto: false` and `timeoutMs: 120000`.
- Runtime defaults to `autoStart: false`; notifications default to `false`.

Compatibility order when `gates` is absent:

1. An executable `.srcy/check` becomes one automatic gate named `check`.
2. An npm `typecheck` script becomes one automatic gate named `typecheck`.
3. An npm `build` script becomes one automatic gate named `build`.
4. Otherwise GATES says `none configured`.

Automatic gates run after the existing quiet period and only once per repository
fingerprint. Manual gates run on request. Gates run sequentially to avoid CPU
and output contention. Each result records command, status, duration, problems,
tail, measured fingerprint, and start/finish time.

The canonical gate status is one of `not_run`, `queued`, `running`, `pass`,
`fail`, `timeout`, or `stale`. Timeout is distinct in the UI and counts as
needing attention; it is not rewritten to `fail`. A result becomes stale when
its measured fingerprint differs from the current repository fingerprint.

The summary numerator is the number of fresh `pass` results; the denominator is
the number of configured gates. The rail distinguishes:

```text
GATES  1/4 passing  2 need attention
  check      passing 1.3s
  unit       running 4.2s
  e2e        not run
  visual     timeout
```

The dock prints full messages for the reviewed file before diff content, as it
does today. A gate timing out kills its process group and reports `timeout`.

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
path-derived signals. Matching is case-insensitive on POSIX-normalized paths:

- **tests:** basename contains `.test.`, `.spec.`, `_test.`, or path contains a
  `test` or `tests` segment; report `tests +N` or `no tests changed`.
- **delete/rename:** comes from parsed Git diff metadata.
- **lockfile:** basename is `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`,
  `Cargo.lock`, `poetry.lock`, or `go.sum`.
- **migration:** path contains a `migration` or `migrations` segment.
- **configuration:** basename starts with `.env`, or matches common project
  config suffixes/names such as `package.json`, `tsconfig*.json`, `*.config.*`,
  `Dockerfile`, or workflow files under `.github/workflows`.
- **binary asset:** the Git diff is binary.
- **generated-looking:** path contains `generated`, `gen`, `dist`, `build`, or
  `vendor` as a complete segment.
- **secret-like:** basename starts with `.env`, contains `secret` or
  `credential`, or ends with `.pem` or `.key`. Example/template suffixes remain
  flagged because they still deserve review; the signal is not an accusation.
- **large change:** more than 20 files or more than 500 added-plus-removed lines.

It describes review attention, not security findings. Example:

```text
5 files  +84 -21  tests +1  ! migration  lockfile
```

The summary never claims a vulnerability, safety, or adequate coverage.

## Session snapshot

The current shared file becomes a versioned snapshot written only by the rail:

```ts
interface SessionSnapshotV1 {
  version: 1;
  sessionId: string;
  intentAck: Record<string, number>; // highest reduced sequence by writer PID
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

Panel-to-rail intents use the separate spool directory. The rail lists complete
`.json` files and orders them by creation time, then PID and per-writer sequence.
It reduces only intents whose `(pid, sequence)` exceed the acknowledgement map
stored in the current snapshot. The new acknowledgement map and the intents'
effects are published in the same atomic snapshot write; only then may those
intent files be deleted.

If the rail crashes before snapshot publication, the files replay. If it crashes
after publication but before deletion, the acknowledgement map makes replay a
no-op and the files are deleted on recovery. A brand-new session removes a
spool carrying a different session ID; reattach reuses the matching spool.

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
