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
╭──────────────────────────────────────────────────────────────────────────╮
│ctui/auth · default mode · running 2.0s · worktree discarded on exit      │
│REPO                           > fix the token expiry off-by-one          │
│   src/                        ▸ Read  src/auth/session.ts                │
│     auth/                     Off-by-one in verify(): `<` lets a token   │
│●      session.ts    +2 -0     that expired this millisecond through.     │
│●      token.ts      +1 -1     ▸ Edit  src/auth/token.ts                  │
│● wrote  ○ read                ✖ Execute  npm test  1.4s                  │
│                               ⟳ Execute  npm run typecheck  6.2s         │
│                               src/auth/token.ts:38                       │
│                                 40                                       │
│                                 41 -   if (exp < now())                  │
│                                 41 +   if (exp <= now())                 │
│                                 42       return null                     │
│CONTEXT ████████░░░░░░░░  52%  105k/200k  $0.41                           │
│CHECKS  .ctui/check  ✖ failing                                            │
│  ✖ src/auth/token.ts:41  error TS2532: Object is possibly undefined.     │
│PLAN                                                                      │
│  ✔ find the expiry comparison                                            │
│  ▸ fix the off-by-one                                                    │
│  ☐ add a regression test                                                 │
╰──────────────────────────────────────────────────────────────────────────╯
```

Left: every file this session has touched, nested as it sits in the repo,
with how much of each changed. Right: what the agent is saying, and under it
the file it is editing *as it edits it*. Bottom: the agent's own plan as a
live checklist.

Every tool line carries its own clock. `⟳` is still running, `▸` finished,
`✖` failed — an agent thrashing through failing commands should not look
like one making progress. Anything slower than ten seconds stops rendering
dim, so scanning the column answers "where did the two minutes go".

`CONTEXT` is how full the agent's window is, and what the session has cost.
It appears only if the agent reports it — ACP's usage update is optional and
several adapters never send one. An unmeasured window is left blank rather
than drawn empty.

`npm run preview` paints that frame from fixture data — no agent, no git —
which is how to iterate on the layout without waiting on a real turn. It
prints two frames, mid-turn and finished, because the cockpit spends most of
its life in the first one.

Keys:

```
r        open review          space   select hunk / file
tab      patch <-> file view  a       accept selected
A        accept unexplained   esc     interrupt the agent
ctrl-p   open any file        j/k     move / scroll
```

### What review shows you

```
OUTLINE   ▁▁▃█▁▁▁▁▁▂▁▁          which functions changed, and where in
  verify()          +1 -1       the file the edits landed
  Session.renew()   +2 -0

── 2026-06-02  a1b2c3d4  add token renewal      the prompt that produced
      41   this.renewals++                     each run of lines, while
── this session                                you read the file
+     42   if (exp <= now())
```

`CHECKS` runs the project's own checker in the worktree after each turn.
`.ctui/check` (executable) if you have one, otherwise your `typecheck` or
`build` npm script. Failing files turn red in the repo map, and the count
sits directly above the accept key — accept is informed, never blocked.

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
