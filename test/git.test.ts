import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { applyPatch, commitAccepted, createWorktree, git, why } from "../src/git.js";
import { buildPatch, countOr1, hunkRe, patchPaths, Review, splitDiff } from "../src/diff.js";
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

test("applyPatch lands in the real repo", async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "a.txt", "one\ntwo\n");

  const raw = await wt.diff();
  const patch = buildPatch(splitDiff(raw), () => true);
  await applyPatch(repo, patch);

  const got = await readFile(join(repo, "a.txt"), "utf8");
  assert.equal(got, "one\ntwo\n");
});

// A failed apply must change nothing at all — not even a partial write. The
// review gate's whole promise depends on this: a rejected patch never
// leaves the repo half-changed.
test("applyPatch leaves repo untouched on conflict", async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "a.txt", "agent version\n");
  const raw = await wt.diff();
  const patch = buildPatch(splitDiff(raw), () => true);

  // The user edited the same line in the meantime, without staging it.
  await write(repo, "a.txt", "my version\n");
  const before = await readFile(join(repo, "a.txt"));

  await assert.rejects(applyPatch(repo, patch), "expected a conflict");

  const after = await readFile(join(repo, "a.txt"));
  assert.ok(before.equals(after), "a failed apply must leave the file byte-identical");
});

// Selecting one hunk of two must apply only that hunk. The two edits below
// sit far enough apart (default diff context is 3 lines) to land in
// separate hunks; if the selection logic degraded to "everything selected",
// the second, unselected edit would show up in the repo too.
test("selecting one hunk of two applies only that hunk", async (t) => {
  const repo = await newRepo(t);
  const lines: string[] = [];
  for (let i = 1; i <= 20; i++) lines.push(`l${i}`);
  const original = lines.join("\n") + "\n";
  await write(repo, "a.txt", original);
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "seed a.txt");

  const wt = await createWorktree(repo, "s1");
  const changed = lines.slice();
  changed[1] = "TWO-changed"; // line 2
  changed[17] = "EIGHTEEN-changed"; // line 18
  await write(wt.path, "a.txt", changed.join("\n") + "\n");

  const raw = await wt.diff();
  const r = new Review(raw);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].hunks.length, 2, "the two edits should have landed in separate hunks");

  r.toggle(); // select only hunk 0 (cursor starts at fi=0, hi=0)
  await applyPatch(repo, r.patch());

  const got = (await readFile(join(repo, "a.txt"), "utf8")).split("\n");
  assert.equal(got[1], "TWO-changed", "the selected hunk should have applied");
  assert.equal(got[17], "l18", "the unselected hunk must be absent from the repo");
});

test("commitAccepted writes trailers", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "a.txt", "changed\n");
  await git(repo, "add", "-A");

  await commitAccepted(
    repo,
    ["a.txt"],
    "tts: fall back to silent audio",
    "Falls back to ffmpeg silence when kokoro is missing.\nNot tested without kokoro.",
    "claude-1",
    "add tts, kokoro if available",
  );

  const msg = await git(repo, "log", "-1", "--format=%B");
  for (const want of [
    "tts: fall back to silent audio",
    "Not tested without kokoro.",
    "Ctui-Session: claude-1",
    "Ctui-Prompt: add tts, kokoro if available",
  ]) {
    assert.ok(msg.includes(want), `commit message missing ${JSON.stringify(want)}:\n${msg}`);
  }
});

// Trailers are single-line by definition. A multi-line prompt must be
// folded, not allowed to break the trailer block. Checked against git's own
// trailer parser, not just string-matching the raw message.
test("commitAccepted flattens a multi-line prompt", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "a.txt", "changed\n");
  await git(repo, "add", "-A");

  await commitAccepted(repo, ["a.txt"], "s", "b", "claude-1", "line one\nline two\nline three");

  const msg = await git(repo, "log", "-1", "--format=%B");
  assert.ok(msg.includes("Ctui-Prompt: line one line two line three"), `prompt not flattened:\n${msg}`);

  const out = await git(repo, "log", "-1", "--format=%(trailers:key=Ctui-Prompt,valueonly)");
  assert.notEqual(out.trim(), "", `git does not see the trailer: ${JSON.stringify(out)}`);
  assert.equal(out.trim(), "line one line two line three");
});

// A bare `git commit` commits everything in the index. If the user had
// unrelated work staged before launching ctui, it must never be swept into
// a commit whose trailers claim the agent authored it.
test("commitAccepted ignores unrelated staged work", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "a.txt", "changed\n");
  await write(repo, "mine.txt", "my own staged work\n");
  await git(repo, "add", "-A");

  await commitAccepted(repo, ["a.txt"], "s", "b", "claude-1", "p");

  const out = await git(repo, "show", "--name-only", "--format=", "HEAD");
  assert.ok(!out.includes("mine.txt"), `the user's own staged file was swept into the agent's commit:\n${out}`);

  const status = await git(repo, "status", "--porcelain");
  assert.ok(status.includes("mine.txt"), "the unrelated file should still be staged, just not committed");
});

test("commitAccepted refuses to commit with no paths", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "a.txt", "changed\n");
  await git(repo, "add", "-A");
  await assert.rejects(commitAccepted(repo, [], "s", "b", "claude-1", "p"), "expected a refusal, not a fallback to committing everything");
});

