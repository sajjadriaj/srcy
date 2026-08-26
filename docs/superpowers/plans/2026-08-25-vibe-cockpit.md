# Vibe Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn srcy into a complete, truthful supervision loop with full diff review, turn/session scopes, multi-gate verification, goal and attention state, configured runtime status, repository filters and risks, and a readable compact layout.

**Architecture:** Keep the native agent and existing tmux workbench. The rail remains the sole orchestrator and snapshot writer; panels send idempotent intent files through a per-session spool. New behavior lives in focused pure modules, with process and Git boundaries tested in temporary repositories.

**Tech Stack:** TypeScript 7, Node.js 20+, React 19, Ink 7, tmux, Git, `node:test`, `ink-testing-library`.

---

## File map

New production files:

- `src/model.ts` — shared serializable contracts used by session, review, gates,
  task, runtime, risk, and panel modules.
- `src/session.ts` — versioned snapshots and acknowledged intent spool.
- `src/review.tsx` — review reducer, navigation, titles, and complete diff rendering.
- `src/scopes.ts` — temporary-index Git tree capture and scoped diffs.
- `src/config.ts` — `.srcy/config.json` parsing, defaults, and compatibility fallback.
- `src/gates.ts` — gate scheduling, process execution, status, and summaries.
- `src/task.ts` — `.srcy/task.md` goal and acceptance parsing.
- `src/runtime.ts` — configured runtime lifecycle and bounded logs.
- `src/risk.ts` — deterministic change-risk classification.
- `src/help.tsx` — compact contextual key help.

New tests:

- `test/session.test.ts`
- `test/review.test.tsx`
- `test/scopes.test.ts`
- `test/config.test.ts`
- `test/gates.test.ts`
- `test/task.test.ts`
- `test/runtime.test.ts`
- `test/risk.test.ts`

Existing files modified:

- `src/diff.ts`, `src/repo.ts`, `src/cockpit.tsx`, `src/tree.ts`
- `src/transcript.ts`, `src/codex.ts`
- `src/panels.tsx`, `src/tmux.ts`, `src/index.ts`
- `test/diff.test.ts`, `test/transcript.test.tsx`, `test/shell.test.tsx`
- `scripts/preview-shell.ts`, `scripts/demo.ts`, `README.md`

No production file is deleted. Do not add runtime dependencies.

## Execution rules

- Follow `@superpowers:test-driven-development` for every behavior.
- Run each named test once before implementation and confirm the expected failure.
- Use `apply_patch` for edits.
- Keep the current glyph-width discipline: every fixed-layout glyph must be
  verified with `get-east-asian-width`.
- Never mutate the real Git index in scope tests or implementation.
- After each task, run its focused test plus `npm run typecheck` before commit.
- After every third task, run the complete `npm test` suite.

---

### Task 1: Versioned session snapshot and lossless intent spool

**Files:**

- Create: `src/model.ts`
- Create: `src/session.ts`
- Create: `test/session.test.ts`
- Modify: `src/panels.tsx` only after the transport tests pass

- [ ] **Step 1: Write failing tests for snapshot versioning and atomic reads**

```ts
test("a corrupt snapshot leaves the last good value intact", async (t) => {
  const dir = await tempDir(t);
  const store = new SessionStore(dir, "s1");
  await store.publish(emptySnapshot("s1"));
  const good = await store.read();
  await writeFile(store.snapshotPath, "{");
  assert.deepEqual(await store.read(good), good);
});

test("a reader rejects another session and a future major version", async (t) => {
  // publish raw fixtures and assert read() returns the supplied last-good state
});

test("oversized intent and snapshot fields are rejected before writing", async (t) => {
  const store = new SessionStore(await tempDir(t), "s1");
  await assert.rejects(store.emit(intentWithPayload("x".repeat(MAX_INTENT_BYTES + 1))));
  await assert.rejects(store.publish(snapshotWithGoal("x".repeat(MAX_TEXT_BYTES + 1))));
});

test("bounded log and result arrays are clipped deterministically", async (t) => {
  // publish MAX_ITEMS + 1 entries and assert the newest MAX_ITEMS survive
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npx tsx --test test/session.test.ts`

Expected: FAIL because `src/session.ts` does not exist.

- [ ] **Step 3: Implement shared contracts, bounds, and atomic publish/read**

Create `src/model.ts` first so Task 1 can typecheck without importing modules
that do not exist yet. It owns data-only types and no behavior:

