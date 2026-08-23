# ctui

A review gate between a coding agent and your codebase.

The agent works in a throwaway git worktree. Nothing reaches your tree until
you have read the diff and the agent has said, in its own words, what could
break. What you accept is committed with your prompt as the subject, so
`ctui why <file>:<line>` still answers "why does this exist" months later.

## Install

Needs Node 20+, git, and the `claude` CLI already logged in.

```bash
git clone <this repo> && cd code-tui
npm install          # builds on install
npm link             # puts `ctui` on your PATH
```

`npm link` is reversible with `npm unlink -g ctui`. To skip it, run
`node /path/to/code-tui/dist/src/index.js` instead of `ctui`.

The agent adapter is fetched by `npx` on first run — nothing to install.
`--agent claude` (the default) uses `@zed-industries/claude-code-acp`,
`--agent codex` uses `@zed-industries/codex-acp`. Both speak ACP, so nothing
above the transport changes; an adapter that does not report a `default` mode
shows up as a degraded mode in the header rather than being assumed safe.

## Use

Run inside any git repo:

```bash
ctui                       # a session: prompt, watch, review, accept
ctui --name auth           # name the session (worktree + branch suffix)
ctui --agent codex         # drive Codex instead of Claude Code
ctui --explain             # read-only: ask questions, nothing is kept
ctui why src/tts.ts:18     # which prompt produced this line, and what the
                           # agent warned about at the time
```

The session screen is a cockpit, not a scrolling log:

```
╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
│ctui/auth · default mode · running 2.0s · worktree discarded on exit                              │
│╭────────────────────────────╮ ╭─────────────────────────────────────────────────────────────────╮│
││REPO                        │ │AGENT ▸                                                          ││
││   src/                     │ │> fix the token expiry off-by-one                                ││
││     auth/                  │ │▸ Read  src/auth/session.ts                                      ││
││▪      session.ts    +2 -0  │ │▸ Read  src/auth/token.ts                                        ││
││▪      token.ts      +1 -1  │ │expiry check is exclusive; a token expiring this exact ms is     ││
││▪ wrote                     │ │still accepted                                                   ││
││                            │ │Off-by-one in verify(): `<` lets a token that expired this       ││
││PLAN                        │ │millisecond through. Changing to `<=`.                           ││
││  ✔ find the expiry         │ │▸ Edit  src/auth/token.ts                                        ││
││    comparison              │ │▸ Edit  src/auth/session.ts                                      ││
││  ▸ fix the off-by-one      │ │✖ Execute  npm test  1.4s                                        ││
││  ☐ add a regression test   │ │⟳ Execute  npm run typecheck  0.6s                               ││
││                            │ │                                                                 ││
││                            │ │src/auth/session.ts:12                                           ││
││                            │ │  12   export class Session {                                    ││
││                            │ │  13 +   private renewals = 0                                    ││
││                            │ │  14 +   renew() { this.renewals++ }                             ││
││                            │ │  15   }                                                         ││
│╰────────────────────────────╯ ╰─────────────────────────────────────────────────────────────────╯│
│CONTEXT ▮▮▮▮▮▮▮▮▯▯▯▯▯▯▯▯  52%  105k/200k  out 12k  cache 99%                                      │
│  [tab] repo map  [r] review  [ctrl-p] open any file                                              │
│>                                                                                                 │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```

Left: every file this session has touched, nested as it sits in the repo,
with how much of each changed, and under it the agent's own plan as a live
checklist. Right: what the agent is saying, and under that the file it is
editing *as it edits it*. Bottom: whether the code still builds, then how
full the context window is — in that order, because one of them is
something to act on and the other is a number.

Both panes carry a label and a border, and the one with the keyboard is the
one lit up. The prompt and the key hints live inside the frame too: a line
you type into that renders below the closing border reads as shell output
that happens to be nearby.

Every tool line carries its own clock. `⟳` is still running, `▸` finished,
`✖` failed — an agent thrashing through failing commands should not look
like one making progress. Anything slower than ten seconds stops rendering
dim, so scanning the column answers "where did the two minutes go".

Colour is an encoding, not decoration. Grey is background you may skip:
reads, thoughts, anything that finished fast. Yellow is a write — the agent
changed a file of yours. Red failed. Cyan is happening right now, which is
also why the top edge turns cyan for the length of a turn. Your own prompts
are the only bold lines in the transcript, so a turn boundary is findable
without reading. Every glyph on screen is one cell wide in every terminal:
the obvious markers (`●` `○` `▶` `█`) are East-Asian *ambiguous* and render
two cells under some terminal settings, which would tear a fixed-width box.
The density bar is braille (`⣀⣤⣶⣿`) for the same reason — the eighth-block
ramp `▁▂▃…█` is ambiguous where braille is not.

