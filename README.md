# ctui

An IDE around the coding agent you already use.

The agent is not wrapped, driven, or reimplemented. `claude`, `codex`,
`opencode`, `pi`, `gemini`, `aider` — whichever binary you name runs in the
big pane exactly as it runs in a bare terminal, with its own slash commands,
its own keybinds, its own scrollback and its own mouse selection. ctui is the
panes around it: the project tree with this session's work marked in it, the
agent's plan, whether the code still builds, how full its context window is,
and the file being edited as it is edited.

None of that reimplements what the agent already prints. An agent's pane is
a log: every fact appears once, at the moment it happened, then goes under
the next forty tool calls. The rail is state — what the plan is *now*, what
has changed *so far*, whether the tree compiles *at this moment*. Where the
two overlap, the rail is the copy still on screen an hour later. Where they
do not, it is the only copy.

```
──  ⟳ 52s Bash Typecheck th…──┬──  ✳ Claude Code  ──────────────────────────────────────────────────
REPO                          │> fix the token expiry off-by-one
▸  .ctui/                     │
▸  docs/                      │● Read  src/auth/token.ts
▾  src/                       │● Read  src/auth/session.ts
▾    auth/                    │
▪►     expiry.test.ts +1 -0   │The expiry check is exclusive: a token that expires on this exact
        hash.ts               │millisecond is still accepted. Changing < to <= in verify().
✖      session.ts     ✖1      │
▪      token.ts       +1 -1   │● Edit  src/auth/token.ts
▸    http/                    │● Edit  src/auth/session.ts
─ PLAN ───────────────────────│● Bash  npm run typecheck
  ✔ find the expiry comparison│
  ✔ fix the off-by-one        │❯
  ▸ add a regression test     │
─ CHECKS ─────────────────────│
  ✖ 1 in 1 file               │
  session.ts:3                │
▮▮▮▯▯ 52% 105k/200k cache 99% │
──  DIFF  src/auth/session.ts  ─────────────────────────────────────────────────────────────────────
  ✖ src/auth/session.ts:3  error TS2532: Object is possibly 'undefined'.
src/auth/session.ts:1
   1   export class Session {
   2 +   private renewals = 0
   3 +   renew() { this.renewals++ }
   4   }
```

## How it works

tmux hosts the layout, on a socket of ctui's own. That is why the agent stays
native: tmux already solves the pty, the resize protocol, scrollback, mouse
and copy-paste, better than a reimplementation in this repo would. The agent
gets a real terminal because it *is* in a real terminal.

The private socket is not cosmetic. Agents ask their terminal for things —
Claude Code wants `focus-events`, pi wants `extended-keys` so shift+enter
arrives as shift+enter — and those are server-wide options in tmux. On a
shared server, turning them on would reach into every other session you have
open and stay on after ctui exits. On ctui's own server they are ctui's to
set. Your `~/.tmux.conf` still loads, so your prefix and keybinds are
unchanged; the cost is that ctui sessions answer to `tmux -L ctui ls` rather
than a bare `tmux ls`.

The panels never speak to the agent. There is no protocol to intercept, no
adapter to install. They read:

- **git**, for the tree and what changed in it — `REPO` and `DIFF`
- **your project's own checker**, for whether it still builds — `CHECKS`
- **the agent's own session log**, for the plan and the token counts —
  `PLAN` and the gauge

The first two work for every agent, and for a person with an editor open. The
third is per-agent, because each writes its own format:

| agent | `PLAN` | the gauge |
|---|---|---|
| `claude` | yes | yes, window inferred (200k, or 1M once past it) |
| `codex` | when it calls `update_plan` | yes, against the window codex records itself |
| anything else | blank | blank |

An agent ctui cannot read gets blank panels rather than another agent's
numbers. Codex is the better-instrumented of the two: it writes the real
context window with every token count, so that gauge is measured rather than
guessed.

## Install

Needs Node 20+, git, tmux, and whichever agent CLI you use, already logged in.

```bash
git clone <this repo> && cd code-tui
npm install          # builds on install
npm link             # puts `ctui` on your PATH
```

`npm link` is reversible with `npm unlink -g ctui`.

## Use

Run inside any git repo:

```bash
ctui                          # claude, in this repo
ctui --agent codex            # or pi, gemini, opencode, aider — the name is the command
ctui -- claude --model opus   # everything after -- is the agent's own argv
ctui --name review            # a second session on the same repo
```

Running `ctui` again from the same repo re-attaches to the session already
working there instead of starting a second one. The session is named after
the repo *and* a hash of its path, so `~/work/api` and `~/side/api` never
collide. Quitting the agent ends the session; the panels do not keep it alive
with nothing to watch. A mistyped flag is refused rather than ignored.

