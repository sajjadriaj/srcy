# srcy

**An IDE around the coding agent you already use.**

`claude`, `codex`, `opencode`, `pi`, `gemini`, `aider` — whichever binary you
name runs in the big pane exactly as it runs in a bare terminal. Own slash
commands, own keybinds, own scrollback, own mouse. srcy is the panes around
it.

![srcy](docs/demo.gif)

<sub>Launch → the turn lands → `types` goes red while `lint`, which watches
only `docs/`, stays green → a tool srcy never invoked reports a counterexample
beside it → `e` to the failing line → collapse the tree to what moved → pin a
file → walk its hunks, side by side and back → zoom the agent → drag the
border → the fix lands, **VERIFIED** → detach, and ask the same question with
no panes at all. Real layout, real git repo, real transcript, real gates, real
socket. Only the agent's turn is scripted; `npm run demo` reproduces it.</sub>

---

## Why

An agent's pane is a **log**: every fact printed once, then buried under the
next forty tool calls. srcy is **state** — the plan *now*, the diff *so far*,
whether it compiles *at this moment*, and whether that answer is still about
the code in front of you.

|  | agent's pane | srcy |
|---|---|---|
| the plan | printed once, 40 calls ago | on screen |
| what changed | one hunk at a time | whole tree, marked — and every hunk, scrollable |
| does it build | whatever it said last | run against the tree that exists |
| is that still true | — | `VERIFIED`, or `code moved since` |
| how long has this call been running | — | `⟳ 13s Bash npm test` |
| is it stuck on a permission prompt | buried in scrollback | `needs you 40s · Bash npm test` on the border, and a bell |
| it said the tests pass | taken on faith | `✖ agent says passing` beside the gate that disagrees |

---

## Install

Needs **Node 20+**, **git**, **tmux**, and your agent CLI already logged in.

```bash
git clone https://github.com/sajjadriaj/srcy.git && cd srcy
npm install     # builds on install
npm link        # puts `srcy` on your PATH
```

Undo with `npm unlink -g srcy`.

---

## Use

Run inside any git repo.

| command | does |
|---|---|
| `srcy` | claude, in this repo |
| `srcy --agent codex` | any binary — the name *is* the command |
| `srcy --agent "claude --model opus"` | with its own flags |
| `srcy -- claude --resume` | everything after `--` is the agent's argv |
| `srcy --name review` | a second session on the same repo |

Re-running `srcy` **re-attaches** instead of starting a second session. The
session name is the repo basename plus a hash of its path, so `~/work/api` and
`~/side/api` never collide. A mistyped flag is refused, not ignored.

srcy runs on its own tmux server: `tmux -L srcy ls`, `tmux -L srcy kill-server`.

### The agent's own flags

Everything after `--` is the agent's argv, untouched. srcy wraps nothing and
adds no permission layer, so resuming and loosening approvals are the agent's
flags: `srcy -- claude --resume`, `srcy -- codex resume --last`,
`srcy -- claude --permission-mode acceptEdits`.

> **`--dangerously-skip-permissions` and
> `--dangerously-bypass-approvals-and-sandbox` let the agent run any command,
> write any file and reach the network without a prompt.** Run them somewhere
> you can throw away — a container, a scratch worktree, a branch you can
> `git reset --hard` — and not in a shell holding credentials. What srcy adds
> there is visibility, not a seatbelt.

The panels come back with a resumed session: srcy reads whichever transcript
was written most recently, so PLAN, GOAL and the gauge all restore. The `TURN`
baseline is a fresh git tree either way — it comes from the repo, not the
transcript.

---

## Panels

| panel | reads | shows |
|---|---|---|
| **GOAL** | `.srcy/task.md`, else the session log | what you asked for, after forty tool calls buried it |
| **PLAN** | session log | `PLAN 2/3` — still there 40 tool calls later |
| **REPO** | `git` | the whole project, directories closed except the ones holding a change. Failing files turn red and spend the churn column on the failure count. `/` searches it |
| **GATES** | `.srcy/config.json` | one row per gate, plus `VERIFIED` when the word is earned. `tab` picks one and its output opens in REVIEW |
| **gauge** | session log | `34% 343k/1.0M opus-5 cache 99%` |
| **REVIEW** | `git` + GATES | every hunk of every changed file, unified or side by side, headed by what the gates actually said and one line about the whole change |

