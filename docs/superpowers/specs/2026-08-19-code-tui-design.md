# code-tui: an agent cockpit

Date: 2026-08-19
Status: approved design, not yet implemented

## What this is

A terminal cockpit for running several coding agents at once. Not another
chat client — every vendor ships a good one. The gap is what happens when you
run three agents in parallel: three terminals, three permission prompts you
babysit one at a time, three sets of edits landing in one working tree, and
no single place to review the result.

`ctui` is that single place. One screen: every session, every pending
approval, the diff each session produced. Sessions live in git worktrees so
they cannot collide. Work lands in your tree only when you accept it.

## Non-goals

Not a multiplexer (tmux exists). Not its own agent loop. No plugins, themes,
web UI, or remote access.

## Settled

| Decision | Choice |
|---|---|
| Shape | Cockpit, chat is a subordinate pane |
| Language | Go + Bubble Tea |
| Isolation | One git worktree + branch per session |
| Backend | Claude Code over ACP (`@zed-industries/claude-code-acp`) |
| Process model | Monolith — agents are child processes of the TUI |

Monolith cost is real: killing the TUI kills in-flight agents. Mitigated by
ACP session resume, not by building a daemon.

## Layout

```
┌ sessions ─────┐┌ diff: api/user.go ────────────┐
│▸claude  ●run  ││  func Get(id) {   │ func Get(id){│
│ codex   ⏸ask  ││-   return nil     │+  return u,  │
│ cursor  ✓done ││                   │              │
└───────────────┘└──[a]ccept [r]eject [n]ext hunk┘
┌ approvals (2) ─────────────────────────────────┐
│ codex  → rm -rf build/      [y][n]             │
│ cursor → write .env         [y][n]             │
└────────────────────────────────────────────────┘
```

Session list always visible. Main pane toggles transcript / diff. Approval
queue visible when non-empty, gone when empty.

## Files

```
main.go       flags, git preflight, tea.NewProgram
ui.go         root model, layout, keymap, focus
acp.go        child process + JSON-RPC over stdio
worktree.go   create / diff / apply / destroy  (shells out to git)
```

Four files, not eight packages. `acp.go` and `worktree.go` have no Bubble Tea
import, so they test without a terminal.

No `Session` interface — there is one backend. Extract the interface when
Codex lands and the second implementation shows what actually varies. An
interface written against one implementation is a guess.

No re-modelled event type. ACP `session/update` payloads are already
structured; unmarshal into a struct that mirrors them and forward it to the
UI. A translation layer between two representations of the same thing is
where the bugs live.

No state machine. A session is `running bool` and `blocked *PermissionReq`.
Six named states describe four booleans nobody queries.

## ACP transport

JSON-RPC 2.0 over the child's stdin/stdout. `encoding/json` on `exec.Cmd`
pipes — roughly 80 lines. No JSON-RPC framework: this speaks to exactly one
peer over one pipe, and framework connection/codec/dispatch machinery is
larger than the thing it replaces.

Methods used:

- out: `initialize`, `session/new`, `session/prompt`, `session/cancel`
- in: `session/update` (`agent_message_chunk`, `agent_thought_chunk`,
  `tool_call`, `tool_call_update`, `plan`)
- in, blocking: `session/request_permission`

Unknown `session/update` kinds are ignored, not fatal. Client-side `fs/*` and
`terminal/*` are not implemented — the agent uses its own file and shell
access inside its worktree.

One goroutine per session reads the pipe and forwards into the Bubble Tea
loop via `Program.Send`. `Update` never blocks and never does I/O.

## Worktrees

```
repo/                  your tree, your branch
.ctui/wt/claude-1/     branch ctui/claude-1, based on repo HEAD at spawn
```

Shell out to git. `go-git` is a large dependency to re-implement a CLI that
is already installed and is the thing users debug with.

