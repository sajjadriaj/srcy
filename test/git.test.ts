import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { git } from "../src/git.js";
import { repoState } from "../src/repo.js";

import { countOr1, hunkRe, splitDiff } from "../src/diff.js";
import { newRepo, write } from "./helpers.js";

test("git returns trimmed stdout", async (t) => {
  const repo = await newRepo(t);
  const out = await git(repo, "rev-parse", "--abbrev-ref", "HEAD");
  assert.equal(out, "main");
});

test("git error includes stderr", async (t) => {
  const repo = await newRepo(t);
  await assert.rejects(git(repo, "rev-parse", "--verify", "no-such-ref"), (err: unknown) => {
    assert.match((err as Error).message, /no-such-ref/);
    return true;
  });
});


test("a repo with no commit yet still has a working tree to show", async (t) => {
  // `git diff HEAD` has no HEAD to diff against on an unborn branch, and
  // the rail went blank with no word about why — on exactly the repo a
  // reader has just created for the agent to fill.
  const dir = await mkdtemp(join(tmpdir(), "srcy-unborn-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await git(dir, "init", "-q", "-b", "main");
  await writeFile(join(dir, "a.txt"), "one\n");
  await git(dir, "add", "-A");
  await writeFile(join(dir, "b.txt"), "two\n");
  const s = await repoState(dir);
  assert.deepEqual(
    s.files.map((f) => [f.path, f.touch, f.added]),
    [
      ["a.txt", "added", 1],
      ["b.txt", "added", 1],
    ],
  );
  // And the staged one has a diff to review, not just a row.
  assert.equal(s.diffs.find((f) => f.path === "a.txt")?.hunks.length, 1);
});
