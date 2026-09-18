import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { checkCommand, parseProblems } from "../src/checks.js";
import { newRepo } from "./helpers.js";

test("parseProblems reads the format every compiler but tsc uses", () => {
  const out = ["src/auth/token.ts:41:5: error: Type 'number | undefined' is not assignable"].join("\n");
  assert.deepEqual(parseProblems(out, "/repo", "types"), [
    {
      path: "src/auth/token.ts",
      line: 41,
      message: "error: Type 'number | undefined' is not assignable",
      severity: "error",
      check: "types",
    },
  ]);
});

test("parseProblems reads tsc's own parenthesised format", () => {
  const out = "src/auth/token.ts(41,5): error TS2322: Type 'number' is not assignable to type 'string'.";
  assert.deepEqual(parseProblems(out, "/repo"), [
    {
      path: "src/auth/token.ts",
      line: 41,
      message: "error TS2322: Type 'number' is not assignable to type 'string'.",
      severity: "error",
      check: "",
    },
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
  assert.deepEqual(parseProblems(out, "/repo"), [
    { path: "src/a.ts", line: 7, message: "error: red", severity: "error", check: "" },
  ]);
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

test("parseProblems reads eslint's default formatter, which names the file once", () => {
  // Neither line is a location on its own, so reading one line at a time
  // finds nothing at all in an eslint run — a red gate with a list of
  // locations sitting right there, unreachable.
  const out = [
    "/repo/src/a.js",
    "  12:5   error    Unexpected console statement  no-console",
    "  40:1   warning  Missing JSDoc comment         require-jsdoc",
    "",
    "/repo/src/b.js",
    "  7:11  error  'x' is assigned a value but never used  no-unused-vars",
    "",
    "✖ 3 problems (2 errors, 1 warning)",
  ].join("\n");
  assert.deepEqual(
    parseProblems(out, "/repo", "lint").map((p) => [p.path, p.line, p.severity]),
    [
      // Errors first: the rail has room for three rows, and a lint run's
      // warnings must not be the three.
      ["src/a.js", 12, "error"],
      ["src/b.js", 7, "error"],
      ["src/a.js", 40, "warning"],
    ],
  );
});

test("parseProblems reads cargo, whose message is a line above the location", () => {
  const out = [
    "error[E0308]: mismatched types",
    "  --> src/main.rs:4:5",
    "   |",
    "warning: unused variable: `x`",
    "  --> src/lib.rs:9:9",
  ].join("\n");
  assert.deepEqual(
    parseProblems(out, "/repo").map((p) => [p.path, p.line, p.severity, p.message]),
    [
      ["src/main.rs", 4, "error", "error: mismatched types"],
      // The location alone reads as "something is wrong at src/lib.rs:9" —
      // true, and useless.
      ["src/lib.rs", 9, "warning", "warning: unused variable: `x`"],
    ],
  );
});

test("parseProblems puts errors ahead of warnings without reordering either", () => {
  const out = [
    "src/a.ts:1:1: warning: first warning",
    "src/b.ts:2:1: error: first error",
    "src/c.ts:3:1: warning: second warning",
    "src/d.ts:4:1: error: second error",
  ].join("\n");
  assert.deepEqual(
    parseProblems(out, "/repo").map((p) => p.path),
    ["src/b.ts", "src/d.ts", "src/a.ts", "src/c.ts"],
  );
});
