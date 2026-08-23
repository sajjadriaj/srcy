import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { git } from "../src/git.js";
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

