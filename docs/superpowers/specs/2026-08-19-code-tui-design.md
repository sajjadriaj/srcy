# code-tui: an agent cockpit

Date: 2026-08-19
Status: approved design, not yet implemented

## What this is

A terminal cockpit for running several coding agents at once. Not another
chat client — every vendor already ships a good one. The gap is what happens
when you run three agents in parallel: three terminals, three permission
prompts you babysit one at a time, three sets of edits landing in one working
tree, and no single place to review the result.

code-tui (`ctui`) is that single place. One screen shows every running
session, every pending approval, and the diff each session has produced.
Sessions are isolated in git worktrees so they cannot collide, and work lands
in your real tree only when you accept it, hunk by hunk.

## Non-goals

- Not a general terminal multiplexer. tmux exists.
- Not its own agent loop. It drives existing agents; it does not plan or call models.
- No plugin system, theme engine, web UI, or remote access in v1.
- No multi-user or shared-session support.

## Product decisions (settled)

| Decision | Choice |
|---|---|
| Shape | Cockpit / orchestrator, chat is a subordinate pane |
| Language | Go + Bubble Tea (bubbles, lipgloss, glamour) |
| Isolation | One git worktree + branch per session |
| First backend | Claude Code over ACP (`@zed-industries/claude-code-acp`) |
| Process model | Monolith — agents are child processes of the TUI |

Rationale for the monolith: one binary, one process tree, no IPC to debug.
The cost is real — killing the TUI kills in-flight agents — and is mitigated
by ACP session resume rather than by building a daemon now. Process spawning
sits behind a `Supervisor` interface so a detached daemon is a later swap, not
a rewrite.

## Architecture

```
ctui/
  main.go
  app/          bubbletea root model, layout, keymap, focus
  agent/        Adapter interface + acp/ implementation
  supervisor/   spawn, health, resume, kill
  worktree/     create / list / apply / destroy
  review/       diff model, hunk selection, patch build
  approval/     cross-session permission queue + rules
  store/        session log (JSONL), config, rules
```

Each package has one job and a narrow surface. `app` is the only package that
imports Bubble Tea; everything below it is plain Go and testable without a
terminal.

### Data flow

```
claude-code-acp (child proc)
        │ JSON-RPC 2.0 over stdio
        ▼
   agent/acp  ──── translates ACP notifications ───┐
        │                                          │
        ├─ Events()      chan Event  ──────────────┤
        └─ Permissions() chan PermissionReq ───┐   │
                                               │   │
   supervisor (one goroutine per session) ─────┴───┤
                                                   ▼
                                         tea.Program.Send()
                                                   │
                                                   ▼
                                        app root model.Update
                                          ├─ session panes
                                          ├─ approval queue
                                          └─ review pane
```

One goroutine per session drains both channels and forwards into the Bubble
Tea event loop via `Program.Send`. `Update` never blocks and never performs
I/O; all work happens in commands or in the supervisor goroutines.

## Components

### agent — the adapter boundary

The only interface that must be right, because backends two through four
depend on it being backend-shaped rather than Claude-shaped.

```go
type Session interface {
    Prompt(ctx context.Context, text string) error // steer while running
    Interrupt(ctx context.Context) error
    Events() <-chan Event
    Permissions() <-chan PermissionReq
    Close() error
}

type Event struct {
    Kind    EventKind // Text, Thought, ToolCall, ToolResult, Plan, Done, Error
    Text    string
    Tool    *ToolCall
    Plan    []PlanItem
    Stop    StopReason
}

type PermissionReq struct {
    Tool    ToolCall
    Options []PermOption // from the agent: allow-once, allow-always, reject...
    Reply   chan<- string // option ID; closed without a send == cancelled
}
```

`PermissionReq.Reply` is the whole mechanism of the approval queue. ACP's
`session/request_permission` is a JSON-RPC *request*: the agent blocks until
answered. The adapter parks the pending request, hands the queue a reply
channel, and answers when the queue resolves it.

ACP surface consumed in v1:

- `initialize`, `session/new`, `session/load`, `session/prompt`, `session/cancel`
- `session/update` notifications: `agent_message_chunk`, `agent_thought_chunk`,
  `tool_call`, `tool_call_update`, `plan`
- `session/request_permission`

Client-side `fs/*` and `terminal/*` methods are not implemented in v1; the
agent uses its own filesystem and shell access inside its worktree.

### supervisor — process lifecycle

Spawns `npx @zed-industries/claude-code-acp` with the session worktree as
cwd, performs the ACP handshake, and owns the process for its lifetime.
Tracks a state machine per session:

```
starting → idle → running → idle
              ↘ blocked (awaiting approval) ↗
   any → crashed → (resume) → idle
   any → closed
```

A crashed agent leaves its worktree and session log intact. Resume respawns
the process and calls `session/load` when the agent advertises the
`loadSession` capability; when it does not, the session restarts with its
transcript replayed into the pane as history only.

### worktree — isolation

```
repo/                  your tree, your branch
.ctui/wt/claude-1/     branch ctui/claude-1, based on repo HEAD at spawn
.ctui/wt/codex-2/      branch ctui/codex-2
```

- create: `git worktree add -b ctui/<name> .ctui/wt/<name> <base-sha>`
- base-sha is recorded at spawn; every diff is computed against it
- destroy: `git worktree remove --force` then `git branch -D`
- `.ctui/` is added to `.git/info/exclude`, not to the user's `.gitignore`

