import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createWorktree, git } from "../src/git.js";
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

test("create worktree", async (t) => {
  const repo = await newRepo(t);
  const head = await git(repo, "rev-parse", "HEAD");

  const wt = await createWorktree(repo, "s1");
  assert.equal(wt.base, head);
  assert.equal(wt.branch, "ctui/s1");
  await stat(join(wt.path, "a.txt")); // worktree should contain the repo contents

  // .ctui must be excluded without touching the user's .gitignore.
  const excl = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
  assert.ok(excl.includes(".ctui/"), ".ctui/ was not added to .git/info/exclude");

  await assert.rejects(stat(join(repo, ".gitignore")), "must not create or modify the user's .gitignore");
});

test("create worktree is idempotently excluded", async (t) => {
  const repo = await newRepo(t);
  await createWorktree(repo, "s1");
  await createWorktree(repo, "s2");
  const excl = await readFile(join(repo, ".git", "info", "exclude"), "utf8");
  const count = excl.split(".ctui/").length - 1;
  assert.equal(count, 1, `exclude entry written twice:\n${excl}`);
});

test("create worktree rejects duplicate name", async (t) => {
  const repo = await newRepo(t);
  await createWorktree(repo, "s1");
  await assert.rejects(createWorktree(repo, "s1"), "expected an error for an existing branch");
});

test("destroy worktree", async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1");
  await wt.destroy();
  await assert.rejects(stat(wt.path), "worktree directory should be gone");
  await assert.rejects(git(repo, "rev-parse", "--verify", "ctui/s1"), "branch should be deleted");
});

test("destroy removes worktree with uncommitted work", async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "dirty.txt", "agent left this\n");
  await wt.destroy(); // must force-remove a dirty worktree
});

test("diff includes untracked files", async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1");
  // An agent edits one file and creates another, committing neither.
  await write(wt.path, "a.txt", "one\ntwo\n");
  await write(wt.path, "new.txt", "brand new\n");

  const d = await wt.diff();
  assert.ok(d.includes("a.txt"), "modified file missing from diff");
  assert.ok(d.includes("new.txt"), "untracked file missing from diff — plain `git diff` would miss it");
  assert.ok(d.includes("+brand new"), "new file's contents missing from diff");
});

test("diff is empty when nothing changed", async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1");
  const d = await wt.diff();
  assert.equal(d, "");
});

test("create worktree rolls back on postcreate failure", async (t) => {
  const repo = await newRepo(t);
  // Create a failing postcreate script.
  const postcreateDir = join(repo, ".ctui");
  await mkdir(postcreateDir, { recursive: true });
  const postcreate = join(postcreateDir, "postcreate");
  await writeFile(postcreate, "#!/bin/sh\nexit 1", { mode: 0o755 });
  await chmod(postcreate, 0o755);

  // Attempt to create worktree — postcreate will fail.
  await assert.rejects(createWorktree(repo, "s1"), "expected postcreate to fail");

  // Verify worktree was cleaned up: directory should be gone.
  const wtPath = join(repo, ".ctui", "wt", "s1");
  await assert.rejects(stat(wtPath), "worktree directory should be removed after postcreate failure");

  // Verify branch was cleaned up.
  await assert.rejects(git(repo, "rev-parse", "--verify", "ctui/s1"), "branch ctui/s1 should be deleted after postcreate failure");
});

test("diff hunk headers carry function names", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "svc.go", "package p\n\nfunc Get(id string) error {\n\tx := 1\n\ty := 2\n\tz := 3\n\treturn nil\n}\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "svc");

  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "svc.go", "package p\n\nfunc Get(id string) error {\n\tx := 1\n\ty := 2\n\tz := 4\n\treturn nil\n}\n");

  const d = await wt.diff();
  assert.ok(
    d.includes("@@ ") && d.includes("func Get"),
    `hunk header lost its function name — git is not reading our attributes file:\n${d}`,
  );
});

// The driver must beat git's generic fallback, which reports the enclosing
// class for an indented method — the wrong symbol, and silently wrong.
test("diff finds indented method not enclosing class", async (t) => {
  const repo = await newRepo(t);
  let body = "class Widget:\n    def retry_after(self, n):\n";
  for (let i = 1; i <= 12; i++) {
    body += `        a${i} = ${i}\n`;
  }
  await write(repo, "w.py", body);
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "w");

  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "w.py", body.replace("a10 = 10", "a10 = 99"));

  const d = await wt.diff();
  assert.ok(d.includes("def retry_after"), `want the method in the hunk header, got:\n${d}`);
});

// We must never read, write, or otherwise disturb the repository's own
// attributes file. Users keep real configuration there.
test("diff leaves user attributes file alone", async (t) => {
  const repo = await newRepo(t);
  const attrs = join(repo, ".git", "info", "attributes");
  await mkdir(join(repo, ".git", "info"), { recursive: true });
  const userContent = "*.custom diff=mine\n*.secret filter=crypt\n";
  await writeFile(attrs, userContent, "utf8");

  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "a.txt", "one\ntwo\n");
  for (let i = 0; i < 3; i++) {
    await wt.diff();
  }

  const got = await readFile(attrs, "utf8");
  assert.equal(got, userContent, "ctui modified the user's attributes file");
});