The rail reads top to bottom in the order you'd ask: what you asked for, what
the agent means to do about it, what it has done to the tree, whether any of
it holds, and how much room it has left. The tree is the section that
stretches, so it sits in the middle.

A handful of choices worth knowing:

- **A header's colour is its source.** `REPO` is cyan because it comes from
  git; `GOAL` and `PLAN` are magenta because they come from the agent. Only
  `GATES` carries a state, so only `GATES` changes colour.
- **Nothing reports passing before it has run.** `not run yet` ≠ `passing` ≠
  `none configured` ≠ `timed out`. A gate that ran out of time proved nothing
  either way, so it is not rewritten to "failing".
- **An in-place edit counts as a change.** Replacing a line with a different
  line leaves `+1 -1` exactly as it was, so the tree is identified by content.
  Otherwise the fix for the bug introduced three seconds ago never re-checks.
- **Created, edited and deleted are three markers** — `+` `▪` `-`. A deletion
  says `deleted`, not `+0 -37`, which is the same shape as a heavy edit.
- **`n`/`p` read worst first**: a file with a failing gate, then deletions,
  then new files, then churn. git's alphabetical order has nothing to do with
  what deserves a reader first.
- **The border says what the agent is doing, in one of four words.**
  `⟳ 52s Bash npm test` while a call is in flight — a still picture of
  `npm test` cannot say it has been running twelve minutes. `thinking 12s`
  between two calls, which is not your turn however quiet it looks.
  `needs you 40s · Bash npm test` when the call is open because the agent is
  waiting for permission to make it — read off the agent's own screen, since
  its transcript records the call and nothing about the wait. And `your turn
  · waiting 5m00s` once the turn has actually ended, which the transcript
  says outright.
- **It rings.** Once, when the agent hands the turn back, when it needs you,
  and when a gate goes red — the transitions worth leaving another window
  for, and the whole point of `ctrl-b d`. tmux passes the bell through, so
  the terminal does whatever it does with one (a badge, usually), and a line
  at the bottom says which it was. `"notify": false` in `.srcy/config.json`
  turns it off.
- **The review pane opens with one line about the whole change.** `5 files
  +84 -21  tests +1  deleted 1  lockfile` — how big, and the kinds of file
  in it a reviewer wants pointed out first: tests touched (or `no tests
  changed`), deletions, binaries, lockfiles, migrations, files named like
  secrets, generated directories, config, and `large` past twenty files or
  five hundred lines. Path-derived and deterministic; it says where to look,
  never whether it is safe.
- **A gate's whole output is one `tab` away.** The rail says `✖ 2 in 1` and
  the review pane has room for four messages; a failing test's assertion
  diff fits in neither. `tab` in the sidebar picks a gate and the review pane
  pages through the last 300 lines it printed, newest at the bottom where a
  runner puts its summary. `R` runs the picked gate alone.
- **A gate that started itself is cut short when the tree moves.** Its
  verdict would have arrived stale, with the next run queued behind it. One
  you asked for with `r` runs to the end: you are waiting on it.
- **`o` and `y` are the way out.** `o` opens the line under the cursor in
  `$EDITOR` (`+line` for terminal editors, `-g path:line` for VS Code and its
  forks) in a new tmux window of srcy's own session; closing the editor lands
  back on the panes. `y` puts `path:line` in tmux's paste buffer and on the
  clipboard, and `ctrl-b ]` in the agent's pane drops it on the prompt. srcy
  still sends the agent nothing: the reader pastes, or doesn't.
- **Where srcy hasn't run a gate, the agent's own run is the evidence.**
  `not run · agent 4m00s`, or `agent stale` when it went on editing
  afterwards. Both timestamps are the agent's own.
