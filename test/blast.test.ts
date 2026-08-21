import test from "node:test";
import assert from "node:assert/strict";
import { blastRadius, symbolFrom } from "../src/blast.js";
import { createWorktree, git } from "../src/git.js";
import { splitDiff } from "../src/diff.js";
import { newRepo, write } from "./helpers.js";

test("symbolFrom extracts function, method, and declaration symbols", () => {
  assert.equal(symbolFrom("func Get(id string) error"), "Get");
  assert.equal(symbolFrom("func (r *Foo) Method() error"), "Method");
  assert.equal(symbolFrom("def retry_after(self, n):"), "retry_after");
  assert.equal(symbolFrom("class Widget:"), "Widget");
  assert.equal(symbolFrom("type Foo struct {"), "Foo");
  assert.equal(symbolFrom(""), "");
  assert.equal(symbolFrom("if (x > 0) {"), "", "a keyword must not be reported as the symbol");
});

test("blastRadius counts callers and how many the agent read", async (t) => {
  const repo = await newRepo(t);
  // Enough body lines that the changed line's 3-line context window doesn't
  // reach back up to the declaration itself: git's xfuncname search walks
  // backward starting just above the hunk's own first shown line, so a
  // declaration line that is itself inside the hunk's shown range is never
  // picked up as the funcname.
  const svc = "package p\n\nfunc Fetch() error {\n\ta := 1\n\tb := 2\n\tc := 3\n\td := 4\n\te := 5\n\tf := 6\n\treturn nil\n}\n";
  await write(repo, "svc.go", svc);
  await write(repo, "caller1.go", "package p\n\nfunc UseIt() error {\n\treturn Fetch()\n}\n");
  await write(repo, "caller2.go", "package p\n\nfunc UseItToo() error {\n\treturn Fetch()\n}\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "init svc");

  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "svc.go", svc.replace("e := 5", "e := 99"));

  const raw = await wt.diff();
  const files = splitDiff(raw);

  const readPaths = new Set(["caller1.go"]);
  const symbols = await blastRadius(wt.path, files, readPaths);

  const fetchSym = symbols.find((s) => s.name === "Fetch");
  assert.ok(fetchSym, `Fetch symbol not found among: ${JSON.stringify(symbols)}`);
  assert.equal(fetchSym!.callers.length, 2, `expected 2 callers, got ${JSON.stringify(fetchSym!.callers)}`);
  assert.ok(!fetchSym!.callers.includes("svc.go"), "the changed file itself must not count as its own caller");
  assert.equal(fetchSym!.readCount, 1);
});

test("blastRadius skips a hunk with no detectable symbol rather than guessing", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "f.txt", "l1\nl2\nl3\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "init f.txt");

  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "f.txt", "l1\nCHANGED\nl3\n");

  const raw = await wt.diff();
  const files = splitDiff(raw);
  assert.equal(files[0].hunks[0].func, "", "test setup should produce an undetectable header");

  const symbols = await blastRadius(wt.path, files, new Set());
  assert.equal(symbols.length, 0, "a hunk with no detectable symbol must be skipped, not guessed at");
});
