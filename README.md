# srcy

An IDE around the coding agent you already use.

The agent is not wrapped, driven, or reimplemented. `claude`, `codex`,
`opencode`, `pi`, `gemini`, `aider` — whichever binary you name runs in the
big pane exactly as it runs in a bare terminal, with its own slash commands,
its own keybinds, its own scrollback and its own mouse selection. srcy is the
panes around it: the project tree with this session's work marked in it, the
agent's plan, whether the code still builds, how full its context window is,
and the file being edited as it is edited.

![srcy](docs/demo.gif)

None of that reimplements what the agent already prints. An agent's pane is a
log: every fact appears once, at the moment it happened, then goes under the
next forty tool calls. srcy is state — what the plan is *now*, what has
changed *so far*, whether the tree compiles *at this moment*. Where the two
overlap, srcy is the copy still on screen an hour later. Where they do not, it
is the only copy.

Everything in that recording is real except the agent's turn: a git repo, a
transcript and a checker, all changing while the panels read them. `npm run
demo` reproduces it.

## Install

Needs Node 20+, git, tmux, and whichever agent CLI you use, already logged in.

```bash
git clone https://github.com/sajjadriaj/srcy.git && cd srcy
npm install          # builds on install
npm link             # puts `srcy` on your PATH
```

`npm link` is reversible with `npm unlink -g srcy`.

## Use

Run inside any git repo:

```bash
srcy                          # claude, in this repo
srcy --agent codex            # or pi, gemini, opencode, aider — the name is the command
srcy --agent "claude --model opus"
srcy -- claude --model opus   # everything after -- is the agent's own argv
srcy --name review            # a second session on the same repo
```

Running `srcy` again from the same repo re-attaches to the session already
working there instead of starting a second one. The session is named after the
repo *and* a hash of its path, so `~/work/api` and `~/side/api` never collide.
Quitting the agent ends the session; the panels do not keep it alive with
nothing to watch. A mistyped flag is refused rather than ignored.

Sessions live on srcy's own tmux server, so they answer to `tmux -L srcy ls`
rather than a bare `tmux ls`:

```bash
tmux -L srcy ls               # what srcy has running
tmux -L srcy kill-server      # stop all of it
```

### Keys

Keys are tmux's, because it is tmux:

```
ctrl-b o    next pane          ctrl-b z    zoom a pane to full screen
ctrl-b ←→   pane by direction  ctrl-b d    detach (the agent keeps working)
mouse       click to focus, drag a border to resize, scroll to scroll back
```

Detaching leaves the agent running; `srcy` from the same repo picks it back
up. With the keyboard in the sidebar:

```
j / k  ↓ / ↑   move the cursor
⏎ or space     open or close a directory; on a file, pin the diff pane to it
```

The cursor holds a file, not a row number — the agent creates and deletes
files while you are reading, and a row number silently means a different file
every time the list shifts. Directories you open or close by hand are
remembered as overrides: everything you have not touched still opens itself
for a change, so poking one folder never freezes the rest of the view.

The agent keeps every keystroke otherwise — the sidebar is inert until you
move the keyboard to it, which is the point.

### A checker of your own

`CHECKS` runs `.srcy/check` if you have one. Any executable, any language;
non-zero means failing, and anything it prints that looks like
`path:line: message` or `path(line,col): message` is parsed into the list.

```bash
mkdir -p .srcy && cat > .srcy/check <<'EOF'
#!/bin/sh
cargo check --message-format short 2>&1
EOF
chmod +x .srcy/check
```

Commit it — it is project configuration, the same as a lint config. With no
`.srcy/check`, srcy falls back to your `typecheck` or `build` npm script, and
says `none configured` if there is neither.

## What the panels say

`REPO` is the project, not just the diff: every file git tracks or would
track, with this session's work marked in it. Directories start closed except
the ones holding a change, so the work is visible without a keystroke while
the other ten thousand files stay one row each. Changed files carry their
churn; a file whose checks fail turns red and spends that column on the
failure count instead — `+1 -1` is not what you act on when the file no longer
compiles. New files count their whole length, because `+0 -0` on a file that
did not exist an hour ago reads as "nothing happened here".

`PLAN` is the agent's own todo list, still on screen forty tool calls after it
scrolled out of the agent's pane.