- **`cache` is the bloat reading.** Healthy sits near 99%; a session
  re-sending its whole context every turn shows it collapsing.
- **srcy adds nothing to the context window.** Every token in there is the
  agent's.

Every marker is one cell wide in every terminal — the obvious ones (`●` `○`
`▶` `█`) are East-Asian *ambiguous* and render two cells under some settings,
which tears a fixed-width column.

---

## Verification

`.srcy/config.json` — commit it, like a lint file:

```json
{
  "gates": [
    { "name": "types", "command": ["npm", "run", "typecheck"], "watch": ["**/*.ts"] },
    { "name": "unit",  "command": ["npm", "test"], "watch": ["src", "test"] },
    { "name": "lint",  "command": ["npx", "eslint", "."], "required": false },
    { "name": "e2e",   "command": ["npm", "run", "e2e"], "auto": false, "timeoutMs": 300000 }
  ],
  "derived": [
    { "from": ["src", "scripts/demo.ts"], "to": "docs/demo.cast" }
  ]
}
```

| field | |
|---|---|
| `command` | a list of words, never a shell line. Need a shell? That's what `.srcy/check` is |
| `auto` | default `true` — runs itself once the tree stops moving. `false` waits for `r` |
| `required` | default `true` — whether **VERIFIED** is a claim about this gate |
| `watch` | default the whole tree — the paths this verdict depends on |
| `timeoutMs` | default 120000, capped at ten minutes |

Beside `gates`, `"notify": false` silences the bell. Gates run one at a time. A malformed config is shown in GATES and falls back
to the detected command — one bad gate invalidates the list rather than being
silently skipped. With no config at all, srcy runs an executable `.srcy/check`
(any language, non-zero means failing) or your `typecheck`/`build` npm script.

### What green means

A verdict carries the tree it was measured against, so a pass the tree has
outrun says `code moved since` instead of `✔`. **VERIFIED** is the whole of
that in one word:

> every gate marked `required` has **passed**, and each of those passes was
> measured against the tree that is there **now**.

Nothing softer. A repo with no required gate is never verified — "green
because there was nothing to check" is the one thing this must never say.

`watch` is what keeps the word usable. A typecheck that reads only TypeScript
isn't invalidated by editing a README, so it doesn't go stale and doesn't
re-run:

| pattern | matches |
|---|---|
| `src` or `src/**` | everything under that directory |
| `**/*.ts` | that extension, anywhere |
| `api/schema.yaml` | exactly that file |

Not a glob engine — three shapes, and anything else matches nothing, which
shows up immediately as a gate that never goes stale.

`derived` is the same claim about files a project builds from other files — a
gif built from a script, a generated client. They appear in GATES as
`demo.cast  older than panels.tsx` or `never built`; there is no command to
run, only two timestamps to compare. This is Make's job, technically. Nobody
runs Make on a gif.

### What the checker said, and where

Failures are parsed into locations you can jump to — `e` walks them, errors
before warnings, so a lint run's forty warnings never bury its three errors.

| read | looks like |
|---|---|
| tsc | `src/a.ts(41,5): error TS2322: …` |
| most compilers, ruff, mypy, pytest, go test | `src/a.ts:41:5: …` |
| jest, vitest, node:test | `at fn (/repo/test/a.test.ts:22:10)` |
| eslint | a bare path, then `12:5  error  …` indented under it |
| cargo, rustc | `error[E0308]: …` then `  --> src/main.rs:4:5` |

The last two need more than a line at a time — neither an eslint file header
nor a cargo arrow is a finding on its own.

---

## Without the panes

The trust model is worth nothing if the only way to read it is to be looking
at a terminal. Same engine, same gates, same word.