```ts
export interface IntentAck { [pid: string]: number }
export interface BaselineState {
  tree?: string;
  unavailable?: string;
}
export interface SessionSnapshotV1 {
  version: 1;
  sessionId: string;
  intentAck: IntentAck;
  review: ReviewPosition;
  baselines: {
    session: BaselineState;
    turn: BaselineState & { marker?: string };
  };
  goal?: GoalState;
  attention: AttentionState;
  gates: GateState[];
  runtime?: RuntimeState;
  risks: RiskSummary;
  tree: { mode: TreeMode; query: string };
}
```

Define minimal serializable `ReviewPosition`, `GoalState`, `AttentionState`,
`GateState`, `RuntimeState`, `RiskSummary`, `TreeMode`, `BaselineState`, and
`PanelIntent` in `model.ts`. Later tasks extend behavior around these stable
shapes rather than redeclaring them.

Then implement behavior in `src/session.ts`:

```ts

export class SessionStore {
  publish(snapshot: SessionSnapshotV1): Promise<void>;
  read(lastGood?: SessionSnapshotV1): Promise<SessionSnapshotV1 | undefined>;
  emit(intent: PanelIntent): Promise<void>;
  consume(snapshot: SessionSnapshotV1): Promise<{
    snapshot: SessionSnapshotV1;
    consumed: string[];
  }>;
  acknowledge(snapshot: SessionSnapshotV1, consumed: string[]): Promise<void>;
}
```

Use same-directory temporary files plus `rename`. Bound each intent payload to
4 KB and all snapshot text fields/log arrays to constants exported for tests.

- [ ] **Step 4: Write failing crash-point and ordering tests**

Cover:

- two writers emitting concurrently produce two unique files;
- per-writer sequence order is retained;
- crash before publish replays intents;
- crash after publish but before delete skips acknowledged intents;
- an intent appended during consumption remains for the next consume;
- a spool from another session ID is removed only on new-session initialization.
- oversized intent files are quarantined with a bounded visible error rather
  than parsed or acknowledged.

- [ ] **Step 5: Run the focused test and verify RED for spool behavior**

Run: `npx tsx --test test/session.test.ts`

Expected: new spool tests FAIL with missing or incorrect consume semantics.

- [ ] **Step 6: Implement acknowledged intent reduction and cleanup**

Sort by `createdAt`, PID, sequence. Publish effects and updated `intentAck` in
one snapshot before deleting acknowledged files. Make duplicate navigation
intents no-ops based on the acknowledgement map.

- [ ] **Step 7: Verify GREEN and compatibility**

Run: `npx tsx --test test/session.test.ts test/shell.test.tsx`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/model.ts src/session.ts src/panels.tsx test/session.test.ts test/shell.test.tsx
git commit -m "feat: add reliable panel session state"
```

---

### Task 2: Complete diff review reducer and renderer

**Files:**

- Create: `src/review.tsx`
- Create: `test/review.test.tsx`
- Modify: `src/diff.ts`
- Modify: `test/diff.test.ts`
- Modify: `src/cockpit.tsx`

- [ ] **Step 1: Write failing metadata tests**

Add fixtures for deletion, rename, mode-only change, binary change, and multiple
hunks. Assert `FileDiff` exposes:

```ts
interface FileDiff {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed" | "binary" | "mode";
  hunks: Hunk[];
  // existing header/binary/renameFrom fields remain during migration
}
```

- [ ] **Step 2: Verify metadata tests fail**

Run: `npx tsx --test test/diff.test.ts`

Expected: FAIL because `status` and `oldPath` are absent.

- [ ] **Step 3: Implement minimal diff metadata parsing**

Derive status only from Git headers already retained by `splitDiff`. Preserve
path quoting behavior and the byte-identical hunk body.

- [ ] **Step 4: Write failing reducer tests**

```ts
test("follow tracks the newest file while pin remains stable", () => {
  const files = fixtureDiffs("a.ts", "b.ts");
  const followed = reduceReview(initialReview(), { type: "repo", files, newest: "b.ts" });
  assert.equal(followed.file, "b.ts");
  const pinned = reduceReview(followed, { type: "pin", path: "a.ts" });
  assert.equal(reduceReview(pinned, { type: "repo", files, newest: "b.ts" }).file, "a.ts");
});

