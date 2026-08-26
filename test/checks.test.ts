import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { checkCommand, parseProblems } from "../src/checks.js";
import { newRepo } from "./helpers.js";

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
