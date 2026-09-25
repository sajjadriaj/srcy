import assert from "node:assert/strict";
import { chmod, mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_TIMEOUT_MS, OUTPUT_LINES, attention, loadGates, markFor, marksFor, parseConfig, problemsOf, runGate, startGate, summarise, verified, watched, type Gate, type GateResult, checkDerived, derivedGates, parseDerived } from "../src/gates.js";
import { killAll } from "../src/checks.js";
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
      { name: "e2e", command: ["npm", "run", "e2e"], auto: false, timeoutMs: 60 * 60_000 , required: true, watch: [] },
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
  const fail = await runGate(repo, { name: "check", command: [path], auto: true, timeoutMs: DEFAULT_TIMEOUT_MS , required: true, watch: [] }, "mark-1");
  assert.equal(fail.status, "fail");
  // Stamped with the gate that found it: two gates failing in one file is
  // the case where "what is broken" alone stops being an answer.
  assert.deepEqual(fail.problems, [
    { path: "src/a.ts", line: 4, message: "error: broken", severity: "error" as const, check: "check" },
  ]);
  assert.equal(fail.mark, "mark-1");

  // Exit status is the verdict, not whatever the tool printed.
  await script(repo, '#!/bin/sh\necho "src/a.ts:4:1: error: not actually a failure"\nexit 0\n');
  const pass = await runGate(repo, { name: "check", command: [path], auto: true, timeoutMs: DEFAULT_TIMEOUT_MS , required: true, watch: [] }, "mark-1");
  assert.equal(pass.status, "pass");
  assert.deepEqual(pass.problems, []);
});

test("a failure that names no file is still a failure with its output kept", async (t) => {
  const repo = await newRepo(t);
  const path = await script(repo, '#!/bin/sh\necho "Segmentation fault" >&2\nexit 139\n');
  const r = await runGate(repo, { name: "check", command: [path], auto: true, timeoutMs: DEFAULT_TIMEOUT_MS , required: true, watch: [] }, "m");
  assert.equal(r.status, "fail");
  assert.deepEqual(r.problems, []);
  assert.match(r.tail, /Segmentation fault/);
});

test("a gate that runs out of time says so rather than failing", async (t) => {
  const repo = await newRepo(t);
  // Nothing was proved either way; calling it a failure sends the reader
  // looking for a bug that may not exist.
  const path = await script(repo, "#!/bin/sh\nsleep 30\n");
  const r = await runGate(repo, { name: "slow", command: [path], auto: false, timeoutMs: 300 , required: true, watch: [] }, "m");
  assert.equal(r.status, "timeout");
  assert.match(r.tail, /timed out/);
  assert.ok(r.ms < 10_000, `waited ${r.ms}ms for a 300ms timeout`);
});

const gate = (name: string, extra: Partial<Gate> = {}): Gate => ({
  name,
  command: ["true"],
  auto: true,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  required: true,
  watch: [],
  ...extra,
});

