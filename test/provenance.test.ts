import assert from "node:assert/strict";
import test from "node:test";
import { splitDiff } from "../src/diff.js";
import { git, gitRaw } from "../src/git.js";
import { commitLabels, lineOrigins, mapToOld, parseBlame, PENDING } from "../src/provenance.js";
import { newRepo, write } from "./helpers.js";

// One file, one hunk: line 2 replaced, line 3 inserted after it.
const DIFF = [
  "diff --git a/f.txt b/f.txt",
  "index 1111111..2222222 100644",
  "--- a/f.txt",
  "+++ b/f.txt",
  "@@ -1,4 +1,5 @@",
  " one",
  "-two",
  "+TWO",
  "+two-and-a-half",
  " three",
  " four",
  "",
].join("\n");

test("mapToOld maps context lines back and marks added lines as new", () => {
  const toOld = mapToOld(splitDiff(DIFF)[0]!);
  assert.equal(toOld(1), 1); // context before the change
  assert.equal(toOld(2), 0); // "TWO" replaced "two" — it is new
  assert.equal(toOld(3), 0); // inserted outright
  assert.equal(toOld(4), 3); // "three" shifted down by one
  assert.equal(toOld(5), 4);
});

test("mapToOld keeps its bearings past the end of the last hunk", () => {
  // A line the diff never mentions still has to resolve, and it has to
  // resolve through the drift the hunks introduced — not to itself.
  const toOld = mapToOld(splitDiff(DIFF)[0]!);
  assert.equal(toOld(50), 49);
});

test("mapToOld handles a pure deletion, where the new file is shorter", () => {
  const diff = [
    "diff --git a/f.txt b/f.txt",
    "index 1111111..2222222 100644",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1,4 +1,2 @@",
    " one",
    "-two",
    "-three",
    " four",
    "",
  ].join("\n");
  const toOld = mapToOld(splitDiff(diff)[0]!);
  assert.equal(toOld(1), 1);
  assert.equal(toOld(2), 4); // "four" moved up by the two deleted lines
  assert.equal(toOld(9), 11);
});

test("mapToOld tracks drift across several hunks", () => {
  const diff = [
    "diff --git a/f.txt b/f.txt",
    "index 1111111..2222222 100644",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1,2 +1,3 @@",
    " a",
    "+inserted",
    " b",
    "@@ -20,2 +21,4 @@",
    " t",
    "+x",
    "+y",
    " u",
    "",
  ].join("\n");
  const toOld = mapToOld(splitDiff(diff)[0]!);
  assert.equal(toOld(2), 0); // the first insertion
  assert.equal(toOld(10), 9); // between the hunks: one line of drift
  assert.equal(toOld(22), 0); // "x"
  assert.equal(toOld(30), 27); // after both hunks: three lines of drift
});

test("parseBlame reads the porcelain header and ignores everything else", () => {
  const porcelain = [
    "1111111111111111111111111111111111111111 1 1 2",
    "author Someone",
    "\tone",
    "1111111111111111111111111111111111111111 2 2",
    "\ttwo",
    "2222222222222222222222222222222222222222 7 3 1",
    "author Other",
    // A line of file content that looks exactly like a header must not be
    // read as one — content lines are TAB-prefixed, headers are not.
    "\t3333333333333333333333333333333333333333 9 9 1",
    "\tthree",
  ].join("\n");
  assert.deepEqual(
    [...parseBlame(porcelain).entries()],
    [
      [1, "1111111111111111111111111111111111111111"],
      [2, "1111111111111111111111111111111111111111"],
      [3, "2222222222222222222222222222222222222222"],
    ],
  );
});

test("commitLabels prefers the prompt trailer over the subject", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "b.txt", "x\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "tts: fall back to silent audio\n\nCtui-Prompt: add tts, kokoro if available");
  const withTrailer = await git(repo, "rev-parse", "HEAD");
  const plain = await git(repo, "rev-parse", "HEAD~1");

  const labels = await commitLabels(repo, [withTrailer, plain]);
  assert.equal(labels.get(withTrailer)!.label, "add tts, kokoro if available");
  // A hand-written commit still has a provenance; it just isn't a prompt.
  assert.equal(labels.get(plain)!.label, "init");
});

test("commitLabels ignores the all-zero sha blame uses for uncommitted lines", async (t) => {
  const repo = await newRepo(t);
  const labels = await commitLabels(repo, ["0".repeat(40), ""]);
  assert.equal(labels.size, 0);
});

test("lineOrigins labels kept lines by their commit and new lines as this session", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "f.txt", "one\ntwo\nthree\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "add f\n\nCtui-Prompt: create the f file");

  // The change under review: line 2 rewritten, a line inserted after it.
  await write(repo, "f.txt", "one\nTWO\ninserted\nthree\n");
  await git(repo, "add", "-A");
  const diff = splitDiff(await gitRaw(repo, "diff", "--cached", "HEAD"))[0]!;

  const origins = await lineOrigins(repo, "f.txt", 4, diff);
  assert.equal(origins.get(1)!.label, "create the f file");
  assert.equal(origins.get(2)!.label, PENDING.label);
  assert.equal(origins.get(3)!.label, PENDING.label);
  // "three" was never touched, so it still belongs to the commit that
  // introduced it — even though it now sits one line further down.
  assert.equal(origins.get(4)!.label, "create the f file");
});

test("lineOrigins attributes a whole file the agent created to this session", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "brand-new.ts", "a\nb\n");
  await git(repo, "add", "-A");
  const diff = splitDiff(await gitRaw(repo, "diff", "--cached", "HEAD"))[0]!;

  const origins = await lineOrigins(repo, "brand-new.ts", 2, diff);
  // It does not exist at HEAD, so blame cannot run — every line is ours.
  assert.equal(origins.get(1)!.label, PENDING.label);
  assert.equal(origins.get(2)!.label, PENDING.label);
});

test("lineOrigins works on an unchanged file, where every line is history", async (t) => {
  const repo = await newRepo(t);
  const origins = await lineOrigins(repo, "a.txt", 1, undefined);
  assert.equal(origins.get(1)!.label, "init");
});
