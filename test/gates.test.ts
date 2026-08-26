import assert from "node:assert/strict";
import { chmod, mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_TIMEOUT_MS, loadGates, parseConfig, problemsOf, runGate, summarise, type GateResult, checkDerived, derivedGates, parseDerived } from "../src/gates.js";
import { newRepo } from "./helpers.js";

async function config(repo: string, body: unknown): Promise<void> {
  await mkdir(join(repo, ".srcy"), { recursive: true });
  await writeFile(join(repo, ".srcy", "config.json"), typeof body === "string" ? body : JSON.stringify(body));
}

async function script(repo: string, body: string): Promise<string> {
  await mkdir(join(repo, ".srcy"), { recursive: true });
  const path = join(repo, ".srcy", "check");
  await writeFile(path, body);
  await chmod(path, 0o755);
  return path;
}

test("a gate is a list of words, never a shell line", () => {
  // Splitting one would mean quoting, globs and pipes all have to work.
  // Refusing it is the honest answer: the project already has .srcy/check.
  const shell = parseConfig({ gates: [{ name: "unit", command: "npm test | tee log" }] });
  assert.deepEqual(shell.gates, []);
  assert.match(shell.error ?? "", /list of words/);

  assert.match(parseConfig({ gates: [{ name: "", command: ["x"] }] }).error ?? "", /one-line name/);
  assert.match(parseConfig({ gates: [{ name: "a", command: [] }] }).error ?? "", /non-empty list/);
  assert.match(
    parseConfig({ gates: [{ name: "a", command: ["x"] }, { name: "a", command: ["y"] }] }).error ?? "",
    /two gates/,
  );
  assert.match(parseConfig({ gates: [{ name: "a", command: ["x"], timeoutMs: 0 }] }).error ?? "", /positive/);
});

test("gates are automatic unless the project opts one out, and time out inside ten minutes", () => {
  const { gates, error } = parseConfig({
    gates: [
      { name: "typecheck", command: ["npm", "run", "typecheck"] },
      { name: "e2e", command: ["npm", "run", "e2e"], auto: false, timeoutMs: 60 * 60_000 },
    ],
  });
  assert.equal(error, undefined);
  // The rail's job is saying the tree is broken before you ask; a config
  // that turned that off for everything would be worse than no config.
  assert.equal(gates[0]!.auto, true);
  assert.equal(gates[0]!.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(gates[1]!.auto, false);
  assert.equal(gates[1]!.timeoutMs, 600_000);
});

test("a project with no config keeps the check srcy can find on its own", async (t) => {
  const repo = await newRepo(t);
  assert.deepEqual((await loadGates(repo)).gates, []);

  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }));
  const npm = await loadGates(repo);
  assert.equal(npm.gates[0]!.name, "typecheck");
  assert.deepEqual(npm.gates[0]!.command, ["npm", "run", "typecheck", "--silent"]);

  const path = await script(repo, "#!/bin/sh\nexit 0\n");
  const own = await loadGates(repo);
  assert.equal(own.gates[0]!.name, "check");
  assert.deepEqual(own.gates[0]!.command, [path]);
});