test("a disappearing pin returns to follow with a one-frame reason", () => {});
test("file, hunk, and line navigation clamp at both ends", () => {});
test("changing scope resets to follow on the newest file", () => {});
```

- [ ] **Step 5: Verify reducer tests fail**

Run: `npx tsx --test test/review.test.tsx`

Expected: FAIL because `src/review.tsx` does not exist.

- [ ] **Step 6: Implement only the pure review reducer**

Export `initialReview` and `reduceReview`. Keep all clamping pure and path-based.
Do not implement title or line rendering until Step 7 has failed.

- [ ] **Step 7: Write failing renderer tests**

First test `reviewTitle` against the spec's clean, unavailable, FOLLOW, and
PINNED states. Then render a two-hunk file and assert both hunk function names,
new-side line numbers (including replacement/removal numbering), addition and
removal signs, and navigable context lines exist when the viewport moves. Assert
binary, delete, rename, and mode-only states have truthful labels.

- [ ] **Step 8: Implement `reviewTitle`, `reviewLines`, and `ReviewPane`**

Render only the requested viewport, but build it from a complete flattened diff
model. Use the existing green/red/dim language. Keep `LiveDiff` until all callers
move; do not delete it in this task.

- [ ] **Step 9: Verify GREEN**

Run: `npx tsx --test test/diff.test.ts test/review.test.tsx test/cockpit.test.tsx`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/review.tsx src/diff.ts src/cockpit.tsx test/review.test.tsx test/diff.test.ts test/cockpit.test.tsx
git commit -m "feat: make the dock a complete diff reviewer"
```

---

### Task 3: Interactive dock, pin/follow, and help

**Files:**

- Create: `src/help.tsx`
- Modify: `src/panels.tsx`
- Modify: `test/shell.test.tsx`

- [ ] **Step 1: Write failing panel interaction tests**

Using `ink-testing-library`, assert:

- `n/p`, `[/]`, arrows, page keys, and `g/G` emit the correct review intents;
- `f` emits follow and changes the title from PINNED to FOLLOW;
- `1/2/3` emit scope intents;
- rail `c` emits a manual-checkpoint intent and shows `capturing checkpoint`
  until the authoritative snapshot responds;
- `?` replaces the diff body with contextual dock help and `Escape` closes it;
- rail `Enter` emits a pin intent and rail `f` emits follow;
- input handlers are inactive when `interactive={false}`.

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test test/shell.test.tsx`

Expected: FAIL because Dock is not interactive and no intents are emitted.

- [ ] **Step 3: Implement intent-backed interactions**

Add an injected `emitIntent` callback to Rail and Dock for tests; production uses
`SessionStore.emit`. Dock keeps optimistic local review state until the next
snapshot. Guard every key by help/search/focus mode.

- [ ] **Step 4: Implement focused help overlays**

`src/help.tsx` exports `RailHelp` and `ReviewHelp`. Help is plain text, clipped to
the pane, with no modal chrome and no motion.

- [ ] **Step 5: Verify GREEN and run the full suite**

Run: `npx tsx --test test/review.test.tsx test/shell.test.tsx`

Expected: PASS.

Run: `npm test`

Expected: all tests PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/help.tsx src/panels.tsx test/shell.test.tsx
git commit -m "feat: add keyboard-driven review controls"
```

---

### Task 4: Exact Git baselines and scoped repository state

**Files:**

- Create: `src/scopes.ts`
- Create: `test/scopes.test.ts`
- Modify: `src/repo.ts`
- Modify: `test/shell.test.tsx`

- [ ] **Step 1: Write failing baseline safety tests**

Create a temporary repository with staged, unstaged, untracked, deleted, and
renamed paths. Save the real index bytes and porcelain status, call
`captureTree`, then assert both are byte-for-byte unchanged.

