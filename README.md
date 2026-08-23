# ctui

An IDE around the coding agent you already use.

The agent is not wrapped, driven, or reimplemented. `claude`, `codex`,
`opencode`, `pi`, `aider` — whichever binary you name runs in the big pane
exactly as it runs in a bare terminal, with its own slash commands, its own
keybinds, its own scrollback and its own mouse selection. ctui is the panes
around it: what changed, what it plans to do, whether the code still builds,
and how full its context window is.

```
──  ⟳ Bash Typecheck the wor──┬──  ✳ Claude Code  ──────────────────────────────────────────────────
REPO                          │> fix the token expiry off-by-one
   src/                       │
     auth/                    │● Read  src/auth/token.ts
▪      expiry.test.ts +1 -0   │● Read  src/auth/session.ts
✖      session.ts    ✖1       │
▪      token.ts      +1 -1    │The expiry check is exclusive: a token that expires on this exact
▪ wrote  ✖ failing            │millisecond is still accepted. Changing < to <= in verify().
─ PLAN ───────────────────────│
  ✔ find the expiry comparison│● Edit  src/auth/token.ts
  ✔ fix the off-by-one        │● Edit  src/auth/session.ts
  ▸ add a regression test     │● Bash  npm run typecheck
─ CHECKS ─────────────────────│
  ✖ 1 in 1 file               │❯
  session.ts:3                │
                              │
                              │
─ CONTEXT ────────────────────│
▮▮▮▮▮▮▮▮▮▮▮▮▯▯▯▯▯▯▯▯▯▯  52%   │
  105k/200k                   │
  out 12k  cache 99%          │
──  DIFF  src/auth/session.ts  ─────────────────────────────────────────────────────────────────────
src/auth/session.ts:1
   1   export class Session {
   2 +   private renewals = 0
   3 +   renew() { this.renewals++ }
   4   }
```

Left rail, top to bottom: every file this session touched with how much of
each changed, the agent's own plan as a live checklist, what your project's
checker says, and how full the window is. Bottom dock: the file being edited,
as it is edited. Big pane: the agent, untouched.

## How it works

tmux hosts the layout. That is the whole trick, and it is why the agent stays
native: tmux already solves the pty, the resize protocol, scrollback, mouse
and copy-paste, and it solves them better than a reimplementation inside this
repo would. The agent gets a real terminal because it *is* in a real terminal.

The panels never speak to the agent. There is no protocol to intercept, no
adapter to install, and nothing that has to be supported per-agent. They read:

- **git**, for what changed and by how much — `REPO` and `DIFF`
- **your project's own checker**, for whether it still builds — `CHECKS`
- **Claude Code's session transcript**, for the plan and the token counts —
  `PLAN` and `CONTEXT`

The first two work for every agent, and for a person with an editor open. The
last is Claude-Code-specific: under `--agent codex` the rail keeps `REPO`,
`CHECKS` and `DIFF`, and leaves `PLAN` and `CONTEXT` blank rather than
guessing at them.

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
ctui --agent codex            # or codex, opencode, pi, aider — the name is the command
ctui -- claude --model opus   # everything after -- is the agent's own argv
ctui --name review            # a second session on the same repo
ctui why src/tts.ts:18        # which commit produced this line, and its message
```

Running `ctui` again from the same repo re-attaches to the session already
working there instead of starting a second one beside it. `--name` is for
wanting two on purpose. Quitting the agent ends the session; the panels do
not keep it alive with nothing to watch.

Keys are tmux's, because it is tmux:

```
ctrl-b o    next pane          ctrl-b z    zoom a pane to full screen
ctrl-b ←→   pane by direction  ctrl-b d    detach (the agent keeps working)
mouse       click to focus, drag a border to resize, scroll to scroll back
```

Detaching leaves the agent running. `ctui` from the same repo picks it back up.

## What the panels say

`REPO` is every file with changes against `HEAD`, staged or not — an agent
that ran `git add` has not thereby shown you anything. New files count their
whole length, because `+0 -0` on a file that did not exist an hour ago reads
as "nothing happened here". A file whose checks fail turns red and spends its
count column on the failure count rather than the churn: `+1 -1` is not what
you act on when the file no longer compiles. A file that fails checks appears
even if the agent never touched it — the question is what is broken, and
git's answer to what moved does not contain it.

When the pane is too short for the tree, the nesting is what gets cut and the
list goes flat, worst first. A truncated tree spends its few rows on
directory headers and hides the files under them.

`CHECKS` runs `.ctui/check` (executable) if you have one, otherwise your
`typecheck` or `build` npm script. It runs when the diff stops moving, not on
every keystroke: an agent mid-edit produces a broken tree on purpose, and a
rail that goes red between two halves of one edit is noise. Nothing is ever
reported as passing before it has run.

`CONTEXT` is how full the window is, how much the agent has written, and how
much of its last request came from cache. The last two have no field in any
agent protocol — they are read from the transcript Claude Code writes as it
works. `cache` is the bloat reading: a session re-sending its whole context
every turn shows it collapsing, a healthy one sits near 99% after the first
request. ctui adds nothing to that window; every token in there is the
agent's. An unmeasured window is left blank rather than drawn empty.

The rail's own border says what the agent is doing right now — the one fact
that belongs where the eye already is rather than in a row you have to find.
Claude Code names its pane too, which is why the big pane's border reads
`✳ Claude Code` without ctui writing a character of it.

Colour is an encoding. Green wrote, red failed, dim is background you may
skip. Every glyph is one cell wide in every terminal: the obvious markers
(`●` `○` `▶` `█`) are East-Asian *ambiguous* and render two cells under some
terminal settings, which tears a fixed-width column.

`npm run preview` builds this layout over a fixture repo and prints a
photograph of it — no agent, no waiting on a turn. `PREVIEW_COLS` and
`PREVIEW_ROWS` set the size. That is how to iterate on the panes.

## The review gate

`ctui gate` is the earlier design, still here: ctui drives the agent over ACP
in a throwaway worktree, and nothing reaches your tree until you have read the
diff and the agent has said what could break. What you accept is committed
with your prompt as the subject, which is what `ctui why` reads back.

It is no longer the default, because an agent driven over a protocol loses its
slash commands, its keybinds and its scrollback — the opposite of what the
panels exist to preserve. `npm run preview:gate` paints its frames.

```bash
ctui gate                  # prompt, watch, review, accept
ctui gate --explain        # read-only: ask questions, nothing is kept
```

- worktrees under `.ctui/wt/<name>`, branches `ctui/<name>`, both removed on exit
- `.ctui/` added to `.git/info/exclude`, not your `.gitignore`
- accepting commits to your current branch with `Ctui-Session` / `Ctui-Prompt`
  trailers; nothing is pushed
- accepting into a file you have modified is refused, not merged

## Development

```bash
npm test        # node:test, no framework
npm run typecheck
npm run preview
```

Design: `docs/superpowers/specs/2026-08-19-code-tui-design.md`
