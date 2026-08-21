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

The agent adapter (`@zed-industries/claude-code-acp`) is fetched by `npx` on
first run — nothing to install.

## Use

Run inside any git repo:

```bash
ctui                       # a session: prompt, watch, review, accept
ctui --name auth           # name the session (worktree + branch suffix)
ctui --explain             # read-only: ask questions, nothing is kept
ctui why src/tts.ts:18     # which prompt produced this line, and what the
                           # agent warned about at the time
```

The session screen is a cockpit, not a scrolling log:

```
╭──────────────────────────────────────────────────────────────────────────╮
│ctui/auth · default mode · idle · worktree discarded on exit              │
│REPO                           ▸ Read  src/auth/session.ts                │
│   src/                        ▸ Read  src/auth/token.ts                  │
│     auth/                     Off-by-one in verify(): `<` lets a token   │
│●      session.ts    +2 -0     that expired this millisecond through.     │
│●      token.ts      +1 -1     ▸ Edit  src/auth/token.ts                  │
│● wrote  ○ read                                                           │
│                               src/auth/token.ts:38                       │
│                                 40                                       │
│                                 41 -   if (exp < now())                  │
│                                 41 +   if (exp <= now())                 │
│                                 42       return null                     │
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

`npm run preview` paints that frame from fixture data — no agent, no git —
which is how to iterate on the layout without waiting on a real turn.

Keys:

```
r        open review          space  select hunk / file
tab      patch <-> file view  a      accept selected
A        accept unexplained   esc    interrupt the agent
```

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
