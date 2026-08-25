import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { checkCommand, parseProblems, runChecks } from "../src/checks.js";
import { newRepo, write } from "./helpers.js";

test("parseProblems reads the format every compiler but tsc uses", () => {
  const out = ["src/auth/token.ts:41:5: error: Type 'number | undefined' is not assignable"].join("\n");
  assert.deepEqual(parseProblems(out, "/repo"), [
    { path: "src/auth/token.ts", line: 41, message: "error: Type 'number | undefined' is not assignable" },
  ]);
});

test("parseProblems reads tsc's own parenthesised format", () => {
  const out = "src/auth/token.ts(41,5): error TS2322: Type 'number' is not assignable to type 'string'.";
  assert.deepEqual(parseProblems(out, "/repo"), [
    { path: "src/auth/token.ts", line: 41, message: "error TS2322: Type 'number' is not assignable to type 'string'." },
  ]);
});

test("parseProblems reads a test-runner frame and an absolute stack frame", () => {
  const out = [
    "test at test/auth.test.ts:22:1",
    "      at TestContext.<anonymous> (/repo/test/auth.test.ts:30:10)",
  ].join("\n");
  assert.deepEqual(
    parseProblems(out, "/repo").map((p) => [p.path, p.line]),
    [
      ["test/auth.test.ts", 22],
      ["test/auth.test.ts", 30],
    ],
  );
});

test("parseProblems ignores locations the reviewer cannot act on", () => {
  const out = [
    "    at async Test.run (node:internal/test_runner/test:1110:7)",
    "    at Module._compile (/repo/node_modules/tsx/dist/loader.js:12:9)",
    "    at Object.<anonymous> (/elsewhere/other.ts:3:1)",
    "fetching https://example.com:443/x",
  ].join("\n");
  assert.deepEqual(parseProblems(out, "/repo"), []);
});

test("parseProblems collapses a repeated location and keeps the first message", () => {
  const out = [
    "src/a.ts:41:5: error: the detailed one",
    "src/a.ts:41:5: error: the summary line",
    "src/b.ts:2:1: error: another file",
  ].join("\n");
  const problems = parseProblems(out, "/repo");
  assert.equal(problems.length, 2);
  assert.equal(problems[0]!.message, "error: the detailed one");
});

test("parseProblems strips ANSI colour before matching", () => {
  const out = "\x1b[31msrc/a.ts:7:1: error: red\x1b[0m";
  assert.deepEqual(parseProblems(out, "/repo"), [{ path: "src/a.ts", line: 7, message: "error: red" }]);
});

test("checkCommand prefers an executable .srcy/check over any npm script", async (t) => {
  const repo = await newRepo(t);
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }));
  assert.deepEqual(await checkCommand(repo), ["npm", "run", "typecheck", "--silent"]);

  await mkdir(join(repo, ".srcy"), { recursive: true });
  const script = join(repo, ".srcy", "check");
  await writeFile(script, "#!/bin/sh\nexit 0\n");
  // Present but not executable is not a command — the same rule postcreate
  // uses, so a stray file can't start running on every turn.
  assert.deepEqual(await checkCommand(repo), ["npm", "run", "typecheck", "--silent"]);
  await chmod(script, 0o755);
  assert.deepEqual(await checkCommand(repo), [script]);
});

test("checkCommand returns null when the project configures no check", async (t) => {
  const repo = await newRepo(t);
  assert.equal(await checkCommand(repo), null);
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { start: "node ." } }));
  assert.equal(await checkCommand(repo), null);
});

test("runChecks reports nothing to run as null, never as a pass", async (t) => {
  const repo = await newRepo(t);
  // The distinction that matters: "we did not check" must not render the
  // same as "we checked and it was fine".
  assert.equal(await runChecks(repo, repo), null);
});

test("runChecks runs the check inside the worktree and reports failures", async (t) => {
  const repo = await newRepo(t);
  await mkdir(join(repo, ".srcy"), { recursive: true });
  const script = join(repo, ".srcy", "check");
  // Prints a location relative to its own cwd, which is what a real
  // compiler does — proving the check ran in the directory we passed.
  await writeFile(script, '#!/bin/sh\necho "src/a.ts:4:1: error: broken"\ncat marker.txt\nexit 1\n');
  await chmod(script, 0o755);

  const worktree = await newRepo(t);
  await write(worktree, "marker.txt", "ran in the worktree\n");

  const result = (await runChecks(worktree, repo))!;
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, [{ path: "src/a.ts", line: 4, message: "error: broken" }]);
  assert.match(result.tail, /ran in the worktree/);
});

test("runChecks reports a passing check with no problems", async (t) => {
  const repo = await newRepo(t);
  await mkdir(join(repo, ".srcy"), { recursive: true });
  const script = join(repo, ".srcy", "check");
  // Exits 0 while printing something that looks exactly like an error:
  // exit status is the verdict, not whatever the tool chose to print.
  await writeFile(script, '#!/bin/sh\necho "src/a.ts:4:1: error: not actually a failure"\nexit 0\n');
  await chmod(script, 0o755);

  const result = (await runChecks(repo, repo))!;
  assert.equal(result.ok, true);
  assert.deepEqual(result.problems, []);
});

test("a failure that names no file still reads as failing, with its output kept", async (t) => {
  const repo = await newRepo(t);
  await mkdir(join(repo, ".srcy"), { recursive: true });
  const script = join(repo, ".srcy", "check");
  // A crash, a missing binary, a bare "FAILED" — no file:line anywhere. If
  // the pane only rendered `problems`, this would show as zero problems and
  // read exactly like a clean run.
  await writeFile(script, '#!/bin/sh\necho "Segmentation fault" >&2\nexit 139\n');
  await chmod(script, 0o755);

  const result = (await runChecks(repo, repo))!;
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems, []);
  assert.match(result.tail, /Segmentation fault/);
});
