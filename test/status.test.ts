import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_TIMEOUT_MS, markFor, type Gate, type GateResult } from "../src/gates.js";
import { checkpoint, mission, report, status, timeline, verify } from "../src/status.js";
import { readCheckpoints, readEvents, readMission, readResults, writeResults } from "../src/state.js";
import { newRepo, write } from "./helpers.js";

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
  tail: "",
  ms: 1200,
  mark,
});

// srcy's output is as likely to be piped as read, so the words are part of
// the contract rather than decoration.
test("status says VERIFIED only when every required gate passed against this tree", () => {
  const gates = [gate("types"), gate("e2e", { required: false })];
  const green = report("ship it", "main", [], gates, [result("types", "pass", "now")], "now");
  assert.match(green, /\n  VERIFIED$/);
  assert.match(green, /types\s+PASS/);
  assert.match(green, /e2e\s+not run\s+\(optional\)/);

  const moved = report("ship it", "main", [], gates, [result("types", "pass", "then")], "now");
  assert.match(moved, /types\s+STALE/);
  assert.match(moved, /\n  UNVERIFIED$/);

  // A repo that verifies nothing is never verified. "Green because there is
  // nothing to check" is the one lie this whole feature exists to prevent.
  assert.match(report("", "main", [], [], [], "now"), /\n  UNVERIFIED$/);
  assert.match(report("", "main", [], [], [], "now"), /none configured/);
});

test("status counts the churn and names the attention", () => {
  const text = report(
    "fix the race",
    "main",
    [{ added: 70, removed: 18 }, { added: 2, removed: 0 }],
    [gate("tests")],
    [result("tests", "fail", "now")],
    "now",
  );
  assert.match(text, /main {2}2 files {2}\+72 -18/);
  assert.match(text, /✗ tests/);
});

test("a gate that watches only part of the tree keeps its pass", () => {
  const types = gate("types", { watch: ["src/**"] });
  // The verdict was measured when src held one file and nothing else had moved.
  const ran = report("", "main", [], [types], [], "t1", [["src/a.ts", "a1"]]);
  assert.match(ran, /types\s+not run/);

  // It ran, then the README changed. The tree mark moved; src did not.
  const mark = markFor("t1", [["src/a.ts", "a1"]], ["src/**"]);
  const after = report("", "main", [], [types], [result("types", "pass", mark)], "t2", [
    ["src/a.ts", "a1"],
    ["README.md", "r1"],
  ]);
  assert.match(after, /types\s+PASS/);
  assert.match(after, /\n  VERIFIED$/);
});

test("verdicts survive the process that measured them, and junk does not become a pass", async (t) => {
  const repo = await newRepo(t);
  assert.deepEqual(await readResults(repo), []);

  await writeResults(repo, [result("types", "pass", "m")]);
  const back = await readResults(repo);
  assert.equal(back.length, 1);
  assert.equal(back[0]!.status, "pass");
  assert.equal(back[0]!.mark, "m");

  // Hand-edited, half-written, or from a future version: unreadable must
  // degrade to "nothing has run", never to a made-up pass.
  await writeFile(join(repo, ".srcy", "state.json"), "{not json");
  assert.deepEqual(await readResults(repo), []);
  await writeFile(join(repo, ".srcy", "state.json"), JSON.stringify({ at: 1, results: [{ name: "types" }] }));
  assert.deepEqual(await readResults(repo), []);
});

test("verify exits on the VERIFIED claim, and names a gate it does not have", async (t) => {
  const repo = await newRepo(t);
  t.mock.method(console, "log", () => {});
  t.mock.method(process.stderr, "write", () => true);

  await mkdir(join(repo, ".srcy"), { recursive: true });
  const config = async (gates: unknown): Promise<void> =>
    writeFile(join(repo, ".srcy", "config.json"), JSON.stringify({ gates }));

  // Nothing configured is not a pass.
  await write(repo, "package.json", "{}");
  assert.equal(await verify(repo), 1);

  await config([{ name: "ok", command: ["true"] }]);
  assert.equal(await verify(repo), 0);
  // And the verdict is on disk for `srcy status` in the next terminal.
  assert.equal((await readResults(repo))[0]!.status, "pass");

  await config([{ name: "ok", command: ["true"] }, { name: "bad", command: ["false"] }]);
  assert.equal(await verify(repo), 1);

  // One gate asked about is one gate answered about: the optional one
  // failing must not be blamed on the one the caller named.
  await config([{ name: "ok", command: ["true"] }, { name: "bad", command: ["false"], required: false }]);
  assert.equal(await verify(repo, "ok"), 0);
  assert.equal(await verify(repo, "bad"), 1);
  assert.equal(await verify(repo, "nope"), 2);
  // The optional failure is a finding, not a veto.
  assert.equal(await verify(repo), 0);
});

