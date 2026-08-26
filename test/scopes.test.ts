import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { git } from "../src/git.js";
import { captureTree, scopedDiff } from "../src/scopes.js";
import { newRepo, write } from "./helpers.js";

// The reason this exists rather than a commit or a stash: the user is
// working in this repo while srcy watches it, and a baseline that moved
// their index or their files would be a bug they cannot undo.
test("capturing a baseline leaves the index and the worktree exactly as they were", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "staged.txt", "staged\n");
  await git(repo, "add", "staged.txt");
  await write(repo, "dirty.txt", "dirty\n");
  const gitDir = await git(repo, "rev-parse", "--absolute-git-dir");

  const indexBefore = await readFile(join(gitDir, "index"));
  const statusBefore = await git(repo, "status", "--porcelain", "-uall");

  const tree = await captureTree(repo);
  assert.notEqual(tree, null, "no baseline captured");
  assert.match(tree!, /^[0-9a-f]{40}$/);

  assert.deepEqual(await readFile(join(gitDir, "index")), indexBefore, "the real index moved");
  assert.equal(await git(repo, "status", "--porcelain", "-uall"), statusBefore, "the worktree moved");
  // Still staged, still dirty, still untracked — nothing was committed.
  assert.match(statusBefore, /^A  staged\.txt$/m);
  assert.match(statusBefore, /^\?\? dirty\.txt$/m);
});

test("a baseline covers staged, unstaged and untracked alike", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "tracked.txt", "before\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "second");

  const base = (await captureTree(repo))!;

  // One of each: an edit to a tracked file, a staged edit, a brand new file
  // git has never seen, and a deletion.
  await write(repo, "tracked.txt", "after\n");
  await write(repo, "staged.txt", "staged\n");
  await git(repo, "add", "staged.txt");
  await write(repo, "fresh.txt", "brand new\n");
  await rm(join(repo, "a.txt"));

  const files = await scopedDiff(repo, base);
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ["a.txt", "fresh.txt", "staged.txt", "tracked.txt"]);
  const fresh = files.find((f) => f.path === "fresh.txt")!;
  assert.match(fresh.hunks[0]!.body, /\+brand new/, "a file git has never seen is the change most worth reading");
});

test("a baseline taken after the change reports nothing changed", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "a.txt", "edited\n");
  const late = (await captureTree(repo))!;
  assert.deepEqual(await scopedDiff(repo, late), [], "the baseline swallowed the edit it was taken after");
  await write(repo, "a.txt", "edited again\n");
  assert.deepEqual(
    (await scopedDiff(repo, late)).map((f) => f.path),
    ["a.txt"],
  );
});

test("a directory that is not a repository yields no baseline rather than a wrong one", async (t) => {
  const repo = await newRepo(t);
  const outside = join(repo, "..", "srcy-not-a-repo");
  t.after(() => rm(outside, { recursive: true, force: true }));
  await stat(repo); // sanity: the fixture exists
  assert.equal(await captureTree(outside), null);
});
