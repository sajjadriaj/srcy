# code-tui: stay the one who understands the codebase

Date: 2026-08-19 (thesis repointed 2026-08-20)
Status: approved design, not yet implemented

## The problem

Agents generate faster than you can read. The codebase grows past your mental
model of it, and then debugging is archaeology in a repo you nominally own.

Diff review as it exists today does not stop this. You see `+40 −12` in a file
you have never opened, it looks plausible, you accept. That is approval
theater, and it is how the unreadable codebase gets built one plausible patch
at a time. Three weeks later `git blame` says `claude` and you learn nothing.

`ctui` is the layer between the agent and your codebase whose job is keeping
you the one who understands it. Not a faster way to accept code — a review
gate you cannot pass without understanding, and a history that still answers
questions months later.

Running several agents at once is a side effect: it is how you keep throughput
without losing the plot. It is not the thesis, and it is the last milestone,
not the first.

## Non-goals

Not a multiplexer. Not its own agent loop. No plugins, themes, web UI, remote
access. Not a faster accept button.

## Settled

| Decision | Choice |
|---|---|
| Thesis | Comprehension first; parallelism is plumbing |
| Language | Go + Bubble Tea |
| Isolation | One git worktree + branch per session |
| Backend | Claude Code over ACP (`@zed-industries/claude-code-acp`) |
| Process model | Monolith — agents are child processes of the TUI |
| v1 scope | One session, reviewed properly |

## The five mechanisms

### 1. Explain before accept

The accept key is disabled until the agent has answered, in its own words:

- what changed
- what could break
- what you did **not** test

Sent as a prompt when review opens; the answer renders above the diff. Costs
one round trip and no code. Two things fall out of it: you read a summary
before a patch, and a vague or evasive answer is itself the signal to reject.
The placeholder that silently falls back to dummy output has to be said out
loud, or it has to be lied about — both are louder than a green `+40`.

The same answer becomes the commit body. One prompt, two jobs.

### 2. File view, not patch view

`tab` toggles the review pane between the patch and the resulting file with
changed regions marked.

Diffs hide architecture by construction — they show you edited lines, never
the shape of the thing you are editing. You cannot judge whether a function
belongs by reading three lines of it. Reading the file you are about to own is
the entire point.

Implementation: read the file from the worktree, mark line ranges from the
hunk headers. No second rendering path.

### 3. Blast radius

On opening review, for each changed symbol: who calls it, and did the agent
read those callers.

```
Get()          14 callers  · agent read 2
retryAfter()    1 caller   · agent read 1
```

Symbol names come from git's own hunk headers — `@@ -12,7 +12,9 @@ func Get(id`
— because git already computes the enclosing function via `xfuncname`. Callers
come from `git grep -n`. "Agent read" comes from the tool calls in the
session's own transcript.

```go
// ponytail: symbol extraction is git's xfuncname + git grep. Crude, zero
// deps, language-agnostic. Upgrade to tree-sitter or LSP if the noise
// outweighs the signal on a real repo.
```

This is the 3am page, shown before you accept it.

### 4. Provenance — `ctui why`

```
$ ctui why src/tts.ts:18
2026-08-19  claude-1
  you asked: "add tts, kokoro if available"
  agent said: falls back to silent ffmpeg audio when kokoro is missing,
              so the pipeline still runs. Not tested without kokoro.
```

**No provenance database.** Accept applies the patch *and commits it*, with the
agent's summary as the body and trailers for the rest:

```
tts: fall back to silent audio when kokoro is missing

<the explain-before-accept answer>

Ctui-Session: claude-1
Ctui-Prompt: add tts, kokoro if available
```

`ctui why <file>:<line>` is then `git log -L<line>,<line>:<file>` plus trailer
parsing. Roughly forty lines.

This matters more than it looks: line-level provenance that survives renames,
moves, and reformatting is the genuinely hard part, and `git log -L` already
does it. A JSONL file keyed by line numbers would be wrong the first time
anyone reformats. Storing this in git also means the history is readable by
`git log` alone, with no tool installed and no sidecar file to lose.

Committing on accept is not a side effect to apologize for — it is what makes
the history answer questions later. Squash before you push if you want.

### 5. Read-only sessions

A session whose job is understanding, not writing. "Walk me through how a
request reaches the db." "Why is this slow." "What breaks if I delete this."

Debugging is where you are actually stuck, and a cockpit built only around
producing diffs has no answer for it.

Mechanically: same worktree, same ACP session, but no review pane and no
accept key. Anything it writes is discarded when the session closes.

```go
// ponytail: "read-only" is discard-on-close, not an enforced read-only FS.
// Real enforcement means containers or mount tricks. Revisit if an explain
// session ever needs to be trusted with a dirty tree.
```

## Files

```
main.go       flags, subcommands (why), git preflight, tea.NewProgram
ui.go         root model, layout, keymap, review pane
acp.go        child process + JSON-RPC over stdio
git.go        worktree, diff, blast radius, apply, commit, why
```

Four files. `acp.go` and `git.go` import no Bubble Tea, so they test without a
terminal.

No `Session` interface — one backend. Extract it when Codex lands and shows
what actually varies. No re-modelled event type — ACP's `session/update`
payloads are already structured; unmarshal and forward. No state machine — a
session is `running bool` and `blocked *PermissionReq`.

## ACP transport

JSON-RPC 2.0 over the child's stdio, `encoding/json` on `exec.Cmd` pipes,
roughly eighty lines. No JSON-RPC framework: one peer, one pipe, and the
framework's connection/codec/dispatch machinery is larger than what it
replaces.