test("status is the same claim, without the panes", async (t) => {
  const repo = await newRepo(t);
  const printed: string[] = [];
  t.mock.method(console, "log", (line: string) => void printed.push(line));
  t.mock.method(process.stderr, "write", () => true);

  await mkdir(join(repo, ".srcy"), { recursive: true });
  await writeFile(join(repo, ".srcy", "task.md"), "# Fix the token race\n");
  await writeFile(join(repo, ".srcy", "config.json"), JSON.stringify({ gates: [{ name: "ok", command: ["true"] }] }));

  // Nothing has run yet, so nothing is verified.
  assert.equal(await status(repo), 1);
  assert.match(printed.join("\n"), /Fix the token race/);

  assert.equal(await verify(repo), 0);
  printed.length = 0;
  assert.equal(await status(repo), 0);
  assert.match(printed.join("\n"), /\n  VERIFIED$/);

  // And the moment the tree moves, the same pass stops being about it.
  await write(repo, "a.txt", "two\n");
  printed.length = 0;
  assert.equal(await status(repo), 1);
  assert.match(printed.join("\n"), /ok\s+STALE/);
});

test("a mission keeps its words in the repo and its clock in the runtime state", async (t) => {
  const repo = await newRepo(t);
  const printed: string[] = [];
  t.mock.method(console, "log", (line: string) => void printed.push(line));
  t.mock.method(console, "error", () => {});

  assert.equal(await mission(repo), 1, "nothing pinned is not a mission");
  assert.equal(await mission(repo, "start"), 2, "a mission needs a goal");

  assert.equal(await mission(repo, "start", ["Fix", "the", "token", "race"]), 0);
  // The words go where the rail already looks, and where a project can
  // commit them.
  assert.match(await readFile(join(repo, ".srcy", "task.md"), "utf8"), /^# Fix the token race/);
  const active = await readMission(repo);
  assert.equal(active?.status, "active");
  assert.ok((active?.startedAt ?? 0) > 0);

  assert.equal(await mission(repo, "complete"), 0);
  assert.equal((await readMission(repo))?.status, "completed");
  // Completing does not erase the record of what this copy was for.
  assert.match(await readFile(join(repo, ".srcy", "task.md"), "utf8"), /token race/);

  assert.equal(await mission(repo, "finish"), 2, "an unknown verb is refused, not guessed");
});

test("a mission and an agent show up in status without being required by it", () => {
  const withMission = report("Fix the race", "main", [], [], [], "m", [], undefined, {
    goal: "Fix the race",
    startedAt: 1_000,
    status: "active",
  }, { agent: "claude", status: "working", activity: "Bash npm test", since: 1_000 }, 121_000);
  assert.match(withMission, /Fix the race {2}active 2m/);
  assert.match(withMission, /Agent\n {2}claude {2}working {2}Bash npm test {2}2m/);

  // And the same report with neither is the report srcy has always printed.
  const bare = report("", "main", [], [], [], "m");
  assert.doesNotMatch(bare, /Agent/);
  assert.match(bare, /srcy mission start/);
});

test("a checkpoint is a real tree, so comparing two is an ordinary git diff", async (t) => {
  const repo = await newRepo(t);
  const printed: string[] = [];
  t.mock.method(console, "log", (line: string) => void printed.push(line));
  t.mock.method(console, "error", () => {});

  assert.equal(await checkpoint(repo, "list"), 1, "nothing recorded yet");
  assert.equal(await checkpoint(repo), 0);

  await write(repo, "a.txt", "two\n");
  assert.equal(await checkpoint(repo), 0);

  const all = await readCheckpoints(repo);
  assert.deepEqual(all.map((c) => c.n), [1, 2]);
  assert.notEqual(all[0]!.tree, all[1]!.tree, "the tree moved between them");

  printed.length = 0;
  assert.equal(await checkpoint(repo, "list"), 0);
  assert.equal(printed.length, 2);
  assert.match(printed[0]!, /^#1 /);

  // The diff is git's, against a tree object srcy wrote without committing.
  const out: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string) => {
    out.push(chunk);
    return true;
  });
  assert.equal(await checkpoint(repo, "diff", ["1", "2"]), 0);
  assert.match(out.join(""), /-one/);
  assert.match(out.join(""), /\+two/);

  assert.equal(await checkpoint(repo, "diff", ["9"]), 2, "a checkpoint that does not exist is refused");
});

test("the timeline records transitions, never polls", async (t) => {
  const repo = await newRepo(t);
  const printed: string[] = [];
  t.mock.method(console, "log", (line: string) => void printed.push(line));
  t.mock.method(console, "error", () => {});
  t.mock.method(process.stderr, "write", () => true);

  assert.equal(await timeline(repo), 1, "nothing recorded yet");

  await mkdir(join(repo, ".srcy"), { recursive: true });
  await writeFile(join(repo, ".srcy", "config.json"), JSON.stringify({ gates: [{ name: "ok", command: ["true"] }] }));
  await verify(repo);

  const events = await readEvents(repo);
  assert.deepEqual(events.map((e) => e.type), ["gate.start", "gate.pass"]);

  printed.length = 0;
  assert.equal(await timeline(repo), 0);
  assert.match(printed.join("\n"), /gate\.pass\s+ok/);
});