`CONTEXT` is how full the agent's window is, how much the agent has written,
and how much of its last request came from cache. ACP has no field for the
last two — its usage update carries `used`, `size` and an optional cost, and
the default adapter never sends even that — so the numbers are read from the
transcript Claude Code writes as it works. They update *during* a turn, not
after it: "is this about to fill the window" has no useful answer that arrives
once the turn is over.

`cache` is the bloat reading. A session re-sending its whole context every
turn shows it collapsing; a healthy one sits near 99% once past the first
request. ctui itself adds nothing to that window — it sends your prompt text
and `mcpServers: []`, so every token in there belongs to the agent. If an
adapter does report its own usage, that number wins and keeps the row, since
it is the window the agent is actually managing. An unmeasured window is left
blank rather than drawn empty.

`tab` moves the keyboard between the two panes — `AGENT ▸` and `REPO ▸`
say which one has it. In the map, `j`/`k` walk the cursor and `⏎`
opens that file — positioned on what this session changed, with the
provenance gutter saying where every other line came from. A map row you can
watch turn red but cannot open is a picture, not an instrument.

```
╭────────────────────────────╮
│REPO ▸                      │
│   src/                     │
│     auth/                  │
│▪      session.ts    +2 -0  │
│✖►     token.ts      ✖1     │
│▪ wrote  ✖ failing          │
│                            │
│PLAN                        │
│  ✔ find the expiry         │
│    comparison              │
│  ▸ fix the off-by-one      │
│  ☐ add a regression test   │
╰────────────────────────────╯
```

A red row carries how many failures are in it, not how much it changed —
`+1 -1` is not what you do something about when the file no longer builds.
Walk the cursor onto that row and `CHECKS` becomes that file's failures:

```
│✖►     token.ts      ✖1     │
╰────────────────────────────╯
│CHECKS  src/auth/token.ts  ✖ 1
│  ✖ line 41  error TS2532: Object is possibly undefined.
```

That is also the way out of `…and N more` — the project-wide list is capped,
and moving the cursor is how you reach what it cut. Hand the keyboard back to
the prompt and the pane goes back to the whole project.

`npm run preview` paints these frames from fixture data — no agent, no git —
which is how to iterate on the layout without waiting on a real turn. It
prints four: mid-turn, finished, the map focused, and the file that opens
from it.

Keys:

```
tab      focus repo map / back  space   select hunk / file
j/k      move / scroll          a       accept selected
⏎        open the file          A       accept unexplained
r        open review            esc     interrupt the agent
ctrl-p   open any file
```

Inside review, `tab` switches the patch and file views instead.

### What review shows you

```
OUTLINE   ⣀⣀⣤⣿⣀⣀⣀⣀⣀⣀⣀⣀          which functions changed, and where in
  verify()          +1 -1       the file the edits landed
  Session.renew()   +2 -0

── 2026-06-02  a1b2c3d4  add token renewal      the prompt that produced
      41   this.renewals++                     each run of lines, while
── this session                                you read the file
+     42   if (exp <= now())
```

`CHECKS` runs the project's own checker in the worktree after each turn.
`.ctui/check` (executable) if you have one, otherwise your `typecheck` or
`build` npm script. Failing files turn red in the repo map and carry their
failure count, and the count sits directly above the accept key — accept is
informed, never blocked.

`a` stays disabled until the agent has answered what changed, what could
break, and what it did not test. `A` accepts anyway and records
`Ctui-Prompt: <none>` — an unexplained change is allowed, never invisible.

## What it does to your repo

- worktrees under `.ctui/wt/<name>`, branches `ctui/<name>`, both removed on exit
- `.ctui/` added to `.git/info/exclude`, not your `.gitignore`
- accepting commits to your current branch with `Ctui-Session` / `Ctui-Prompt`
  trailers; nothing is pushed
- accepting into a file you have modified is refused, not merged

If `.ctui/postcreate` exists and is executable, it runs after a worktree is
created — that is where `npm install` for the fresh worktree goes.

## Development

```bash
npm test        # node:test, no framework
npm run typecheck
```

Design: `docs/superpowers/specs/2026-08-19-code-tui-design.md`
