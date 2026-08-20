import { chmod, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildPatch, splitDiff } from "../src/diff.js";
import { createWorktree, git } from "../src/git.js";
import { newRepo, write } from "./helpers.js";

const twoFileDiff = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,3 @@ func Get(id string) error
 one
+two
 three
@@ -10 +11,2 @@ func retryAfter() int
 ten
+eleven
diff --git a/b.txt b/b.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/b.txt
@@ -0,0 +1 @@
+brand new
`;

test("splitDiff separates files and hunks", () => {
  const files = splitDiff(twoFileDiff);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, "a.txt");
  assert.equal(files[1].path, "b.txt");
  assert.equal(files[0].hunks.length, 2);
  assert.equal(files[0].hunks[0].func, "func Get(id string) error");
  assert.equal(files[0].hunks[1].newStart, 11);
  assert.equal(files[0].hunks[1].newCount, 2);
  assert.equal(files[0].hunks[0].body, " one\n+two\n three\n");
  // b.txt's hunk uses the omitted-count form on both sides ("-0,0 +1"), so
  // this is what actually exercises countOr1's default-to-1 branch: the
  // other two hunks above either spell the count out explicitly or are
  // covered by newCount/newStart instead of body.
  assert.equal(files[1].hunks.length, 1);
  assert.equal(files[1].hunks[0].body, "+brand new\n");
});

// The dangerous case: a context line that looks like a file boundary.
// Line counts, not string matching, decide where a hunk ends.
test("splitDiff survives diff text inside a hunk", () => {
  const raw = `diff --git a/doc.md b/doc.md
--- a/doc.md
+++ b/doc.md
@@ -1,3 +1,4 @@
 Example output:
+diff --git a/fake.txt b/fake.txt
 @@ -1,1 +1,1 @@
 done
`;
  const files = splitDiff(raw);
  assert.equal(files.length, 1, "embedded diff text split the hunk");
  assert.equal(files[0].hunks.length, 1);
  const wantBody = " Example output:\n+diff --git a/fake.txt b/fake.txt\n @@ -1,1 +1,1 @@\n done\n";
  assert.equal(files[0].hunks[0].body, wantBody);
});

test("splitDiff handles binary files", () => {
  const raw = `diff --git a/img.png b/img.png
index 1111111..2222222 100644
Binary files a/img.png and b/img.png differ
`;
  const files = splitDiff(raw);
  assert.equal(files.length, 1);
  assert.ok(files[0].binary, "binary file not detected");
  assert.equal(files[0].hunks.length, 0, "binary files have no hunks");
});

test("splitDiff preserves no-newline marker", () => {
  const raw = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-one
+two
\\ No newline at end of file
`;
  const files = splitDiff(raw);
  const wantBody = "-one\n+two\n\\ No newline at end of file\n";
  assert.equal(files[0].hunks[0].body, wantBody);
});

test("buildPatch keeps only selected hunks", () => {
  const files = splitDiff(twoFileDiff);
  // Take only a.txt's second hunk.
  const patch = buildPatch(files, (fi, hi) => fi === 0 && hi === 1);

  assert.ok(patch.includes("+eleven"), "selected hunk missing");
  assert.ok(!patch.includes("+two"), "unselected hunk leaked into the patch");
  assert.ok(!patch.includes("b.txt"), "a file with no selected hunks must be omitted entirely");
  assert.ok(patch.startsWith("diff --git a/a.txt b/a.txt\n"), "file header missing — git apply needs it");
});

test("buildPatch includes binary file when selected", () => {
  const raw = `diff --git a/img.png b/img.png
index 1111111..2222222 100644
Binary files a/img.png and b/img.png differ
`;
  const files = splitDiff(raw);
  const patch = buildPatch(files, () => true);
  assert.ok(patch.includes("Binary files"), "a selected binary file must keep its whole section");
});