```ts
const beforeIndex = await readFile(join(repo, ".git/index"));
const beforeStatus = await git(repo, "status", "--porcelain", "-uall");
const tree = await captureTree(repo);
assert.deepEqual(await readFile(join(repo, ".git/index")), beforeIndex);
assert.equal(await git(repo, "status", "--porcelain", "-uall"), beforeStatus);
assert.match(tree, /^[0-9a-f]{40}$/);
```

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test test/scopes.test.ts`

Expected: FAIL because `captureTree` does not exist.

- [ ] **Step 3: Implement temporary-index capture with cleanup**

Resolve the actual Git index path using `git rev-parse --git-path index` so
worktrees work. Copy it when present; otherwise create an empty temporary index
with `git read-tree --empty`. Run `git add -A` and `git write-tree` with only the
child's `GIT_INDEX_FILE` overridden. Remove lock/temp files in `finally`.

- [ ] **Step 4: Write failing scoped-diff tests**

Assert `repoState(repo, problems, tree)` reports only changes since that tree,
while the default still compares with HEAD. Cover clean scopes and an invalid
tree with a typed unavailable result. Include this regression:

1. create an untracked file;
2. capture it into the baseline tree;
3. assert the unchanged file is absent from the scoped diff;
4. modify it and assert only the post-baseline edit appears.

- [ ] **Step 5: Implement tree-to-tree scoped state in `repoState`**

For TURN and SESSION, capture a current temporary tree and run
`git diff <baseTree> <currentTree>` so paths untracked at baseline are treated
as baseline content. Keep the existing HEAD implementation and explicit
untracked handling as the zero-cost default. Do not silently replace a failed
requested tree with HEAD. Return or throw a typed `ScopeUnavailable` consumed by
the rail.

- [ ] **Step 6: Write failing TURN race tests**

Inject transcript and fingerprint probes into `captureTurn`. Cover:

- read-only tool during capture accepts;
- shell/unknown/edit tool during capture rejects;
- repository fingerprint change during capture rejects;
- mutation already present after marker rejects;
- rejected capture never overwrites the previous honest turn baseline.
- a manual checkpoint captures the current tree exactly and replaces TURN only
  after capture succeeds.

- [ ] **Step 7: Implement `captureTurn` validation**

Record marker/adapter offset and fingerprint before capture. Re-read both after
capture. Treat only an explicit read-only allow-list as safe.

Export `captureManualCheckpoint(repo)` as the direct exact-tree path used by the
rail's `checkpoint` intent. It has no transcript precondition; failure preserves
the previous TURN baseline and publishes an unavailable reason.

- [ ] **Step 8: Verify GREEN**

Run: `npx tsx --test test/scopes.test.ts test/shell.test.tsx`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/scopes.ts src/repo.ts test/scopes.test.ts test/shell.test.tsx
git commit -m "feat: review turn and session scoped changes"
```

---

### Task 5: Transcript goal, turn marker, and attention evidence

**Files:**

- Modify: `src/transcript.ts`
- Modify: `src/codex.ts`
- Modify: `test/transcript.test.tsx`
- Modify: `test/shell.test.tsx`

- [ ] **Step 1: Write failing Claude fold tests**

Extend `Fold` expectations with:

```ts
interface Telemetry {
  goal?: string;
  turnMarker?: string;
  turnAt?: number;
  completedAt?: number;
  inputRequested: boolean;
  toolsAfterTurn: { name: string; readOnly: boolean; at?: number }[];
  attention: "idle" | "thinking" | "working" | "ready" | "needs_input";
}
```

Test strict precedence: needs_input > working > thinking > ready > idle. Ensure
subagent records cannot replace root goal or attention.

- [ ] **Step 2: Verify Claude tests fail**

Run: `npx tsx --test test/transcript.test.tsx test/shell.test.tsx`

Expected: FAIL because fold state lacks telemetry.

- [ ] **Step 3: Implement Claude evidence folding**

Bound goal to a named maximum; normalize whitespace without rewriting content.
Classify only known read/search/list tools as read-only. Preserve incremental
fold behavior and incomplete-line handling.

- [ ] **Step 4: Write failing Codex fixture tests**

Add JSONL records for user messages, completed response events, permission/input
events when present in the known schema, shell calls, read calls, and unknown
calls. Assert the same normalized Telemetry contract.

- [ ] **Step 5: Implement Codex telemetry folding**

Keep format-specific parsing in `src/codex.ts`; share pure attention precedence
helpers from `src/transcript.ts`.

- [ ] **Step 6: Add unsupported-agent rendering test**

Assert Rail with `source={null}` renders `telemetry unavailable for aider`, not
`(no plan)`, while REPO and gate state still render.

- [ ] **Step 7: Verify GREEN**

Run: `npx tsx --test test/transcript.test.tsx test/shell.test.tsx`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/transcript.ts src/codex.ts test/transcript.test.tsx test/shell.test.tsx
git commit -m "feat: expose goal and attention telemetry"
```

---

### Task 6: Configuration and multi-gate execution

**Files:**

- Create: `src/config.ts`
- Create: `src/gates.ts`
- Create: `test/config.test.ts`
- Create: `test/gates.test.ts`
- Modify: `src/checks.ts`
- Modify: `test/checks.test.ts`

- [ ] **Step 1: Write failing config validation tests**

Cover valid config, duplicate/empty gate names, shell-string rejection, empty
gate argv, gate timeout default/cap, configured `auto` default false, invalid
runtime independent of valid gates, invalid gates independent of valid runtime,
runtime/notify defaults, unknown fields, malformed JSON, and absent config.

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test test/config.test.ts`

Expected: FAIL because `loadConfig` does not exist.

- [ ] **Step 3: Implement validated config types**

Parse JSON once, then validate each subsystem independently:

```ts
interface ConfigResult {
  gates: SubsystemResult<GateConfig[] | undefined>;
  runtime: SubsystemResult<RuntimeConfig | undefined>;
  notify: SubsystemResult<boolean>;
}
type SubsystemResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
```

A JSON syntax/root-shape error produces an error for all three subsystems because
no field can be read. A field validation error disables only that field's
subsystem. Never throw for user configuration. Preserve argv elements verbatim
and cap display labels separately.

- [ ] **Step 4: Write failing compatibility tests**

Assert absent configured gates resolve in order to executable `.srcy/check`, npm
`typecheck`, npm `build`, or none. Keep existing `checkCommand` tests green by
adapting it as a compatibility wrapper around `resolveGates`.

- [ ] **Step 5: Implement fallback resolution**

Configured `gates: []` means deliberately none; absent `gates` invokes fallback.
Fallback gates are automatic and retain the existing 120-second timeout.

- [ ] **Step 6: Write failing scheduler and runner tests**

Cover canonical statuses `not_run`, `queued`, `running`, `pass`, `fail`,
`timeout`, `stale`; sequential execution; quiet fingerprint scheduling; duration;
problem parsing; bounded tail; process-group timeout; fresh-pass numerator; and
no duplicate automatic run for one fingerprint.

- [ ] **Step 7: Verify runner tests fail**

Run: `npx tsx --test test/gates.test.ts test/checks.test.ts`

Expected: FAIL because the gate engine is absent.

- [ ] **Step 8: Implement the gate engine**

Extract reusable `runCommand` behavior from `checks.ts` without changing error
parsing. Inject clock/spawn only at the narrow process boundary. Timeout must
remain distinct from fail.

- [ ] **Step 9: Verify GREEN and full suite**

Run: `npx tsx --test test/config.test.ts test/gates.test.ts test/checks.test.ts`

Expected: PASS.

Run: `npm test`

Expected: all tests PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/config.ts src/gates.ts src/checks.ts test/config.test.ts test/gates.test.ts test/checks.test.ts
git commit -m "feat: run truthful multi-stage gates"
```

---

### Task 7: Goal and acceptance task file

**Files:**

- Create: `src/task.ts`
- Create: `test/task.test.ts`
- Modify: `src/panels.tsx`
- Modify: `test/shell.test.tsx`

- [ ] **Step 1: Write failing parser tests**

Cover a goal with acceptance items, checked/unchecked items, explicit
``gate:<name>`` evidence, absent acceptance, malformed task-list syntax,
unreadable file, missing file, bounded goal text, and fallback transcript goal.

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test test/task.test.ts`

Expected: FAIL because `readTask` does not exist.

- [ ] **Step 3: Implement the line-oriented Markdown parser**

Parse only `# Goal`, `## Acceptance`, and `- [ ]`/`- [x]` items. Do not add a
Markdown dependency. Return `{goal, acceptance, error}` and keep partial malformed
acceptance hidden.

- [ ] **Step 4: Write failing `GoalPane` tests**

Assert declared counts, `acceptance not declared`, task error plus fallback goal,
and clipped long content. Gate evidence appears only for an explicitly named
gate and fresh matching gate result.

- [ ] **Step 5: Implement compact GOAL rendering**

Budget one goal row plus at most two acceptance rows in narrow mode. Put detail
in help/focused view rather than permanently growing the rail.

- [ ] **Step 6: Verify GREEN**

Run: `npx tsx --test test/task.test.ts test/shell.test.tsx`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/task.ts src/panels.tsx test/task.test.ts test/shell.test.tsx
git commit -m "feat: keep the requested outcome on screen"
```

---

### Task 8: Configured runtime ownership

**Files:**

- Create: `src/runtime.ts`
- Create: `test/runtime.test.ts`
- Modify: `src/panels.tsx`
- Modify: `test/shell.test.tsx`

- [ ] **Step 1: Write failing runtime lifecycle tests**

Use short real Node commands in a temporary repo. Cover not configured, start,
starting/running, duplicate start no-op, graceful stop, forced stop after grace,
unexpected exit, exit code, bounded non-empty log ring, error-line extraction,
and cleanup on owner disposal.

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test test/runtime.test.ts`

Expected: FAIL because `RuntimeOwner` does not exist.

- [ ] **Step 3: Implement `RuntimeOwner`**

```ts
export class RuntimeOwner {
  start(config: RuntimeConfig): Promise<void>;
  stop(): Promise<void>;
  dispose(): Promise<void>;
  state(): RuntimeState;
  subscribe(fn: (state: RuntimeState) => void): () => void;
}
```