Fresh worktrees lack build artifacts and installed dependencies. A
per-repo `postCreate` command in `.ctui/config.toml` runs after creation
(`pnpm install`, or a symlink into the main tree's `node_modules`). This is
the one config value that genuinely varies per repository, so it earns its
existence; there is no other configurable behavior in v1.

### review — one path to accepting work

There is a single mechanism for landing a session's work: build a patch,
apply it to the main tree. "Accept all" is that path with every hunk
selected, not a separate merge codepath.

- diff source: `git -C <wt> diff <base-sha>` — includes uncommitted changes,
  because agents routinely leave work uncommitted
- the pane renders per-file, per-hunk, with keys to accept, reject, or skip
- accepting builds a filtered patch from the selected hunks and applies it
  with `git -C <repo> apply --3way`
- a failed apply is reported with the conflicting hunk and leaves both the
  worktree and the main tree untouched

Squash-merging the branch was considered and dropped: partial acceptance
cannot be expressed as a merge, and maintaining two landing paths means the
rare one is the broken one.

### approval — the cross-session queue

Every pending `PermissionReq` from every session lands in one list, sorted
oldest first, visible regardless of which session pane has focus. Resolving
an entry sends the chosen option ID on its reply channel, unblocking that
agent.

"Always allow" writes a rule to `.ctui/rules.json`, matched on tool name plus
a glob over the tool's primary argument.

Rules are a trust boundary and are treated as one:

- Rules are stored per repository. There is no global rule file, so a rule
  granted in one project never applies in another.
- A rule may only be created from a request the user is actively approving.
  Rules cannot be authored ahead of time through the UI.
- Rules never match implicitly. A rule for `git commit` does not cover
  `git commit && rm -rf .`; matching is against the parsed tool call the
  agent sent, not a substring of a rendered command line.
- The queue shows the matching rule for every auto-approved call in a muted
  style, so silent approvals remain visible after the fact.
- Rules are revocable from the queue pane, and revocation is immediate.

### store — persistence

`.ctui/sessions/<id>.jsonl` holds one JSON object per event, appended as it
arrives. This is the transcript, the crash-recovery record, and the input to
the session list on startup. Session metadata (backend, worktree path,
base-sha, branch, created-at) lives in the first line of the file.

## Layout

```
┌ sessions ─────┐┌ diff: api/user.go ────────────┐
│▸claude  ●run  ││  func Get(id) {   │ func Get(id){│
│ codex   ⏸ask  ││-   return nil     │+  return u,  │
│ cursor  ✓done ││                   │              │
└───────────────┘└──[a]ccept [r]eject [n]ext hunk┘
┌ approvals (2) ─────────────────────────────────┐
│ codex  → rm -rf build/      [y][n][always]     │
│ cursor → write .env         [y][n][always]     │
└────────────────────────────────────────────────┘
```

Session list is always visible. The main pane toggles between the session
transcript and its diff. The approval queue is always visible when non-empty
and collapses to nothing when empty. Mouse and OSC-8 hyperlinks are on;
file references in transcripts are clickable.

## Error handling

| Failure | Behavior |
|---|---|
| Agent process exits unexpectedly | Session → `crashed`. Worktree and log kept. Resume offered in the session list. Other sessions unaffected. |
| Malformed or unknown ACP message | Logged to the session pane as a protocol warning. Unknown `session/update` kinds are ignored, not fatal. |
| Worktree creation fails (branch exists, detached HEAD, dirty index) | Session is not created; the git error is shown verbatim. |
| Patch apply conflicts | Nothing is applied. Conflicting hunk shown. Worktree left intact for retry. |
| Approval arrives for a session whose pane is closed | Still queued — the queue is global, not per-pane. |
| TUI exits with sessions running | Confirmation prompt listing running sessions; on confirm, agents are sent `session/cancel`, then terminated, and worktrees are left on disk for the next launch. |

## Testing

- **agent/acp** — a fake ACP agent: a stdio fixture replaying canned JSON-RPC
  frames. Table tests over ACP message → `Event` mapping, including unknown
  message kinds and mid-stream errors.
- **worktree** — real `git` against temp-directory fixtures. Create, list,
  destroy, and the dirty-repo and branch-exists failure paths.
- **review** — golden files: given a diff and a hunk selection, assert the
  built patch byte-for-byte. Round-trip test that applying the full patch
  reproduces the worktree state.
- **approval** — table tests for rule matching, with explicit negative cases
  for the near-miss patterns named in the security notes above.
- **app** — `teatest` golden-frame tests for layout at a few terminal sizes,
  and for focus movement between panes.

Every package below `app` is testable without a terminal, which is the point
of keeping Bubble Tea confined to `app`.

## Milestones

1. **One session end to end.** Spawn claude-code-acp in a worktree, stream
   its output into a pane, send prompts, interrupt. No review, no queue.
2. **Approvals.** Permission requests reach a global queue and unblock the
   agent when resolved. Rules and revocation.
3. **Review and land.** Diff pane, hunk selection, patch apply, worktree
   teardown.
4. **Many sessions.** Session list, focus switching, per-session state, crash
   recovery and resume.
5. **Second backend.** Codex, to prove the adapter interface. Anything that
   needed changing in `agent.Session` to make it fit is a v1 design bug.

## Deferred, with triggers

| Deferred | Add when |
|---|---|
| Detached daemon (`ctuid`) | Losing a long run to a closed TUI actually costs a real task |
| Context inspector, token budget | After milestone 4, when several sessions make spend opaque |
| Checkpoint timeline / scrub-and-fork | After review lands; it depends on the same snapshot machinery |
| Cursor-agent and Pi backends | After Codex proves the adapter |
| Desktop notifications on block | When the approval queue is regularly unattended |