// Guards against a naive implementation that scans for the next line
// starting with "@@ " or "diff --git " instead of consuming exactly the
// counts the @@ header declares. The trailing junk line here has neither
// prefix, so a prefix-scanning splitter would swallow it into the hunk
// body; a count-based one stops exactly where the header says to.
test("splitDiff stops at declared hunk counts", () => {
  const raw =
    "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n" +
    "@@ -1,1 +1,1 @@\n-one\n+two\n" +
    "An unprefixed trailing line, not part of the hunk.\n";
  const files = splitDiff(raw);
  const want = "-one\n+two\n";
  assert.equal(files[0].hunks[0].body, want, "a prefix scan would have swallowed the trailing line");
});

// An @@ line that fails to parse must not delete the hunk body that follows
// it, nor swallow every later hunk in the file as junk.
test("splitDiff recovers from unparseable hunk header", () => {
  const raw =
    "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n" +
    "@@ -x,y +z,w @@\n-old\n+new\n" +
    "@@ -10,1 +10,2 @@\n ten\n+eleven\n";
  const files = splitDiff(raw);
  assert.equal(files.length, 1);
  assert.equal(files[0].hunks.length, 2, "a later hunk was discarded as junk");
  assert.equal(files[0].hunks[0].body, "-old\n+new\n");
  assert.equal(files[0].hunks[1].body, " ten\n+eleven\n");
});

// The no-newline marker can also appear mid-hunk, attached to a removed
// line, not just trailing the whole hunk — a different code path from the
// trailing case above: it fires while the line budget is still open, not
// after it has been exhausted.
test("splitDiff keeps no-newline marker mid-hunk", () => {
  const raw =
    "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n" +
    "@@ -1,2 +1,3 @@\n one\n-two\n\\ No newline at end of file\n+two\n+three\n";
  const files = splitDiff(raw);
  const want = " one\n-two\n\\ No newline at end of file\n+two\n+three\n";
  assert.equal(files[0].hunks[0].body, want);
});

// buildPatch never reads Path, but a later task scopes a `git commit` by
// it, so it must survive spaces and git's quoting intact rather than the
// mangled output of splitting the "diff --git" line on whitespace.
test("splitDiff path survives spaces and quoting", async (t) => {
  const cases: Array<{ name: string; raw: string; want: string }> = [
    {
      // git appends a TAB after any path containing a space, on both
      // the old and new side alike — the unified-diff convention that
      // separates a path from an optional trailing timestamp.
      name: "unquoted path with spaces",
      raw:
        "diff --git a/my file.txt b/my file.txt\n" +
        "index 1111111..2222222 100644\n" +
        "--- a/my file.txt\t\n" +
        "+++ b/my file.txt\t\n" +
        "@@ -1,1 +1,1 @@\n" +
        "-old\n" +
        "+new\n",
      want: "my file.txt",
    },
    {
      name: "git-quoted non-ASCII path",
      raw:
        'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n' +
        "index 1111111..2222222 100644\n" +
        '--- "a/caf\\303\\251.txt"\n' +
        '+++ "b/caf\\303\\251.txt"\n' +
        "@@ -1,1 +1,1 @@\n" +
        "-old\n" +
        "+new\n",
      want: "café.txt",
    },
    {
      // Same TAB-after-a-space rule as above, but now the path is also
      // quoted (non-ASCII bytes trigger quoting independently of the
      // space): the tab sits outside the closing quote, and unquoting
      // must still succeed.
      name: "quoted path with spaces",
      raw:
        'diff --git "a/caf\\303\\251 report.txt" "b/caf\\303\\251 report.txt"\n' +
        "index 1111111..2222222 100644\n" +
        '--- "a/caf\\303\\251 report.txt"\t\n' +
        '+++ "b/caf\\303\\251 report.txt"\t\n' +
        "@@ -1,1 +1,1 @@\n" +
        "-old\n" +
        "+new\n",
      want: "café report.txt",
    },
    {
      name: "deletion uses the old-side name",
      raw:
        "diff --git a/gone.txt b/gone.txt\n" +
        "deleted file mode 100644\n" +
        "index 1111111..0000000\n" +
        "--- a/gone.txt\n" +
        "+++ /dev/null\n" +
        "@@ -1,1 +0,0 @@\n" +
        "-bye\n",
      want: "gone.txt",
    },
    {
      // Regression: stripping BOTH "a/" and "b/" off the same value
      // (instead of only the side's own prefix) eats a real directory
      // component whenever it happens to be named "b". A deletion is
      // the case that actually exercises it — the old side ("--- ")
      // is only ever consulted when the new side is /dev/null.
      name: "deletion under a directory literally named b",
      raw:
        "diff --git a/b/x.txt b/b/x.txt\n" +
        "deleted file mode 100644\n" +
        "index 1111111..0000000\n" +
        "--- a/b/x.txt\n" +
        "+++ /dev/null\n" +
        "@@ -1,1 +0,0 @@\n" +
        "-one\n",
      want: "b/x.txt",
    },
  ];
  for (const c of cases) {
    await t.test(c.name, () => {
      const files = splitDiff(c.raw);
      assert.equal(files.length, 1);
      assert.equal(files[0].path, c.want);
    });
  }
});