Spawn argv directly with `cwd=repo` and `detached: true`, giving the runtime and
its descendants a process group separate from the rail. Stop and timeout send
signals to `-child.pid`, never to the rail's group. Register explicit
SIGINT/SIGTERM/exit cleanup; the normal tmux teardown path must kill the owned
group synchronously. Never open the configured URL automatically.

- [ ] **Step 4: Write failing APP pane tests**

Assert not configured collapses, stopped/running/failed states, URL text, recent
error count, and `s` start/stop intent. OSC 8 is emitted only for a TTY-capable
render helper; tests receive plain text.

- [ ] **Step 5: Implement APP rendering and rail ownership**

The rail owns exactly one runtime instance. Reattach reads status honestly; it
does not claim ownership of an unrelated process from a stale PID.

- [ ] **Step 6: Verify GREEN**

Run: `npx tsx --test test/runtime.test.ts test/shell.test.tsx`

Expected: PASS with no surviving child processes.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/runtime.ts src/panels.tsx test/runtime.test.ts test/shell.test.tsx
git commit -m "feat: supervise a configured development runtime"
```

---

### Task 9: Repository modes, search, and deterministic risks

**Files:**

- Create: `src/risk.ts`
- Create: `test/risk.test.ts`
- Modify: `src/tree.ts`
- Modify: `src/repo.ts`
- Modify: `src/panels.tsx`
- Modify: `test/shell.test.tsx`

- [ ] **Step 1: Write failing risk classifier tests**

Use table-driven cases for every exact spec pattern: test files, no tests,
delete, rename, six lockfiles, migration segment, config paths, binary,
generated path segments, secret-like basenames, and both large-change
thresholds. Assert risk ordering is stable and wording never says vulnerable,
safe, or covered.

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test test/risk.test.ts`

Expected: FAIL because `classifyRisks` does not exist.

- [ ] **Step 3: Implement pure risk classification and summary**

Export `classifyRisks(files)` and `riskLine(summary, width)`. Consume diff
metadata from Task 2; do not reparse raw Git output.

- [ ] **Step 4: Write failing tree mode and search tests**

Assert CHANGED includes only changed files/ancestors, FAILING only fresh problem
files/ancestors, ALL retains current behavior, query matching is case-insensitive,
ancestors remain, and manual open/closed overrides survive mode/query changes.

- [ ] **Step 5: Implement `filterTree` before flattening rows**

Keep `rows`' sorting contract. An empty query is no-op. A query with no results
renders one truthful row rather than an empty pane.

- [ ] **Step 6: Write failing rail input-state tests**

Test Tab mode cycling, `/` search entry, printable typing, backspace, Escape,
Enter, and suppression of normal `j/k/f/g` commands during search.

- [ ] **Step 7: Implement tree/search state and risk row**

The REPO label becomes `REPO [CHANGED]`, `REPO [FAILING]`, or `REPO [ALL]`.
Risk summary takes one row and disappears only for a clean scope.

- [ ] **Step 8: Verify GREEN and full suite**

Run: `npx tsx --test test/risk.test.ts test/shell.test.tsx`

Expected: PASS.

Run: `npm test`

Expected: all tests PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/risk.ts src/tree.ts src/repo.ts src/panels.tsx test/risk.test.ts test/shell.test.tsx
git commit -m "feat: focus repository review on what matters"
```

---

### Task 10: Integrate orchestration, gates, scopes, goal, attention, and notifications

**Files:**

- Modify: `src/panels.tsx`
- Modify: `src/index.ts`
- Modify: `src/tmux.ts`
- Modify: `test/shell.test.tsx`

- [ ] **Step 1: Write failing rail composition tests**

Render fixture snapshots for:

- automatic TURN available and selected;
- TURN unavailable falling back to HEAD;
- manual `c` checkpoint intent captures a new TURN tree, updates the snapshot,
  and preserves the previous tree on failure;
- GOAL plus plan plus GATES plus APP within the measured height budget;
- gate focus with `g`, `j/k`, `r`, Enter, Escape, and `R`;
- timeout, stale, running duration, and fresh-pass numerator;
- attention precedence and one-time bell transitions;
- unsupported agent telemetry alongside working repository/gates/review.
- malformed config renders its bounded message in GATES and APP while REPO,
  GOAL, REVIEW, and transcript telemetry continue to update;
- configured runtime with `autoStart: true` starts once after the rail is ready,
  while `false` remains stopped;
- fresh gate problems for the reviewed file render before dock diff content;
- the dock key footer appears only while focused or help is open.

Add orchestration-level tests with injected functions/clocks:

- `prepareLaunch` calls `captureTree` before `launch` on a new session;
- an existing session reattach calls neither capture nor launch and reuses its
  stored baseline;
- capture failure records `baselines.session.unavailable` before launch;
- `watchTranscript` invokes the incremental reader on an fs-watch wake-up;
- when no fs event arrives, the periodic fallback still invokes the reader;
- duplicate/coalesced wake-ups cannot create duplicate TURN markers.

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test test/shell.test.tsx`