test("a broken config is reported and falls back, never silently ignored", async (t) => {
  const repo = await newRepo(t);
  await writeFile(join(repo, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc" } }));

  await config(repo, "{not json");
  const bad = await loadGates(repo);
  assert.match(bad.error ?? "", /not valid JSON/);
  assert.equal(bad.gates[0]!.name, "typecheck", "the project lost the check it already had");

  await config(repo, { gates: [{ name: "unit", command: 7 }] });
  const wrong = await loadGates(repo);
  assert.match(wrong.error ?? "", /unit/);
  assert.equal(wrong.gates[0]!.name, "typecheck");
});

test("a gate reports what it measured, and against which tree", async (t) => {
  const repo = await newRepo(t);
  const path = await script(repo, '#!/bin/sh\necho "src/a.ts:4:1: error: broken"\nexit 1\n');
  const fail = await runGate(repo, { name: "check", command: [path], auto: true, timeoutMs: DEFAULT_TIMEOUT_MS }, "mark-1");
  assert.equal(fail.status, "fail");
  assert.deepEqual(fail.problems, [{ path: "src/a.ts", line: 4, message: "error: broken" }]);
  assert.equal(fail.mark, "mark-1");

  // Exit status is the verdict, not whatever the tool printed.
  await script(repo, '#!/bin/sh\necho "src/a.ts:4:1: error: not actually a failure"\nexit 0\n');
  const pass = await runGate(repo, { name: "check", command: [path], auto: true, timeoutMs: DEFAULT_TIMEOUT_MS }, "mark-1");
  assert.equal(pass.status, "pass");
  assert.deepEqual(pass.problems, []);
});

test("a failure that names no file is still a failure with its output kept", async (t) => {
  const repo = await newRepo(t);
  const path = await script(repo, '#!/bin/sh\necho "Segmentation fault" >&2\nexit 139\n');
  const r = await runGate(repo, { name: "check", command: [path], auto: true, timeoutMs: DEFAULT_TIMEOUT_MS }, "m");
  assert.equal(r.status, "fail");
  assert.deepEqual(r.problems, []);
  assert.match(r.tail, /Segmentation fault/);
});

test("a gate that runs out of time says so rather than failing", async (t) => {
  const repo = await newRepo(t);
  // Nothing was proved either way; calling it a failure sends the reader
  // looking for a bug that may not exist.
  const path = await script(repo, "#!/bin/sh\nsleep 30\n");
  const r = await runGate(repo, { name: "slow", command: [path], auto: false, timeoutMs: 300 }, "m");
  assert.equal(r.status, "timeout");
  assert.match(r.tail, /timed out/);
  assert.ok(r.ms < 10_000, `waited ${r.ms}ms for a 300ms timeout`);
});

const gate = (name: string): { name: string; command: string[]; auto: boolean; timeoutMs: number } => ({
  name,
  command: ["true"],
  auto: true,
  timeoutMs: DEFAULT_TIMEOUT_MS,
});

const result = (name: string, status: GateResult["status"], mark: string): GateResult => ({
  name,
  status,
  problems: [],
  tail: "",
  ms: 1,
  mark,
});

test("the summary counts fresh passes, and stale ones need attention", () => {
  const gates = [gate("typecheck"), gate("unit"), gate("e2e")];
  const now = summarise(
    gates,
    [result("typecheck", "pass", "now"), result("unit", "fail", "now"), result("e2e", "pass", "before")],
    "now",
  );
  // A pass measured against a tree that has since moved is not evidence
  // about this one, so it counts as something to look at, not as passing.
  assert.deepEqual(now, { passing: 1, total: 3, attention: 2 });
  assert.deepEqual(summarise(gates, [], "now"), { passing: 0, total: 3, attention: 0 });
});

test("problems come from every failing gate, once each", () => {
  const passing: GateResult = { ...result("ok", "pass", "now"), problems: [{ path: "z.ts", line: 9, message: "no" }] };
  const one: GateResult = { ...result("new", "fail", "now"), problems: [{ path: "b.ts", line: 2, message: "new" }] };
  const dupe: GateResult = { ...result("other", "fail", "now"), problems: [{ path: "b.ts", line: 2, message: "again" }] };
  // A stale verdict is still the best evidence there is, and the pane says
  // "code moved since" beside it — dropping the row would read as a fix.
  const stale: GateResult = { ...result("old", "fail", "before"), problems: [{ path: "a.ts", line: 1, message: "old" }] };
  assert.deepEqual(problemsOf([passing, one, dupe, stale]), [
    { path: "b.ts", line: 2, message: "new" },
    { path: "a.ts", line: 1, message: "old" },
  ]);
});

test("a derived file is stale when it is older than what it is built from", async (t) => {
  const repo = await newRepo(t);
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(join(repo, "docs"), { recursive: true });
  await writeFile(join(repo, "src/panels.tsx"), "x\n");
  await writeFile(join(repo, "scripts.ts"), "y\n");

  const spec = [{ from: ["src", "scripts.ts"], to: "docs/demo.gif" }];
  const paths = ["src/panels.tsx", "scripts.ts", "docs/demo.gif"];

  // Never built is a different thing to say than out of date, and is said
  // differently.
  const missing = await checkDerived(repo, spec, paths, "m");
  assert.equal(missing[0]?.status, "fail");
  assert.equal(missing[0]?.tail, "never built");
  assert.equal(missing[0]?.name, "demo.gif");

  // Built after its sources: nothing to say.
  await writeFile(join(repo, "docs/demo.gif"), "gif\n");
  const fresh = await checkDerived(repo, spec, paths, "m");
  assert.equal(fresh[0]?.status, "pass");

  // A source touched afterwards makes it stale, and it names which one.
  const later = new Date(Date.now() + 5000);
  await utimes(join(repo, "src/panels.tsx"), later, later);
  const stale = await checkDerived(repo, spec, paths, "m");
  assert.equal(stale[0]?.status, "fail");
  assert.equal(stale[0]?.tail, "older than src/panels.tsx");

  // Never a problem row: a stale gif has no line for `e` to jump to.
  assert.deepEqual(stale[0]?.problems, []);
  // Shown as a gate, never runnable as one.
  assert.deepEqual(derivedGates(spec).map((g) => [g.name, g.command.length, g.auto]), [["demo.gif", 0, false]]);
});

test("a derived entry is refused the same way a bad gate is", () => {
  assert.deepEqual(parseDerived({}), { derived: [] });
  assert.equal(parseDerived({ derived: "src" }).error, "derived must be a list");
  assert.match(parseDerived({ derived: [{ from: ["src"] }] }).error ?? "", /needs a `to` path/);
  assert.match(parseDerived({ derived: [{ to: "a.gif", from: [] }] }).error ?? "", /non-empty list of paths/);
  assert.match(parseDerived({ derived: [{ to: "a.gif", from: "src" }] }).error ?? "", /non-empty list of paths/);
  assert.deepEqual(parseDerived({ derived: [{ to: "a.gif", from: ["src"] }] }).derived, [{ to: "a.gif", from: ["src"] }]);
});