// A hunkless section — a pure rename or a mode-only change — must survive
// selecting everything, and its Path must survive intact even when the
// section has no `+++`/`--- ` line to read it from (so it falls back to the
// `rename to ` line or the `diff --git` line instead). Both file names below
// contain a space specifically to exercise that fallback, real git output
// only: a hand-written fixture is how the original hunkless-section bug was
// missed the first time, and space-free names are how the fallback's own
// space-mangling bug was missed the second time.
test("buildPatch keeps hunkless file sections", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "ren me.txt", "one\n");
  await write(repo, "modeonly space.txt", "one\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "add files with spaces");
  const wt = await createWorktree(repo, "s1");
  await rename(join(wt.path, "ren me.txt"), join(wt.path, "renamed here.txt"));
  await chmod(join(wt.path, "modeonly space.txt"), 0o755);

  const raw = await wt.diff();
  assert.ok(
    raw.includes("rename from ren me.txt") && raw.includes("old mode 100644"),
    `test setup did not produce a rename and a mode change; got:\n${raw}`,
  );

  const files = splitDiff(raw);
  const wantPaths = new Map<string, boolean>([
    ["renamed here.txt", false],
    ["modeonly space.txt", false],
  ]);
  for (const f of files) {
    if (wantPaths.has(f.path)) wantPaths.set(f.path, true);
  }
  for (const [path, found] of wantPaths) {
    assert.ok(found, `no section had Path == "${path}" — a space in a hunkless section's path was mangled`);
  }

  const patch = buildPatch(files, () => true);
  assert.equal(patch, raw, "hunkless sections lost when selecting everything");
});

// The unit tests above use hand-written diffs. This one proves the splitter
// survives git's real output and that the reassembled patch still applies.
//
// applyPatch is implemented in Task 8; until then this test is skipped, and
// the call to it stays commented out below so the file still type-checks
// (a skipped test's body is still type-checked — an undefined reference
// would fail the build even though the test never runs).
test(
  "buildPatch round-trips through git apply",
  { skip: "unskipped in Task 8, once applyPatch exists" },
  async (t) => {
    const repo = await newRepo(t);
    const wt = await createWorktree(repo, "s1");
    await write(wt.path, "a.txt", "one\ntwo\n");
    await write(wt.path, "new.txt", "brand new\n");

    const raw = await wt.diff();
    const patch = buildPatch(splitDiff(raw), () => true);
    assert.equal(patch, raw, "selecting everything must reproduce the diff byte for byte");
    // await applyPatch(repo, patch);
    const got = await readFile(join(repo, "new.txt"), "utf8");
    assert.equal(got, "brand new\n");
  },
);