- out: `initialize`, `session/new`, `session/prompt`, `session/cancel`
- in: `session/update` (`agent_message_chunk`, `agent_thought_chunk`,
  `tool_call`, `tool_call_update`, `plan`)
- in, blocking: `session/request_permission`

Unknown update kinds are ignored, not fatal. Client-side `fs/*` and
`terminal/*` are not implemented — the agent uses its own access inside its
worktree. Tool calls are retained in memory for the session: blast radius
needs to know which files the agent actually read.

One goroutine reads the pipe and forwards into Bubble Tea via `Program.Send`.
`Update` never blocks and never does I/O.

## Git

Shell out. `go-git` is a large dependency that re-implements a CLI which is
already installed and is the thing users debug with.

```
repo/                  your tree, your branch
.ctui/wt/claude-1/     branch ctui/claude-1, based on repo HEAD at spawn
```

- create: `git worktree add -b ctui/<n> .ctui/wt/<n> <base-sha>`
- diff: `git -C <wt> add -A` then `git -C <wt> diff --cached <base-sha>`.
  Agents routinely leave work uncommitted, and plain `git diff` would miss
  every file they created. Staging first is harmless in a throwaway worktree
  and is the only way untracked files reach the review pane.
- filter: split the raw diff text on file and hunk boundaries, keeping hunk
  bodies byte-identical, and reassemble the selected ones. No diff library.
  Reserializing from a parsed model is what gets renames, mode changes,
  binary files, and no-newline-at-EOF wrong; never parsing them keeps them
  correct by construction. Hunk boundaries are found by consuming exactly the
  line counts in `@@ -a,b +c,d @@`, so a context line that itself looks like
  diff text cannot split a hunk. `git apply --3way` is the parser that
  matters, and it validates the result.
- apply: `git -C <repo> apply --3way`, then `git commit` with trailers
- destroy: `git worktree remove --force`, `git branch -D`
- `.ctui/` goes in `.git/info/exclude`, not the user's `.gitignore`

If `.ctui/postcreate` exists and is executable, run it after create — fresh
worktrees have no `node_modules` or build cache. A script that exists or
doesn't; no config file, no schema.

Accept-all is the same path with every hunk selected, not a second codepath.
Squash-merge was considered and dropped: partial acceptance cannot be
expressed as a merge, so keeping it means two landing paths and the rare one
rots.

## Approvals

ACP `session/request_permission` is a JSON-RPC *request* — the agent blocks
until answered. Park it, show it, reply with the chosen option ID. In v1 that
is an inline prompt in the session pane; the cross-session queue arrives with
multi-session.

**No "always allow" in v1.** Persisted auto-approval rules are where the
security complexity lives — glob matching, scope, revocation, keeping silent
approvals auditable after the fact — and none of it can be built carelessly.
Add rules when a measured session shows prompts are the bottleneck, and design
them properly then: per-repo storage, no implicit matching, visible
auto-approvals, one-key revocation.

## Errors

| Failure | Behavior |
|---|---|
| Agent process exits unexpectedly | Session marked crashed. Worktree kept — it holds the work. |
| Malformed or unknown ACP message | Warning in the session pane. Not fatal. |
| Worktree create fails | Session not created, git's error shown verbatim. |
| Patch apply conflicts | Nothing applied, nothing committed. Conflicting hunk shown. Worktree intact. |
| Commit fails after a clean apply | Changes stay in the working tree; the error names them as uncommitted so provenance loss is visible, never silent. |
| Explain prompt fails or times out | Accept stays disabled. Retry, or a keypress that accepts without a summary and records `Ctui-Prompt: <none>` — an unexplained change is allowed, but never invisible. |
| Exit with a session running | Confirm. On confirm: `session/cancel`, terminate, leave the worktree on disk. |

## Tests

- **acp** — a fake agent: a shell script replaying canned JSON-RPC frames.
  A prompt round-trips; a permission request blocks and then unblocks.
- **git** — real git in a temp dir. Create, diff, filter, apply, commit. Then
  the interesting one: edit the file further, and assert `ctui why` still
  resolves the original line to the right commit.
- **blast radius** — golden file: a diff in, symbols and callers out.

No `teatest` golden frames. Layout churns while the UI is in flux, so they
would fail on every intentional change and get regenerated unread — cost with
no catch.

## Milestones

1. **One session end to end.** Worktree, spawn `claude-code-acp`, stream,
   prompt, interrupt, inline approvals.
2. **Review that earns its name.** Patch/file toggle, explain-before-accept
   gate, hunk selection, apply, commit with trailers.
3. **Understanding tools.** Blast radius on review open. `ctui why`.
4. **Read-only sessions.** Explain mode, no accept path.
5. **Multi-session.** Session list, focus, global approval queue.

Milestones 1–4 are the product. 5 is throughput, and it is deliberately last:
shipping parallelism before the review gate would build the exact machine this
spec exists to avoid.

## Cut, add when

| Cut | Add when |
|---|---|
| `Session` interface | Codex lands and shows what varies |
| Provenance database | Never — `git log -L` is the feature |
| Persisted approval rules | A measured session shows prompts are the bottleneck |
| Config file | A second thing needs configuring |
| Detached daemon | A closed TUI kills a run that mattered |
| Enforced read-only FS | An explain session must be trusted with a dirty tree |
| tree-sitter / LSP symbols | `xfuncname` + `git grep` noise outweighs signal |
| Context inspector, token budget | Several sessions make spend opaque |
| Checkpoint scrub-and-fork | After review lands; shares its machinery |