// A file whose final line is blank produces a trailing whitespace-only
// context line in git's diff output. The plain, trimming git() helper
// would strip it, leaving the @@ header's declared counts describing more
// lines than the body actually has — corrupt input for `git apply`. diff()
// must use the untrimmed gitRaw instead.
test("diff preserves trailing blank context line", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "f.txt", "l1\nl2\nl3\nl4\nl5\n\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "add f.txt");

  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "f.txt", "l1\nl2\nl3\nl4\nCHANGED\n\n");

  const raw = await wt.diff();
  assert.match(raw, /\n \n/, `trailing blank context line missing from diff:\n${JSON.stringify(raw)}`);

  const files = splitDiff(raw);
  assert.equal(files.length, 1);
  assert.ok(files[0].hunks.length > 0);
  const h = files[0].hunks[files[0].hunks.length - 1];
  const headerNoNl = h.header.endsWith("\n") ? h.header.slice(0, -1) : h.header;
  const m = hunkRe.exec(headerNoNl);
  assert.ok(m, `hunk header did not parse: ${JSON.stringify(h.header)}`);
  // A non-participating optional group is `undefined` in JS where Go's
  // FindStringSubmatch would give "" — normalize before countOr1 sees it.
  const wantOld = countOr1(m![2] ?? "");
  const wantNew = countOr1(m![4] ?? "");

  let gotOld = 0;
  let gotNew = 0;
  const bodyNoNl = h.body.endsWith("\n") ? h.body.slice(0, -1) : h.body;
  for (const line of bodyNoNl.split("\n")) {
    if (line.startsWith("-")) {
      gotOld++;
    } else if (line.startsWith("+")) {
      gotNew++;
    } else if (line.startsWith("\\")) {
      // no-newline marker; not a counted line
    } else {
      gotOld++;
      gotNew++;
    }
  }
  assert.equal(gotOld, wantOld, `hunk declares -${wantOld} +${wantNew} lines but body has ${gotOld} old, ${gotNew} new`);
  assert.equal(gotNew, wantNew, `hunk declares -${wantOld} +${wantNew} lines but body has ${gotOld} old, ${gotNew} new`);
});

// diff.mnemonicPrefix (c/i instead of a/b) is a user preference for reading
// diffs; we are producing bytes for `git apply`, which needs a/b regardless
// of how the repo (or the user's global config) has this set. diff() must
// neutralize it with an explicit -c, not just rely on git's default.
test("diff ignores user diff config", async (t) => {
  const repo = await newRepo(t);
  await git(repo, "config", "diff.mnemonicPrefix", "true");

  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "a.txt", "one\ntwo\n");

  const raw = await wt.diff();
  assert.ok(
    raw.includes("diff --git a/a.txt b/a.txt"),
    `diff.mnemonicPrefix was not neutralized, want a/b prefixes:\n${raw}`,
  );
  assert.ok(!raw.includes("c/a.txt") && !raw.includes("i/a.txt"), `diff.mnemonicPrefix leaked into the diff:\n${raw}`);

  const files = splitDiff(raw);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "a.txt");
});

// A mode-only change carries no "+++"/"--- " line and no "rename to " line —
// the "diff --git" line is the only path source left. Without
// core.quotePath=false, git C-quotes the non-ASCII name there and the
// fallback (which only handles the unquoted "P b/P" form) returns "".
test("diff path for non-ASCII mode-only file", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "café.sh", "one\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "add café.sh");
  const wt = await createWorktree(repo, "s1");
  await chmod(join(wt.path, "café.sh"), 0o755);

  const raw = await wt.diff();
  assert.ok(raw.includes("old mode 100644"), `test setup did not produce a mode-only change; got:\n${raw}`);
  assert.ok(!raw.includes("\\303"), `core.quotePath=false did not take effect, path still quoted:\n${raw}`);

  const files = splitDiff(raw);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "café.sh");
  await git(wt.path, "ls-files", "--error-unmatch", "--", files[0].path);
});

// Same gap, on a binary file: no "+++" line either, only "Binary files ..."
// and the "diff --git" line.
test("diff path for non-ASCII binary file", async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1");
  await writeFile(join(wt.path, "café.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03]));

  const raw = await wt.diff();
  assert.ok(raw.includes("Binary files"), `test setup did not produce a binary file; got:\n${raw}`);
  assert.ok(!raw.includes("\\303"), `core.quotePath=false did not take effect, path still quoted:\n${raw}`);

  const files = splitDiff(raw);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "café.bin");
  assert.ok(files[0].binary);
  await git(wt.path, "ls-files", "--error-unmatch", "--", files[0].path);
});

// core.quotePath=false only stops git from quoting non-ASCII bytes; a path
// containing an actual control character (a literal tab here) still gets
// C-quoted regardless, and must still come out right through the existing
// unquote branch in pathFromDiffLine — this section has a real "+++" line,
// unlike the two cases above.
test("diff path for tab in filename", async (t) => {
  const repo = await newRepo(t);
  const name = "tab\tname.txt";
  await write(repo, name, "one\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "add tab file");
  const wt = await createWorktree(repo, "s1");
  await write(wt.path, name, "two\n");

  const raw = await wt.diff();
  assert.ok(raw.includes("\\t"), `test setup did not produce a quoted, tab-containing path; got:\n${raw}`);

  const files = splitDiff(raw);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, name);
  await git(wt.path, "ls-files", "--error-unmatch", "--", files[0].path);
});