| command | |
|---|---|
| `srcy status` | mission, agent, churn, every verdict, what needs attention, `VERIFIED` / `UNVERIFIED` |
| `srcy verify` | run every gate against the tree that is there now |
| `srcy verify unit` | just that one |
| `srcy doctor` | what srcy resolved — gates, watches, timeouts, derived files, config errors |
| `srcy mission start "…"` | pin what this working copy is for, and start its clock |
| `srcy mission complete` | finish it, without erasing what it was |
| `srcy checkpoint` | remember this tree and what was true of it — no commit |
| `srcy checkpoint list` | every checkpoint |
| `srcy checkpoint diff 3 5` | `git diff` between two of them (one argument = against now) |
| `srcy timeline` | how the tree got here |
| `srcy emit --source x --type y` | how another tool reports what it is doing |

```
$ srcy status
Mission
  Fix the token expiration race  active 34m
Agent
  claude  working  Bash npm test  12s
Repository
  main  4 files  +72 -18
Verification
  typecheck   PASS  2.1s
  unit        FAIL  8.4s
  lint        STALE  0.8s  (optional)
Attention
  ✗ unit      test/session.test.ts:87  expected 2, got 3
  ! lint      code moved since it ran
State
  UNVERIFIED
```

`status` and `verify` **exit non-zero when the tree is not verified** — a
hook, a CI step or the agent's own `&&` can ask srcy the same question the
rail answers in colour. The `Agent` line is optional by construction: a repo
where no adapter matches prints every other line unchanged.

A checkpoint is a real git tree object written through a throwaway index —
nothing is committed, staged or stashed, and your index is never touched. The
timeline is the other half: the verdicts say what is true, and only this says
how the tree got here.

```
$ srcy timeline
22:27:36  mission.start   Fix the token expiration race
22:31:10  gate.start      unit
22:31:31  gate.fail       unit  21s
22:34:02  gate.pass       unit  19s
```

Transitions only, never polls. Verdicts live in `.srcy/state.json`, so the
rail in one terminal and `srcy verify` in another share them — and a restart
shows the last verdict, correctly labelled stale, instead of `not run yet`.
`.srcy/config.json` and `.srcy/task.md` are the parts worth committing:

```gitignore
.srcy/state.json
.srcy/events.jsonl
.srcy/checkpoints.jsonl
.srcy/srcy.sock
```

---

## Other tools

srcy observes; it does not orchestrate. It never installs, invokes or polls
another tool, and it works identically when none are installed. The whole
integration contract is one line of JSON:

```bash
srcy emit --source proof --type proof.falsify.completed \
          --level info --summary "Falsification passed"
```

```bash
echo '{"version":1,"source":"proof","type":"proof.attack.counterexample",
       "level":"error","summary":"Found counterexample","treeHash":"a81fc23"}' |
  srcy emit --stdin
```

No SDK, no library, nothing to import — a hook in shell, Python, Rust, Go, a
CI step or a git hook can do this. **`srcy emit` exits 0 when no srcy is
listening**, so a tool that emits is a tool that still works on a machine
where srcy has never been installed. `--strict` says otherwise, if the sender
would rather know.

| envelope | |
|---|---|
| `version` | `1`. Required, and an unknown version is refused rather than guessed at |
| `source` | who is speaking. The first event establishes it; nothing to register |
| `type` | `<source>.<category>.<action>` by convention, never enforced |
| `level` | `info` \| `warning` \| `error` — the sender's own reading |
| `summary` | one line, for the human reading the rail |
| `treeHash` | the tree the work was about, as `git write-tree` spells it |
| `timestamp` `sessionId` `metadata` | optional; `metadata` is carried untouched |

Only the envelope is validated. `{"version":1,"source":"my-weird-tool",
"type":"banana.completed","metadata":{"anything":true}}` is a valid event, and
a malformed one loses only itself — a bug in somebody's hook can't take the
session down.

Events appear in the rail under `EVENTS`, in `srcy timeline`, and — when the
sender set a `level` of `warning` or `error` — in `srcy status` under
`Attention`:

```
─ EVENTS  proof benchmark ──────
  ✖ proof Found counterexample
  ! benchmark p99 regressed 14%
```