const result = (name: string, status: GateResult["status"], mark: string): GateResult => ({
  name,
  status,
  problems: [],
  tail: "", output: "",
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
  const passing: GateResult = { ...result("ok", "pass", "now"), problems: [{ path: "z.ts", line: 9, message: "no", severity: "error" as const, check: "" }] };
  const one: GateResult = { ...result("new", "fail", "now"), problems: [{ path: "b.ts", line: 2, message: "new", severity: "error" as const, check: "" }] };
  const dupe: GateResult = { ...result("other", "fail", "now"), problems: [{ path: "b.ts", line: 2, message: "again", severity: "error" as const, check: "" }] };
  // A stale verdict is still the best evidence there is, and the pane says
  // "code moved since" beside it — dropping the row would read as a fix.
  const stale: GateResult = { ...result("old", "fail", "before"), problems: [{ path: "a.ts", line: 1, message: "old", severity: "error" as const, check: "" }] };
  assert.deepEqual(problemsOf([passing, one, dupe, stale]), [
    { path: "b.ts", line: 2, message: "new", severity: "error" as const, check: "" },
    { path: "a.ts", line: 1, message: "old", severity: "error" as const, check: "" },
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
  assert.equal(stale[0]?.tail, "older than panels.tsx");

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

test("a watch list is three shapes, and anything else matches nothing", () => {
  // A directory, with or without git's own `/**` spelling.
  assert.equal(watched("src/a.ts", ["src"]), true);
  assert.equal(watched("src/a.ts", ["src/**"]), true);
  assert.equal(watched("srcy/a.ts", ["src"]), false, "a prefix is a directory, not a string prefix");
  // An extension across the whole tree.
  assert.equal(watched("deep/nested/a.ts", ["**/*.ts"]), true);
  assert.equal(watched("deep/nested/a.js", ["**/*.ts"]), false);
  // An exact path.
  assert.equal(watched("api/schema.yaml", ["api/schema.yaml"]), true);
  // No list means the whole tree, which is what every gate meant before
  // `watch` existed.
  assert.equal(watched("anything", []), true);
});

test("a gate is stale only when something it watches moved", () => {
  const before: [string, string][] = [["README.md", "r1"], ["src/a.ts", "a1"]];
  const readme: [string, string][] = [["README.md", "r2"], ["src/a.ts", "a1"]];
  const code: [string, string][] = [["README.md", "r1"], ["src/a.ts", "a2"]];

  const types = gate("types", { watch: ["src/**"] });
  const mine = (stamps: [string, string][]): string => markFor("whole", stamps, types.watch);
  // The edit this exists to ignore.
  assert.equal(mine(readme), mine(before));
  // And the one it must never ignore.
  assert.notEqual(mine(code), mine(before));

  // A gate with no watch list still takes the whole tree's word for it.
  assert.equal(markFor("whole", readme, []), "whole");
});

test("VERIFIED is every required gate passing against this exact tree", () => {
  const types = gate("types");
  const e2e = gate("e2e", { required: false });
  const gates = [types, e2e];
  const marks = marksFor(gates, "now", []);

  // The optional gate has not run and does not get a vote.
  assert.equal(verified(gates, [result("types", "pass", "now")], "now", marks), true);
  // A pass measured against a tree that has moved is not evidence about this
  // one, which is the whole reason the mark is carried at all.
  assert.equal(verified(gates, [result("types", "pass", "then")], "now", marks), false);
  assert.equal(verified(gates, [result("types", "fail", "now")], "now", marks), false);
  // The optional gate failing is worth attention and is not a veto.
  assert.equal(
    verified(gates, [result("types", "pass", "now"), result("e2e", "fail", "now")], "now", marks),
    true,
  );
  // Vacuous truth is the one answer this must never give.
  assert.equal(verified([], [], "now", marks), false);
  assert.equal(verified([e2e], [result("e2e", "pass", "now")], "now", marks), false);
});

test("a watched gate keeps its pass while the rest of the tree moves", () => {
  const types = gate("types", { watch: ["src/**"] });
  const before: [string, string][] = [["src/a.ts", "a1"]];
  const after: [string, string][] = [["src/a.ts", "a1"], ["README.md", "r1"]];
  const ran = markFor("tree-1", before, types.watch);

  const marks = marksFor([types], "tree-2", after);
  assert.equal(verified([types], [result("types", "pass", ran)], "tree-2", marks), true);
  // And the tree mark alone would have called it stale, which is the bug
  // `watch` exists to fix.
  assert.equal(verified([types], [result("types", "pass", ran)], "tree-2"), false);
});

test("attention is failures first, then passes the tree has outrun", () => {
  const gates = [gate("types"), gate("tests")];
  const items = attention(
    gates,
    [result("types", "pass", "then"), result("tests", "fail", "now")],
    "now",
    marksFor(gates, "now", []),
  );
  assert.equal(items.length, 2);
  assert.equal(items[0]!.severity, "error");
  assert.equal(items[0]!.gate, "tests");
  assert.equal(items[1]!.gate, "types");
  assert.match(items[1]!.detail, /code moved since/);
  // Not run is an absence, not a finding.
  assert.deepEqual(attention(gates, [], "now"), []);
});

test("required and watch are read, and a bad watch list is refused", () => {
  const { gates, error } = parseConfig({
    gates: [
      { name: "types", command: ["tsc"], watch: ["src/**"] },
      { name: "e2e", command: ["e2e"], required: false },
    ],
  });
  assert.equal(error, undefined);
  // Required by default: a config that quietly narrowed what green means
  // would be worse than no config.
  assert.equal(gates[0]!.required, true);
  assert.deepEqual(gates[0]!.watch, ["src/**"]);
  assert.equal(gates[1]!.required, false);
  assert.deepEqual(gates[1]!.watch, []);

  // Dropped silently, a bad watch list is a gate that looks scoped and is not.
  assert.match(parseConfig({ gates: [{ name: "a", command: ["x"], watch: "src" }] }).error ?? "", /list of paths/);
  assert.match(parseConfig({ gates: [{ name: "a", command: ["x"], watch: [""] }] }).error ?? "", /list of paths/);
test("a gate keeps enough of its output for the dock to show what happened", async (t) => {
  // The rail has room for `session.ts:3` and the dock for four messages. A
  // failing test's assertion diff fits in neither, and nowhere else in srcy
  // could show it. So the run keeps its output — bounded, because a runaway
  // build log is not something to pass between two processes every second.
  const repo = await newRepo(t);
  const path = await script(repo, '#!/bin/sh\nfor i in $(seq 1 500); do echo "line $i"; done\nexit 1\n');
  const r = await runGate(repo, { name: "check", command: [path], auto: true, timeoutMs: DEFAULT_TIMEOUT_MS, required: true, watch: [] }, "m");
  const lines = r.output.split("\n");
  assert.ok(lines.length <= OUTPUT_LINES, `${lines.length} lines kept`);
  // The end is what is kept: a runner prints its summary last.
  assert.match(r.output, /line 500$/);
  assert.doesNotMatch(r.output, /^line 1$/m);
});

test("a running gate can be cut short, and everything still running dies with the panel", async (t) => {
  // The tree moved two seconds into a three-minute test run: the verdict on
  // its way was stale before it arrived, and the next run queues behind it.
  const repo = await newRepo(t);
  const path = await script(repo, "#!/bin/sh\nsleep 30\n");
  const gate = { name: "slow", command: [path], auto: true, timeoutMs: DEFAULT_TIMEOUT_MS, required: true, watch: [] };
  const started = Date.now();
  const run = startGate(repo, gate, "m");
  setTimeout(() => run.kill(), 50);
  const r = await run.done;
  assert.equal(r.status, "killed");
  assert.ok(Date.now() - started < 5_000, "kill did not stop the run");

  // And on the way out: a gate's child is in its own process group, so the
  // session ending would otherwise leave a compiler running for the rest of
  // the day.
  const orphan = startGate(repo, gate, "m");
  await new Promise((r) => setTimeout(r, 50));
  killAll();
  assert.equal((await orphan.done).status, "killed");
});
