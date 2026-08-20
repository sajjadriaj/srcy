# ctui — TypeScript migration

**Why.** There is no Go ACP client (`zed-industries/agent-client-protocol-go` → 404), so Go forces us to hand-roll the transport. That one file, `acp.go`, accounted for ~40% of all spend, every Critical finding in the project, and still has two open Important findings (silent update loss on agent exit; permissions still blocking the read loop). Zed publishes `@agentclientprotocol/sdk` — the same package `claude-code-acp` itself depends on — which makes wire-shape mismatches impossible by construction.

Node is already a hard runtime dependency, because `claude-code-acp` runs under `npx`. A Go binary that shells out to node does not avoid node; it adds a second toolchain.

**What carries over.** The git and diff logic is proven and its bugs are paid for. We port the FIXED versions, and the verification harnesses transfer directly. Nothing about the four diff fix rounds repeats.

## Layout

```
package.json      tsconfig.json
src/git.ts        worktree, diff capture, patch apply, commit, why
src/diff.ts       unified-diff split/reassemble, review state
src/acp.ts        thin wrapper over @agentclientprotocol/sdk
src/ui.tsx        Ink TUI
src/index.ts      entry, subcommands
test/*.test.ts    node:test
```

Runtime: Node 20+. Test runner: built-in `node:test` via `tsx`. No test framework, no assertion library — same rule as the Go tree.

## Invariants that were expensive to learn — do not regress these

These are not style preferences. Each cost at least one review round.

1. **Diff bytes must not be trimmed.** `git()` trimming stdout deleted trailing whitespace-only context lines, leaving `@@` counts describing more lines than the body carried; `git apply` rejects it as a corrupt patch. Diff capture uses an untrimmed variant.
2. **Stage before diffing.** `git add -A` then `git diff --cached <base>`; plain `git diff` omits every file the agent created.
3. **Never write the repo's `.git/info/attributes`.** Users keep real configuration there. Pass `-c core.attributesFile=<our file in .ctui>` per invocation instead.
4. **Neutralize the user's diff config on every diff call:** `-c diff.mnemonicPrefix=false -c diff.noprefix=false -c core.quotePath=false --no-ext-diff --no-textconv`. Without these, `Path` parses wrong on machines configured unlike ours, and non-ASCII names arrive octal-escaped.
5. **Hunk boundaries come from the `@@` line counts, never from string-matching the next `diff --git`.** Context lines that look like diff text are common in docs and fixtures.
6. **Hunk bodies are moved as raw bytes and never reserialized.** They go to `git apply` unmodified.
7. **A file section with zero hunks is still a change** — mode-only and 100% renames. Dropping them silently loses the rename.
8. **Path comes from the `+++ ` line**, falling back to `--- ` for deletions and to `rename to ` for pure renames. Strip the trailing TAB git appends when a path contains a space, BEFORE unquoting. Strip only that side's own prefix.
9. **Commits are scoped to the patch's paths** (`git commit -- <paths>`), or the user's own staged work gets swept in under the agent's provenance trailers.
10. **Scrub `CLAUDECODE` and `CLAUDE_CODE_SSE_PORT`** from the agent's environment or the adapter refuses to start.
11. **`tool_call.locations[].path` is absolute**; relativize against the session cwd or blast radius never matches `git grep` output.
12. **A permission prompt must never render blank or carry control characters** — the agent controls that string.

## Tasks

1. **Scaffold + port `git.ts`.** package.json, tsconfig, test wiring, then a faithful port of the fixed `git.go` and `git_test.go`.
2. **Port `diff.ts`.** Faithful port of the fixed `diff.go` and `diff_test.go`, including the adversarial fixtures.
3. **`acp.ts` over the SDK**, plus live verification against `claude-code-acp`.
4. **Delete the Go tree.** Only once 1-3 are green.
5. **Tasks 6-13 of the original plan**, in Ink: TUI shell, review pane, file view, explain-before-accept, commit trailers, `ctui why`, blast radius, read-only sessions.

Original plan and its task briefs remain the authority for behavior: `docs/superpowers/plans/2026-08-20-ctui-v1.md`.