**srcy never revises a level.** A result the sender called `info` is
information here, whatever its metadata might mean to someone who knew that
tool — and srcy is the one reader that must not know. Per source, srcy
repeats whichever level-bearing event came last: a tool that reported an
error and later reported something fine has said the second thing more
recently.

A `treeHash` that is not the tree that is here now reads `· earlier tree`.
That is the only thing srcy says about another tool's result.

Inside a session, these are set for the agent and anything it runs — as
discovery, never a requirement:

```
SRCY_ACTIVE=1
SRCY_SESSION_ID=srcy-api-8f291
SRCY_SOCKET=/repo/.srcy/srcy.sock
```

The endpoint is a local Unix socket, mode `0600`, never a network listener.
Events are capped at 64 KB and land in the same `.srcy/events.jsonl` srcy
writes its own to — an event is an event. Add `.srcy/srcy.sock` to
`.gitignore` with the rest.

---

## Keys

Keys are tmux's, because it *is* tmux: `ctrl-b o` next pane, `ctrl-b z` zoom,
`ctrl-b d` detach (the agent keeps working), mouse to focus, drag or scroll.
Under 72 columns the agent starts zoomed — three narrow panes are three
unreadable ones.

| in the sidebar | | in the review pane | |
|---|---|---|---|
| `j` `k` | move the cursor — `g` `G` for the ends | `n` `p` | next / previous changed file |
| `⏎` `space` | open a directory, or pin a file | `]` `[` | next / previous hunk |
| `/` | search paths — `⏎` keeps, `esc` clears | `j` `k` `PgDn` `PgUp` | scroll — a file preview and a gate's output scroll the same way |
| `m` | only what changed, and back | `g` `G` | top / bottom |
| `e` | jump to the next failing line | `s` | side by side |
| `f` | back to following the agent | `f` | back to following |
| `o` `y` | open in `$EDITOR` / copy the path | `1` `2` `3` | turn / session / everything uncommitted |
| `r` | run every gate now | `,` `.` | back and forward through the last 8 turns |
| `tab` `R` | pick a gate — its output opens in REVIEW — and run just that one | `o` `y` | open this line in `$EDITOR` / copy `path:line` for the agent |
| `c` | checkpoint: everything after this is *this* turn | `?` | every key, on screen |
| `?` | every key, on screen | | |

The agent keeps every other keystroke. Both panels are inert until you move
the keyboard to them. The review pane opens on `TURN` as soon as there is a
turn to review, and on `HEAD` before that.

### Three answers to "what changed"

| scope | since |
|---|---|
| `TURN` | the newest thing you asked for, or your last `c` |
| `SESSION` | srcy opening this repo |
| `HEAD` | the last commit — every uncommitted line, staged or not |

`TURN` is taken the moment your request lands, then checked against the
transcript again: if the agent had already started writing, the baseline is
thrown away and the pane says so rather than hiding half the turn. A scope
with no baseline shows nothing and explains itself — a diff labelled "this
turn" that is really every uncommitted line is worth less than an empty pane
that admits it.

---

## How it works

**tmux hosts the layout**, which is why the agent stays native: tmux already
solves the pty, resize protocol, scrollback, mouse and copy-paste. The agent
gets a real terminal because it *is* in one.

**On srcy's own socket.** Agents ask their terminal for things — Claude Code
wants `focus-events`, pi wants `extended-keys` — and those are *server-wide*
in tmux. On a shared server they would reach into every other session you have
open. Your `~/.tmux.conf` still loads.

**The panels never speak to the agent.** git and your gates work for every
agent, and for a person with an editor open. Only GOAL, PLAN, the gauge and
the automatic `TURN` baseline are per-agent:

| agent | GOAL | PLAN | gauge | turn ended |
|---|---|---|---|---|
| `claude` | yes | `TodoWrite`, `ExitPlanMode`'s plan, or `TaskCreate`/`TaskUpdate` — whichever it wrote last | yes — window inferred (200k, or 1M once past it), per model | `stop_reason`, or its own `turn_duration` record |
| `codex` | yes | when it calls `update_plan` | yes — against the window codex records itself | `task_complete` |
| `pi` | yes | blank — pi has no plan tool | yes — window inferred, so `SRCY_CONTEXT_WINDOW=32000 srcy` for a local model | `stopReason` |
| `gemini` | yes | blank | yes — 1M, which every gemini model ships with | a reply with no tool calls |
| anything else | blank | blank | blank | — |