Expected: integration fixtures FAIL because the rail still uses legacy Watched/check state.

- [ ] **Step 3: Refactor the rail watcher into explicit owners**

Keep one repository poll loop, one transcript watcher, one task watcher, one
GateEngine, one RuntimeOwner, and one SessionStore. Process panel intents before
publishing each snapshot. Recompute risks and scoped repository state only when
their fingerprints or scope change.

Reduce `checkpoint` intents by calling Task 4's exact manual capture. Route each
`SubsystemResult` independently: a gates error renders in GATES without blocking
a valid RuntimeOwner, and a runtime error renders in APP without blocking a valid
GateEngine. Whole-file JSON errors render bounded messages in both.

- [ ] **Step 4: Capture session baseline before agent launch**

In `src/index.ts`, create or load session storage and synchronously capture the
session tree before `launch`. Pass baseline/session paths to the rail panel argv.
If capture fails, store the unavailable reason without preventing launch.

- [ ] **Step 5: Add transcript append watching with poll fallback**

Use `fs.watch` as a wake-up signal only; the incremental reader remains the
authority. Retain the periodic poll for dropped/coalesced filesystem events.
Run the TURN before/after validation from Task 4.

- [ ] **Step 6: Start configured automatic runtime after readiness**

After the first valid snapshot has been published and watchers are active, call
`RuntimeOwner.start` once when `autoStart` is true. Reattach must not duplicate a
runtime already owned by the live rail. Start failure updates APP and leaves
other subsystems running.

- [ ] **Step 7: Implement one-time notifications**

Default off. When enabled, emit BEL once per transition key for READY,
NEEDS_INPUT, or a new failing/timeout gate fingerprint. Never ring during tests
or non-TTY output.

- [ ] **Step 8: Remove legacy single-check orchestration after callers move**

Delete only dead functions within existing files, not production files. Keep
compatibility exports used by external tests unless replaced with documented
aliases.

- [ ] **Step 9: Verify GREEN**

Run: `npx tsx --test test/session.test.ts test/scopes.test.ts test/gates.test.ts test/task.test.ts test/runtime.test.ts test/risk.test.ts test/shell.test.tsx`

Expected: PASS.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/index.ts src/panels.tsx src/tmux.ts test/shell.test.tsx
git commit -m "feat: compose the complete vibe coding cockpit"
```

---

### Task 11: Compact tmux mode and responsive behavior

**Files:**

- Modify: `src/tmux.ts`
- Modify: `test/shell.test.tsx`
- Modify: `scripts/preview-shell.ts`

- [ ] **Step 1: Write failing breakpoint and binding tests**

Assert:

- 118/160 columns use the visible workbench;
- 80 columns use narrow visible workbench;
- 60 columns marks compact mode and initially zooms the agent;
- prefix `1/2/3` targets and zooms agent/rail/dock;
- automatic compact state is stored in a session option;
- resizing wide unzooms only an auto-zoom, not a manual zoom;
- existing mouse, focus-events, extended-keys, teardown, and focus tests remain.

- [ ] **Step 2: Verify RED**

Run: `npx tsx --test test/shell.test.tsx`

Expected: FAIL because no compact-mode plan/bindings exist.

- [ ] **Step 3: Implement pure layout mode selection**

```ts
export type LayoutMode = "wide" | "narrow" | "compact";
export const layoutMode = (cols: number): LayoutMode =>
  cols < 72 ? "compact" : cols < 100 ? "narrow" : "wide";
```

Add bindings only on srcy's private tmux server/session. Identify pane IDs after
splits, then bind prefix keys to `select-pane` plus zoom. Track automatic zoom
with `@srcy-auto-compact` and inspect `#{window_zoomed_flag}` during resize.

- [ ] **Step 4: Add compact preview output**

`PREVIEW_COLS=60 PREVIEW_ROWS=20 npm run preview` must capture the default
agent-only zoom plus separately capturable rail/review modes through a preview
environment selector; do not leave preview sessions running.

- [ ] **Step 5: Verify GREEN**