- create: `git worktree add -b ctui/<n> .ctui/wt/<n> <base-sha>`
- destroy: `git worktree remove --force` then `git branch -D`
- `.ctui/` goes in `.git/info/exclude`, not the user's `.gitignore`

Fresh worktrees have no `node_modules` or build cache. If
`.ctui/postcreate` exists and is executable, run it after create. A shell
script that either exists or doesn't — no config file, no TOML parser, no
schema.

## Review

One mechanism for landing work: build a patch, apply it. "Accept all" is that
path with every hunk selected, not a second codepath.

- diff: `git -C <wt> diff <base-sha>` — includes uncommitted changes, because
  agents routinely leave work uncommitted
- parse and filter with `github.com/bluekeyes/go-gitdiff`. Unified-diff
  parsing is a solved problem with edge cases (renames, mode changes, binary,
  no-newline-at-EOF) that a hand-rolled parser gets wrong quietly.
- apply: `git -C <repo> apply --3way` on the filtered patch
- failed apply: report the conflicting hunk, change nothing, leave the
  worktree intact

Squash-merge was considered and dropped. Partial acceptance cannot be
expressed as a merge, so keeping it means two landing paths, and the rare one
is the one that rots.

## Approvals

ACP `session/request_permission` is a JSON-RPC *request* — the agent blocks
until answered. Park the pending request, show it in one global queue sorted
oldest-first, reply with the chosen option ID when the user resolves it. That
is the entire mechanism.

**No "always allow" in v1.** Persisted auto-approval rules are where all the
security complexity lives — glob matching, scope, revocation, making silent
approvals auditable after the fact — and none of it can be built carelessly.
The queue exists precisely so answering prompts is cheap. Add rules when a
measured session shows the queue is the bottleneck, and design them properly
then: per-repo storage, no implicit matching, visible auto-approvals,
one-key revocation.

## Errors

| Failure | Behavior |
|---|---|
| Agent process exits unexpectedly | Session marked crashed. Worktree kept — it holds the actual work. Other sessions unaffected. |
| Malformed or unknown ACP message | Shown in the session pane as a warning. Not fatal. |
| Worktree create fails (branch exists, dirty index) | Session not created, git's error shown verbatim. |
| Patch apply conflicts | Nothing applied. Conflicting hunk shown. Worktree intact. |
| Approval for a backgrounded session | Still queued — the queue is global, not per-pane. |
| Exit with sessions running | Confirm, listing them. On confirm: `session/cancel`, terminate, leave worktrees on disk. |

## Tests

Three, matching the three things that break:

- **acp** — a fake agent: a shell script replaying canned JSON-RPC frames.
  Asserts a prompt round-trips and a permission request reaches the queue.
- **worktree** — real git in a temp dir. Create, diff, apply, destroy, plus
  the branch-exists failure.
- **review** — golden file: given a diff and a hunk selection, assert the
  built patch byte-for-byte.

No `teatest` golden frames. Layout churns every session while the UI is in
flux; golden frames would fail on every intentional change and get
regenerated without reading, which is a test that costs maintenance and
catches nothing.

## Milestones

1. **One session end to end.** Spawn `claude-code-acp` in a worktree, stream
   output, prompt, interrupt.
2. **Approvals.** Global queue, y/n, agent unblocks.
3. **Review and land.** Diff pane, hunk selection, apply, teardown.
4. **Many sessions.** List, focus, per-session state.

Ship after 4. That is the product.

## Cut from v1, add when

| Cut | Add when |
|---|---|
| `Session` interface | Codex lands and shows what actually varies |
| JSONL transcript / crash replay | Losing scrollback costs real work — the worktree already holds the code |
| Persisted approval rules | A measured session shows the queue is the bottleneck |
| Config file | A second thing needs configuring |
| Detached daemon | A closed TUI kills a run that mattered |
| Context inspector, token budget | Several sessions make spend opaque |
| Checkpoint scrub-and-fork | After review lands; shares its machinery |
| Desktop notify on block | The queue is regularly unattended |