`CHECKS` runs when the diff stops moving, not on every keystroke: an agent
mid-edit produces a broken tree on purpose, and a sidebar that goes red
between two halves of one edit is noise. Nothing is ever reported as passing
before it has run — and once the code has moved on, the verdict says `code
moved since` and stops being drawn as current. A stale green reads exactly
like a fresh one, and only one of them is worth trusting.

The gauge on the bottom edge is one line with no heading — `53% 106k/200k
cache 99%` says what it is. Occupancy is the last request's, never a running
total: every agent's cumulative count runs to millions against a window of a
few hundred thousand, which would peg the gauge at full forever. `cache` is
the bloat reading — a session re-sending its whole context every turn shows it
collapsing, a healthy one sits near 99% after the first request. srcy adds
nothing to that window; every token in there is the agent's. An unmeasured
window says so rather than being drawn empty.

`DIFF` follows the file the agent wrote last, until you pin it to one from the
sidebar; a pinned file with no changes is shown as a plain preview rather than
a dead end. When the checker is failing it heads the diff with what the
checker said — the file on screen first, then the rest — because the sidebar
has room for `session.ts:3` and the message is the half that tells you what to
do about it.

The sidebar's own border says what the agent is doing right now, and for how
long: `⟳ 13s Bash npm test`. That clock is the difference between an agent
working and an agent wedged, and it is the one thing the agent's own pane
cannot tell you — a still picture of "running npm test" looks the same at two
seconds and at four minutes. The agents name their own panes, which is why the
big border reads `✳ Claude Code` or `π` without srcy writing a character of
it.

## How it works

tmux hosts the layout, on a socket of srcy's own. That is why the agent stays
native: tmux already solves the pty, the resize protocol, scrollback, mouse
and copy-paste, better than a reimplementation in this repo would. The agent
gets a real terminal because it *is* in a real terminal.

The private socket is not cosmetic. Agents ask their terminal for things —
Claude Code wants `focus-events`, pi wants `extended-keys` so shift+enter
arrives as shift+enter — and those are server-wide options in tmux. On a
shared server, turning them on would reach into every other session you have
open and stay on after srcy exits. On srcy's own server they are srcy's to
set. Your `~/.tmux.conf` still loads, so your prefix and keybinds are
unchanged.

The panels never speak to the agent. There is no protocol to intercept, no
adapter to install. They read:

- **git**, for the tree and what changed in it — `REPO` and `DIFF`
- **your project's own checker**, for whether it still builds — `CHECKS`
- **the agent's own session log**, for the plan and the token counts — `PLAN`
  and the gauge

The first two work for every agent, and for a person with an editor open. The
third is per-agent, because each writes its own format:

| agent | `PLAN` | the gauge |
|---|---|---|
| `claude` | yes | yes, window inferred (200k, or 1M once past it) |
| `codex` | when it calls `update_plan` | yes, against the window codex records itself |
| anything else | blank | blank |

An agent srcy cannot read gets blank panels rather than another agent's
numbers. Codex is the better-instrumented of the two: it writes the real
context window with every token count, so that gauge is measured rather than
guessed.

The sidebar and the diff pane are separate processes, so both the pick and the
check result travel between them through one small file named after the
session. That was a tmux user option, which is the right store for a path and
the wrong one for a check result: measured on tmux 3.4, `set-option` refuses a
value past about 16 KB, and a value holding `$name` reads back with a
backslash inserted, which is on its own enough to make `JSON.parse` throw on
an error message that mentions a shell variable.

Colour is an encoding. Green wrote, red failed, dim is background you may
skip. Every marker is one cell wide in every terminal: the obvious ones
(`●` `○` `▶` `█`) are East-Asian *ambiguous* and render two cells under some
terminal settings, which tears a fixed-width column.

## Development

```bash
npm test           # node:test, no framework
npm run typecheck
npm run preview    # the layout over a fixture repo, printed as one frame
npm run demo       # re-record docs/demo.cast
npm run demo:gif   # docs/demo.cast -> docs/demo.gif  (needs `agg`)
```

`npm run preview` is how to iterate on the panes: it builds the real layout
over a fixture repo and prints a photograph of it, with no agent and no
waiting on a turn. `PREVIEW_COLS` and `PREVIEW_ROWS` set the size.

Dependencies: `ink` and `react`. That is the whole list.

## Licence

MIT.