// End-to-end: a rename accepted through the real accept path (diff -> review
// selection -> applyPatch -> patchPaths -> commitAccepted) must leave
// `git status` clean. `git apply --index` stages a rename as a delete of
// the old path plus an add of the new one; if the commit were scoped to
// only the new path, the delete would still be sitting in the index.
test("a rename accepted end-to-end leaves git status clean", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "old.txt", "one\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "add old.txt");

  const wt = await createWorktree(repo, "s1");
  await rename(join(wt.path, "old.txt"), join(wt.path, "new.txt"));

  const raw = await wt.diff();
  const r = new Review(raw);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].hunks.length, 0, "a pure rename has no hunks");
  r.toggle(); // select the whole (hunkless) rename

  await applyPatch(repo, r.patch());
  const paths = patchPaths(r.files, (fi, hi) => r.selected(fi, hi));
  await commitAccepted(repo, paths, "rename old to new", "", "claude-1", "rename old.txt to new.txt");

  const status = await git(repo, "status", "--porcelain");
  assert.equal(status, "", `git status not clean after accepting a rename:\n${status}`);
});

test("why resolves a line to its accepting commit", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "a.txt", "one\ntarget line\n");
  await git(repo, "add", "-A");
  await commitAccepted(repo, ["a.txt"], "add the target", "because the test needs it", "claude-1", "add a target line");

  // Churn the file afterwards, the way a real repo does. `git log -L` must
  // still trace the line back through this.
  await write(repo, "a.txt", "zero\none\ntarget line\nthree\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "unrelated churn");

  const got = await why(repo, "a.txt", 3); // "target line" is now line 3
  assert.ok(got.length > 0, "no provenance found");
  const found = got.some((p) => p.session === "claude-1" && p.prompt === "add a target line");
  assert.ok(found, `accepting commit not in history: ${JSON.stringify(got)}`);
});

test("why on a path with no history errors clearly", async (t) => {
  const repo = await newRepo(t);
  await assert.rejects(why(repo, "nope.txt", 1), "expected an error for a file with no history");
});

// The accept -> keep-working -> accept-again loop: after accepting one hunk
// of two, the next diff() must show only the remaining hunk. Without
// advanceAfterAccept, base never moves and the accepted hunk keeps
// reappearing (and re-applying it would fail as an already-applied patch).
test("advanceAfterAccept makes an accepted hunk disappear from the next diff", async (t) => {
  const repo = await newRepo(t);
  const lines: string[] = [];
  for (let i = 1; i <= 20; i++) lines.push(`l${i}`);
  const original = lines.join("\n") + "\n";
  await write(repo, "a.txt", original);
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "seed a.txt");

  const wt = await createWorktree(repo, "s1");
  const changed = lines.slice();
  changed[1] = "TWO-changed"; // line 2
  changed[17] = "EIGHTEEN-changed"; // line 18
  await write(wt.path, "a.txt", changed.join("\n") + "\n");

  const raw = await wt.diff();
  const r = new Review(raw);
  assert.equal(r.files[0].hunks.length, 2, "the two edits should have landed in separate hunks");
  r.toggle(); // select only hunk 0 (cursor starts at fi=0, hi=0)

  const patch = r.patch();
  const oldBase = wt.base;
  await applyPatch(repo, patch);
  await wt.advanceAfterAccept(patch);

  assert.notEqual(wt.base, oldBase, "base did not advance after a successful accept");

  const d2 = await wt.diff();
  assert.ok(!d2.includes("TWO-changed"), `accepted hunk still present in the next diff:\n${d2}`);
  assert.ok(d2.includes("EIGHTEEN-changed"), `remaining hunk missing from the next diff:\n${d2}`);
});

// advanceAfterAccept is built entirely against a scratch index; it must
// never touch the worktree's real files or its real index.
test("advanceAfterAccept leaves the worktree byte-identical", async (t) => {
  const repo = await newRepo(t); // already has a.txt = "one\n" committed as "init"
  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "a.txt", "one\nchanged\n");

  const raw = await wt.diff(); // stages via `git add -A` as a side effect
  const r = new Review(raw);
  r.toggle();
  const patch = r.patch();
  await applyPatch(repo, patch);

  const beforeContent = await readFile(join(wt.path, "a.txt"));
  const beforeStatus = await git(wt.path, "status", "--porcelain");

  await wt.advanceAfterAccept(patch);

  const afterContent = await readFile(join(wt.path, "a.txt"));
  const afterStatus = await git(wt.path, "status", "--porcelain");

  assert.ok(beforeContent.equals(afterContent), "advanceAfterAccept modified the worktree's files");
  assert.equal(beforeStatus, afterStatus, "advanceAfterAccept modified the worktree's real index");
});

// A rejected apply must leave base exactly where it was — nothing to
// advance to, and no half-applied state to advance into.
test("advanceAfterAccept leaves base unchanged when apply fails", async (t) => {
  const repo = await newRepo(t); // already has a.txt = "one\n" committed as "init"
  const wt = await createWorktree(repo, "s1");
  const originalBase = wt.base;

  const badPatch = "not a valid patch at all\n";
  await assert.rejects(wt.advanceAfterAccept(badPatch), "expected apply --cached to fail on garbage input");
  assert.equal(wt.base, originalBase, "base must not change when the apply fails");
});