Forty recent Claude Code sessions on one machine never called `TodoWrite`
once, which is what PLAN read; they called `ExitPlanMode`, whose input is the
plan as markdown. So that is read too — ticked boxes, numbered steps, or
section headings, whichever the plan has — and so are the `TaskCreate` and
`TaskUpdate` calls newer Claude Code versions make.

gemini rewrites its chat file whole instead of appending, so it is re-read
from the top when it changes; the reader is written from the format as
gemini-cli records it and checked against nothing better than a session with
no turns in it.

Blank, never another agent's numbers. An agent srcy cannot name is still
watched for: if a transcript it recognises appears, the panels pick it up, and
`c` sets the turn baseline by hand wherever they do not. An agent started
*below* the root — a package in a monorepo, a worktree under it — is still
this repo's agent.

A Claude transcript never records how big the window is, so srcy infers it
from the session's peak and restarts that peak when `/model` swaps the window
underneath. For a window neither bucket fits:
`SRCY_CONTEXT_WINDOW=400000 srcy`.

<details>
<summary>The same repo under <code>srcy --agent codex</code></summary>

Same panels, no adapter — GOAL and PLAN come from codex's own session log.
The gauge reads `161k/258k` because codex records the model's real context
window with every token count — measured, where Claude Code's is inferred.
`PREVIEW_AGENT=codex npm run preview` prints this.

```
──  ⟳ 55s shell bash -lc npm run…──┬──  codex  ───────────────────────────────────────────────────────────────────────
─ GOAL ────────────────────────────│user
  fix the token expiry off-by-one  │  fix the token expiry off-by-one
─ PLAN 2/3 ────────────────────────│
  ✔ find the expiry comparison     │codex
  ✔ fix the off-by-one             │  The expiry check is exclusive: a token that expires on this exact
  ▸ add a regression test          │  millisecond is still accepted. Changing < to <= in verify().
─ REPO  FOLLOW ────────────────────│
▸  .srcy/                          │  exec  bash -lc "npm run typecheck"
▸  docs/                           │
▾  src/                            │
▾    auth/                         │
+►     expiry.test.ts      +1 -0   │
        hash.ts                    │
✖      session.ts          ✖1      │
▪      token.ts            +1 -1   │
▸    http/                         │
▸    util/                         │
      index.ts                     │
    README.md                      │
─ GATES 0/1  1 to look at ─────────│
  check      ✖ 1 in 1              │
  session.ts:3                     │
▮▮▮▮▯▯ 62% 161k/258k gpt-5.3-codex │
──  REVIEW  HEAD  FOLLOW  1/2 files  1/1 hunks  src/auth/session.ts  ─────────────────────────────────────────────────
  ✖ src/auth/session.ts:3  error TS2532: Object is possibly 'undefined'.
  2 files  +3 -1  no tests changed
   1   export class Session {
   2 +   private renewals = 0
   3 +   renew() { this.renewals++ }
   4   }
 ]/[ hunk · n/p file · j/k scroll · s split · f follow · 1/2/3 scope · ,/. turn · o open · y yank · ? keys
```
</details>

---

## Development

```bash
npm test           # node:test, no framework
npm run typecheck
npm run preview    # the layout over a fixture repo, as one frame
npm run demo       # re-record docs/demo.cast
npm run demo:gif   # cast -> gif (needs `agg`)
```

`npm run preview` is how to iterate on the panes — real layout, fixture repo,
no agent, no waiting on a turn. `PREVIEW_COLS` / `PREVIEW_ROWS` set the size.

Dependencies: `ink`, `react`. That's the list.

CI runs the tests and the typecheck on Node 20 and 22 for every push.


## Licence

MIT