Keys are tmux's, because it is tmux:

```
ctrl-b o    next pane          ctrl-b z    zoom a pane to full screen
ctrl-b ←→   pane by direction  ctrl-b d    detach (the agent keeps working)
mouse       click to focus, drag a border to resize, scroll to scroll back
```

Detaching leaves the agent running; `ctui` from the same repo picks it back
up. With the keyboard in the rail:

```
j / k  ↓ / ↑   move the cursor
⏎ or space     open or close a directory; on a file, pin the dock to it
```

The cursor holds a file, not a row number — the agent creates and deletes
files while you are reading, and a row number silently means a different file
every time the list shifts. Directories you open or close by hand are
remembered as overrides: everything you have not touched still opens itself
for a change, so poking one folder never freezes the rest of the view.

The agent keeps every keystroke otherwise — the rail is inert until you move
the keyboard to it, which is the point.

## What the panels say

`REPO` is the project, not just the diff: every file git tracks or would
track, with this session's work marked in it. Directories start closed except
the ones holding a change, so the work is visible without a keystroke while
the other ten thousand files stay one row each. Changed files carry their
churn; a file whose checks fail turns red and spends that column on the
failure count instead — `+1 -1` is not what you act on when the file no
longer compiles. New files count their whole length, because `+0 -0` on a
file that did not exist an hour ago reads as "nothing happened here".

`DIFF` follows the file the agent wrote last, until you pin it to one from
the rail; a pinned file with no changes is shown as a plain preview rather
than a dead end. When the checker is failing, the dock heads the diff with
what it said — the file on screen first, then the rest — because the rail has
room for `session.ts:3` and the message is the half that tells you what to do
about it. Those rows come out of the diff's budget, never off the bottom of
the pane.

The rail and the dock are separate processes, so both the pick and the check
result travel between them through one small file named after the session. It
was a tmux user option, which is the right store for a path and the wrong one
for a check result: measured on tmux 3.4, `set-option` refuses a value past
about 16 KB, and a value holding `$name` reads back with a backslash inserted,
which is on its own enough to make `JSON.parse` throw on an error message that
mentions a shell variable.

`CHECKS` runs `.ctui/check` (executable) if you have one, otherwise your
`typecheck` or `build` npm script. It runs when the diff stops moving, not on
every keystroke: an agent mid-edit produces a broken tree on purpose, and a
rail that goes red between two halves of one edit is noise. Nothing is ever
reported as passing before it has run — and once the code has moved on, the
verdict says `code moved since` and stops being drawn as current. A stale
green reads exactly like a fresh one, and only one of them is worth trusting. The failures
themselves land in the dock, where there is width for the message.

The gauge on the bottom edge is one line with no heading — `52% 105k/200k
cache 99%` says what it is, and a `CONTEXT` rule above it would cost a row of
the tree to repeat that. It used to be four rows. Claude Code prints a
context percentage in its own status line and again under `/context`, so
most of those rows were spending the rail's scarcest resource on a number
the reader already had twice. They went back to `REPO`, which has no second
copy anywhere.

What survived the cut is the part no agent prints. `cache` is the bloat
reading: a session re-sending its whole context every turn shows it
collapsing, a healthy one sits near 99% after the first request. Occupancy
is the last request's, never a running total — every agent's cumulative
count runs to millions against a window of a few hundred thousand, which
would peg the gauge at full forever. The bar gives up its cells as the rail
narrows, never the digits: the bar is glanced at, the numbers are read. ctui
adds nothing to that window; every token in there is the agent's. An
unmeasured window says so rather than being drawn empty.

The rail's own border says what the agent is doing right now, and for how
long: `⟳ 52s Bash npm test`. That clock is the difference between an agent
working and an agent wedged, and it is the one thing the agent's own pane
cannot tell you — a still picture of "running npm test" looks the same at two
seconds and at four minutes. The age leads the title because tmux cuts a
border to the pane, so anything at the end is the first thing lost.
The agents name their own panes, which is why the big border reads
`✳ Claude Code` or `π` without ctui writing a character of it.

Colour is an encoding. Green wrote, red failed, dim is background you may
skip. Every glyph is one cell wide in every terminal: the obvious markers
(`●` `○` `▶` `█`) are East-Asian *ambiguous* and render two cells under some
terminal settings, which tears a fixed-width column.

`npm run preview` builds this layout over a fixture repo and prints a
photograph of it — no agent, no waiting on a turn. `PREVIEW_COLS` and
`PREVIEW_ROWS` set the size. That is how to iterate on the panes.

## Development

```bash
npm test        # node:test, no framework
npm run typecheck
npm run preview
```

Dependencies: `ink` and `react`. That is the whole list.
