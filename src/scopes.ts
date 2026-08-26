import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitDiff, type FileDiff } from "./diff.js";
import { git, gitRaw, gitWith } from "./git.js";

// Three baselines, because "what changed" is three different questions.
//
//   TURN     since the agent's newest request, or a checkpoint you set
//   SESSION  since srcy opened this repo
//   HEAD     every uncommitted line, which is what the rail has always shown
//
// A baseline is a git tree object, captured through a throwaway index. The
// real index is copied, `git add -A` runs against the copy, and the tree is
// written from that — so the capture sees staged, unstaged and untracked
// content alike while the user's index and worktree are never touched. srcy
// does not stage, commit, or revert anything; this is the whole reason the
// scopes are built this way rather than out of `git stash` or a commit.
//
// The objects it writes are unreachable and go away with normal gc.

// captureTree records what the worktree contains right now, or null if git
// could not answer — a repo mid-rebase, a locked index, no permission. A
// null baseline is reported as an unavailable scope, never quietly swapped
// for HEAD: a diff labelled TURN that is actually every uncommitted line is
// the one failure that would make the label worth less than nothing.
export async function captureTree(repo: string): Promise<string | null> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "srcy-index-"));
    const index = join(dir, "index");
    const gitDir = await git(repo, "rev-parse", "--absolute-git-dir");
    // Copied rather than started empty so git keeps its stat cache and
    // re-hashes only what actually moved. A repo with nothing staged yet has
    // no index file at all, which is not an error — the copy is an
    // optimisation, and `add -A` fills an empty index just as well.
    await copyFile(join(gitDir, "index"), index).catch(() => {});
    const env = { GIT_INDEX_FILE: index };
    await gitWith(repo, env, "add", "-A");
    return await gitWith(repo, env, "write-tree");
  } catch {
    return null;
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// scopedDiff is the change from a baseline to what the tree holds now.
//
// Tree against tree, not tree against worktree: `git diff <tree>` leaves out
// every untracked file, and a file the agent created this turn is the change
// most worth reading. The cost is one more capture per call.
//
// ponytail: a capture per poll while a scope is selected. It is one
// `git add -A` against a warm copied index, which re-hashes only changed
// files; if a repo turns up where that is felt, cache it on the repo mark.
export async function scopedDiff(repo: string, base: string): Promise<FileDiff[]> {
  const now = await captureTree(repo);
  if (now === null) return [];
  const raw = await gitRaw(repo, "diff", base, now).catch(() => "");
  return splitDiff(raw);
}