Run: `npx tsx --test test/shell.test.tsx`

Expected: PASS.

Run: `PREVIEW_COLS=60 PREVIEW_ROWS=20 PREVIEW_AGENT=codex npm run preview`

Expected: readable agent-focused compact output, exit 0.

Run: `PREVIEW_COLS=118 PREVIEW_ROWS=34 PREVIEW_AGENT=codex npm run preview`

Expected: complete wide cockpit, exit 0.

Run: `npm run typecheck`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/tmux.ts test/shell.test.tsx scripts/preview-shell.ts
git commit -m "feat: keep srcy readable in compact terminals"
```

---

### Task 12: Documentation, demos, cleanup, and final verification

**Files:**

- Modify: `README.md`
- Modify: `scripts/preview-shell.ts`
- Modify: `scripts/demo.ts`
- Modify: `docs/demo.cast`
- Modify: `docs/demo.gif` only if `agg` is available
- Modify: any source/test file only for issues revealed by verification, with a
  failing regression test first

- [ ] **Step 1: Update the preview fixture to exercise the real states**

Include goal, declared acceptance, TURN scope, PINNED and FOLLOW titles,
multi-hunk changes, pass/fail/not-run/timeout gates, APP status, risks, and an
unsupported-agent variant. Fixture metrics must be internally derived, not
invented product claims.

- [ ] **Step 2: Rewrite README tables and keys**

Document:

- TURN/SESSION/HEAD and exact/unavailable semantics;
- `.srcy/task.md` and `.srcy/config.json` with copyable examples;
- rail, gate-focus, review, search, runtime, and compact prefix keys;
- gate and attention status meanings;
- runtime ownership and lack of automatic browser opening;
- compatibility with existing `.srcy/check`;
- unsupported telemetry honesty.

- [ ] **Step 3: Update the scripted demo**

The demo should show goal -> turn -> gate failure -> pin and navigate -> fix ->
fresh pass -> compact mode. Keep only the agent turn scripted; panels must still
read real Git/config/transcript state.

- [ ] **Step 4: Run documentation/preview consistency checks**

Search every rendered key and config field in source and README. Correct any
mismatch before recording artifacts.

Run: `rg -n "TURN|SESSION|HEAD|PINNED|FOLLOW|GATES|task.md|config.json|prefix" README.md src scripts`

Expected: every documented feature has a production implementation reference.

- [ ] **Step 5: Run the complete automated verification**

Run: `npm test`

Expected: all tests PASS, zero failures.

Run: `npm run typecheck`

Expected: exit 0.

Run: `npm run build`

Expected: exit 0 and executable `dist/src/index.js`.

- [ ] **Step 6: Inspect normal and compact previews**

Run: `PREVIEW_COLS=118 PREVIEW_ROWS=34 PREVIEW_AGENT=codex npm run preview`

Expected: no clipped labels, truthful states, usable review footer.

Run: `PREVIEW_COLS=80 PREVIEW_ROWS=24 PREVIEW_AGENT=codex npm run preview`

Expected: narrow workbench remains readable.

Run: `PREVIEW_COLS=60 PREVIEW_ROWS=20 PREVIEW_AGENT=codex npm run preview`

Expected: agent-focused compact mode; rail/review reachable through prefixed modes.

- [ ] **Step 7: Re-record demo artifacts**

Run: `npm run demo`

Expected: `docs/demo.cast` updated successfully.

If `agg` is available, run: `npm run demo:gif`

Expected: `docs/demo.gif` updated successfully. If unavailable, retain the prior
GIF and report that limitation without claiming it was regenerated.

- [ ] **Step 8: Run final repository checks**

Run: `git diff --check`

Expected: no output.

Run: `git status --short`

Expected: only intended source, test, docs, and generated demo changes before commit.

Review: `git diff --stat HEAD~12..HEAD` and each final uncommitted diff.

- [ ] **Step 9: Invoke `@superpowers:requesting-code-review`**

Dispatch an independent review against the approved spec. Resolve every critical
or important finding with a failing test first.

- [ ] **Step 10: Invoke `@superpowers:verification-before-completion`**

Re-run the complete test, typecheck, build, previews, and Git checks after review
fixes. Use only the fresh output in the final report.

- [ ] **Step 11: Commit**

```bash
git add README.md scripts/preview-shell.ts scripts/demo.ts docs/demo.cast docs/demo.gif src test
git commit -m "docs: explain the vibe coding cockpit"
```

- [ ] **Step 12: Invoke `@superpowers:finishing-a-development-branch`**

Present merge/PR/keep/cleanup options only after all verification succeeds.
