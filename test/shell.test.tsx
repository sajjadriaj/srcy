import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { splitDiff } from "../src/diff.js";
import { NOTHING, ancestors, openForChanges, openSet, rows as treeRows, toggle, window as treeWindow } from "../src/tree.js";
import { git } from "../src/git.js";
import { parseShell, sessionName } from "../src/index.js";
import { projectDir } from "../src/transcript.js";
import { Dock, GoalLine, NarrowChecks, NarrowUsage, Rail, TreeLine, activityTitle, baseline, checkStep, checksRows, cursorAt, elapsed, fingerprint, mapBudget, newest, problemLines, publish, readShared, usageRows } from "../src/panels.js";
import { eastAsianWidth } from "get-east-asian-width";
import { repoState } from "../src/repo.js";
import { TMUX, cmdline, dockHeight, pick, plan, railWidth, shq } from "../src/tmux.js";
import { CLAUDE, advance, emptyFold, foldLine as claudeFold, newReader, parseState, parseUsage, stateOf, usageOf, type Source } from "../src/transcript.js";
import { CODEX, foldLine as codexFold, findSession } from "../src/codex.js";
import { sourceFor } from "../src/panels.js";
import { newRepo } from "./helpers.js";

// ---------------------------------------------------------------------------
// The layout

const LAYOUT = {
  session: "srcy-x",
  repo: "/r",
  agent: ["claude"],
  panel: (which: string) => ["node", "/i.js", "panel", which],
  resize: ["node", "/i.js", "resize"],
  cols: 120,
  rows: 40,
};

test("the dock is split off before the rail, which is what makes it full width", () => {
  const steps = plan(LAYOUT);
  const splits = steps.filter((s) => s[0] === "split-window");
  assert.equal(splits.length, 2);
  // Vertical first, while the agent pane is still the whole window. Reverse
  // these and the dock is wedged under the agent with the rail beside it,
  // running the full height — a different layout that still "works", which
  // is why only the order pins it down.
  assert.equal(splits[0]!.includes("-v"), true, "first split must be vertical (the dock)");
  assert.match(splits[0]!.at(-1)!, /'panel' 'dock'/);
  assert.equal(splits[1]!.includes("-h"), true, "second split must be horizontal (the rail)");
  assert.equal(splits[1]!.includes("-b"), true, "the rail goes before the agent, i.e. on the left");
  assert.match(splits[1]!.at(-1)!, /'panel' 'rail'/);
});

test("the keyboard lands on the agent, not on a panel", () => {
  // The panels are read-only. Starting focus anywhere but the agent means
  // the first thing anyone types goes nowhere.
  const steps = plan(LAYOUT);
  const select = steps.find((s) => s[0] === "select-pane");
  assert.deepEqual(select, ["select-pane", "-t", "%AGENT%"]);
});

test("quitting the agent ends the session, and only the agent does", () => {
  const steps = plan(LAYOUT);
  // tmux's pane-exited hook accepts `set-hook` and then never fires (3.4),
  // so teardown rides on the agent's own command line instead.
  const start = steps.find((s) => s[0] === "new-session")!;
  assert.match(start.at(-1)!, /'claude';\s*tmux -L srcy kill-session -t 'srcy-x'/);
  // And only the agent's: a panel crashing must not take the session down
  // with an agent mid-turn.
  for (const split of steps.filter((s) => s[0] === "split-window")) {
    assert.doesNotMatch(split.at(-1)!, /kill-session/, `a panel tears down the session: ${split.at(-1)}`);
  }
});

test("a window resize re-clamps the panes instead of scaling them", () => {
  const hook = plan(LAYOUT).find((s) => s[0] === "set-hook" && s[3] === "window-resized");
  assert.ok(hook, "no window-resized hook");
  assert.match(hook.at(-1)!, /resize/);
});

test("the rail is clamped at both ends, never a bare percentage", () => {
  // 30% of 80 columns is 24 — too narrow for `session.ts +12 -4`. 30% of a
  // maximised 300-column terminal is 90 — an acre of blank beside a file
  // list, with the agent squeezed into what's left.
  assert.equal(railWidth(80), 30);
  assert.equal(railWidth(120), 36);
  assert.equal(railWidth(300), 44);
  assert.equal(dockHeight(24), 8);
  assert.equal(dockHeight(100), 16);
});

test("shell quoting survives a path with a quote in it", () => {
  assert.equal(shq("a'b"), `'a'\\''b'`);
  assert.equal(cmdline(["claude", "--model", "opus 5"]), `'claude' '--model' 'opus 5'`);
});

test("panes are identified by position, and pane_top is 1 once borders carry titles", () => {
  // The bug this exists for: matching the rail on `pane_top == 0` labels
  // every pane the dock, because pane-border-status top pushes the first
  // row down by one.
  const listing = ["%41 0 1", "%39 45 1", "%40 0 35"].join("\n");
  assert.deepEqual(pick(listing), { rail: "%41", agent: "%39", dock: "%40" });
  assert.deepEqual(pick(""), {});
});

// ---------------------------------------------------------------------------
// The transcript

function assistant(blocks: unknown[]): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: blocks } });
}
function user(blocks: unknown[]): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: blocks } });
}
const todo = (content: string, status: string): unknown => ({ content, status, activeForm: content });
const record = (usage: Record<string, number>): string =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-5", usage } });

test("the plan on screen is the latest one the agent wrote, not every one it ever wrote", () => {
  const text = [
    assistant([{ type: "tool_use", id: "a", name: "TodoWrite", input: { todos: [todo("first", "pending")] } }]),
    assistant([
      {
        type: "tool_use",
        id: "b",
        name: "TodoWrite",
        input: { todos: [todo("first", "completed"), todo("second", "in_progress")] },
      },
    ]),
  ].join("\n");
  const { plan: p } = parseState(text);
  assert.deepEqual(p, [
    { content: "first", status: "completed" },
    { content: "second", status: "in_progress" },
  ]);
});

test("a tool call is in flight until its result lands, and then it is not", () => {
  const started = assistant([{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/src/token.ts" } }]);
  const running = parseState(started);
  assert.deepEqual(running.activity, { tool: "Edit", target: "/r/src/token.ts", since: undefined });

  // The only liveness signal a file can carry: the result the agent writes
  // when the call returns. Without this the rail says "running" forever.
  const finished = [started, user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }])].join("\n");
  assert.equal(parseState(finished).activity, null);
});

test("a subagent's plan and tool calls never reach the rail", () => {
  // A subagent runs its own unrelated work in the same file. Letting it
  // through makes the rail flicker between two pieces of work.
  const text = [
    assistant([{ type: "tool_use", id: "a", name: "TodoWrite", input: { todos: [todo("mine", "pending")] } }]),
    JSON.stringify({
      type: "assistant",
      isSidechain: true,
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "s1", name: "TodoWrite", input: { todos: [todo("theirs", "pending")] } },
          { type: "tool_use", id: "s2", name: "Grep", input: { pattern: "theirs" } },
        ],
      },
    }),
  ].join("\n");
  const s = parseState(text);
  assert.deepEqual(
    s.plan.map((e) => e.content),
    ["mine"],
  );
  // The subagent's Grep is the newest tool call in the file. It must not be
  // what the border says this session is doing.
  assert.notEqual(s.activity?.tool, "Grep");
});

test("a Bash call reports what it is for, not the head of its pipeline", () => {
  const text = assistant([
    {
      type: "tool_use",
      id: "b",
      name: "Bash",
      input: { command: 'AGENT="x" bash shot.sh 2>&1 | tail -45', description: "Capture the layout" },
    },
  ]);
  assert.deepEqual(parseState(text).activity, { tool: "Bash", target: "Capture the layout", since: undefined });
});

test("a half-written last line is not an error — the agent is still writing it", () => {
  const text = [
    assistant([{ type: "tool_use", id: "a", name: "TodoWrite", input: { todos: [todo("keep me", "pending")] } }]),
    '{"type":"assistant","message":{"content":[{"type":"tool_use"',
  ].join("\n");
  assert.equal(parseState(text).plan.length, 1);
});

// ---------------------------------------------------------------------------
// Titles

test("the border names a file by its basename and a command by its head", () => {
  assert.equal(activityTitle(null), " idle ");
  assert.equal(activityTitle({ tool: "Edit", target: "/r/src/auth/token.ts" }), " ⟳ Edit token.ts ");
  // A command's tail names nothing: basenaming `npm run build | tee log`
  // leaves "log". Its head identifies it.
  assert.match(activityTitle({ tool: "Bash", target: "npm run build | tee log" }), /⟳ Bash npm run build/);
  // And a title long enough to wrap a border is cut, not wrapped.
  const long = activityTitle({ tool: "Bash", target: "x".repeat(200) });
  assert.ok(long.length < 40, `title not truncated: ${long.length}`);
  assert.match(long, /…/);
});

// ---------------------------------------------------------------------------
// Repo state, from git alone

test("a new file's churn is its whole length, never a +0 -0 that reads as unchanged", async (t) => {
  const repo = await newRepo(t);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src/new.ts"), "one\ntwo\nthree\n");
  const s = await repoState(repo);
  const entry = s.files.find((f) => f.path === "src/new.ts");
  assert.ok(entry, `untracked file missing from the map: ${JSON.stringify(s.files)}`);
  assert.equal(entry.added, 3);
  assert.equal(entry.touch, "wrote");
});

test("a tracked edit is measured against HEAD, staged or not", async (t) => {
  const repo = await newRepo(t);
  await writeFile(join(repo, "a.txt"), "hello\nworld\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "base");
  await writeFile(join(repo, "a.txt"), "hello\nthere\nworld\n");
  // Staging is not reviewing: an agent that ran `git add` has not thereby
  // shown you anything.
  await git(repo, "add", "-A");
  const s = await repoState(repo);
  const entry = s.files.find((f) => f.path === "a.txt");
  assert.ok(entry, "staged edit missing from the map");
  assert.equal(entry.added, 1);
  assert.equal(s.diffs.length, 1);
});

test("a file that fails checks is on the map even when the agent never touched it", async (t) => {
  const repo = await newRepo(t);
  const s = await repoState(repo, [{ path: "src/old.ts", line: 4, message: "boom" }]);
  const entry = s.files.find((f) => f.path === "src/old.ts");
  // The reader's question is "what is broken". git's answer to "what moved"
  // does not contain it.
  assert.ok(entry, "failing untouched file missing from the map");
  assert.equal(entry.problems, 1);
});

test("the dock follows the file written last, not the first one alphabetically", async (t) => {
  const repo = await newRepo(t);
  for (const name of ["a.txt", "z.txt"]) {
    await writeFile(join(repo, name), "x\n");
  }
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "base");
  await writeFile(join(repo, "a.txt"), "x\ny\n");
  await new Promise((r) => setTimeout(r, 20));
  await writeFile(join(repo, "z.txt"), "x\ny\n");
  const s = await repoState(repo);
  const pick = await newest(repo, s.diffs);
  assert.equal(pick?.path, "z.txt");
});

// ---------------------------------------------------------------------------
// Narrow rendering

test("CHECKS in the rail counts first and lists second", () => {
  const result = {
    ok: false,
    command: "npm run typecheck",
    tail: "",
    // Real paths and real compiler messages, both far longer than a rail is
    // wide — a fixture that happens to fit proves nothing about clipping.
    problems: [
      { path: "src/auth/session.ts", line: 41, message: "error TS2532: Object is possibly 'undefined'." },
      { path: "src/auth/session.ts", line: 52, message: "error TS2345: Argument of type 'string' is not assignable." },
      { path: "src/auth/token.ts", line: 3, message: "error TS2304: Cannot find name 'verify'." },
      { path: "src/panels/rail.tsx", line: 4, message: "error TS7006: Parameter implicitly has an 'any' type." },
      { path: "src/transcript.ts", line: 5, message: "error TS2551: Property does not exist on type 'Usage'." },
    ],
  };
  const frame = render(<NarrowChecks result={result} width={30} />).lastFrame() ?? "";
  assert.match(frame, /✖ 5 in 4 files/);
  assert.match(frame, /…and 2 more/);
  for (const line of frame.split("\n")) {
    assert.ok(line.length <= 30, `checks row overflows the rail: ${JSON.stringify(line)}`);
  }
  // "not run yet" and "none configured" stay distinguishable: claiming a
  // project has no checker before looking is the same lie as showing a pass.
  assert.match(render(<NarrowChecks result={undefined} width={30} />).lastFrame() ?? "", /not run yet/);
  assert.match(render(<NarrowChecks result={null} width={30} />).lastFrame() ?? "", /none configured/);
});

test("the gauge is one line and the counts survive every rail width", () => {
  // The bar gives up its cells, never the numbers: at the narrow end the bar
  // shrinks to nothing before `105k/200k` loses a digit, because the digits
  // are what the reader is there for.
  // 20 is narrower than railWidth ever asks for, but a pane is not a
  // promise: drag the border and the rail gets whatever is left. One line
  // that overflows becomes two that Ink lays on top of the tree.
  for (const width of [20, 30, 34, 40, 44]) {
    const frame =
      render(<NarrowUsage usage={{ used: 105_000, size: 200_000, output: 12_000, cached: 0.99 }} width={width} />).lastFrame() ?? "";
    const lines = frame.split("\n");
    assert.equal(lines.length, 1, `expected one line at ${width}, got:\n${frame}`);
    assert.ok(lines[0]!.length <= width, `gauge overflows a ${width}-wide rail: ${JSON.stringify(lines[0])}`);
    assert.match(frame, /53%/, frame);
    assert.match(frame, /105k\/200k/, frame);
    // cache is the first thing cut, because it is the last thing read.
    if (width >= 30) assert.match(frame, /cache 99%/, frame);
    // The heading is gone; the line has to say what it is on its own.
    assert.doesNotMatch(frame, /CONTEXT/, frame);
    // And `out` went with the rows it cost.
    assert.doesNotMatch(frame, /out 12k/, frame);
  }
  // An unmeasured window is not an empty one.
  assert.match(render(<NarrowUsage usage={null} width={30} />).lastFrame() ?? "", /not measured/);
});

const MANY = Array.from({ length: 12 }, (_, i) => ({
  path: `src/deep/nested/file${i}.ts`,
  touch: "wrote" as const,
  added: i,
  removed: 0,
  problems: i === 9 ? 2 : 0,
}));

test("the budget counts what the fixed sections actually draw", () => {
  // These numbers exist so the map can be sized around them. If a section
  // renders one line more than it claims, the gauge goes off the bottom.
  const failing = {
    ok: false,
    command: "c",
    tail: "",
    problems: Array.from({ length: 9 }, (_, i) => ({ path: `f${i}.ts`, line: i, message: "m" })),
  };
  const count = (el: React.JSX.Element): number => (render(el).lastFrame() ?? "").split("\n").length;
  assert.equal(checksRows(undefined), count(<NarrowChecks result={undefined} width={30} />));
  assert.equal(checksRows(null), count(<NarrowChecks result={null} width={30} />));
  assert.equal(checksRows(failing), count(<NarrowChecks result={failing} width={30} />));
  assert.equal(checksRows({ ...failing, ok: true, problems: [] }), count(<NarrowChecks result={{ ...failing, ok: true, problems: [] }} width={30} />));
  assert.equal(usageRows(null), count(<NarrowUsage usage={null} width={30} />));
  const bare = { used: 1, size: 2 };
  assert.equal(usageRows(bare), count(<NarrowUsage usage={bare} width={30} />));
  const full = { used: 1, size: 2, output: 3, cached: 0.5 };
  assert.equal(usageRows(full), count(<NarrowUsage usage={full} width={30} />));
  // GOAL is a rule and a line, whatever it holds — and an agent whose
  // transcript srcy cannot read still draws the row that says so.
  assert.equal(count(<GoalLine turn={null} width={30} />), 1);
  assert.equal(count(<GoalLine turn={{ at: 1, text: "make it green\nplease" }} width={30} />), 1);
  // Three rules now — GOAL, PLAN, CHECKS — and the goal line under the
  // first of them. A budget counting one section fewer than the rail draws
  // pushes the gauge off the bottom, and Ink overdraws rather than scrolls.
  assert.equal(mapBudget(24, 3, 2, 1), 24 - 2 - 2 - 3 - 2 - 1);
  // And the map never gets a negative or absurd budget out of a tiny pane.
  assert.ok(mapBudget(6, 5, 4, 3) >= 3);
});

// ---------------------------------------------------------------------------
// Reading the transcript without re-reading it

test("folding in an append gives the same answer as parsing the whole file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "srcy-fold-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "s.jsonl");

  const first = [
    record({ input_tokens: 4, cache_creation_input_tokens: 100, cache_read_input_tokens: 0, output_tokens: 10 }),
    assistant([{ type: "tool_use", id: "a", name: "TodoWrite", input: { todos: [todo("one", "pending")] } }]),
    assistant([{ type: "tool_use", id: "t", name: "Edit", input: { file_path: "/r/a.ts" } }]),
  ].join("\n");
  await writeFile(path, `${first}\n`);

  const r = newReader(path);
  await advance(r, path);

  // What the agent writes next, including a result that closes the call the
  // first chunk left open — the case a tail-only reader gets wrong.
  const second = [
    user([{ type: "tool_result", tool_use_id: "t", content: "ok" }]),
    record({ input_tokens: 2, cache_creation_input_tokens: 50, cache_read_input_tokens: 900, output_tokens: 30 }),
    assistant([{ type: "tool_use", id: "b", name: "TodoWrite", input: { todos: [todo("one", "completed"), todo("two", "in_progress")] } }]),
  ].join("\n");
  await writeFile(path, `${first}\n${second}\n`);
  const fold = await advance(r, path);

  const whole = await readFile(path, "utf8");
  assert.deepEqual(stateOf(fold), parseState(whole));
  assert.deepEqual(usageOf(fold), parseUsage(whole));
  // And the totals really did accumulate across both chunks.
  assert.equal(usageOf(fold)?.output, 40);
  // The Edit the first chunk left open was closed by a result in the second —
  // the case a reader that only ever looks at the tail gets wrong.
  assert.notEqual(stateOf(fold).activity?.tool, "Edit");
});

test("a line still being written is folded in once, when it is finished", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "srcy-partial-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "s.jsonl");

  const line = assistant([{ type: "tool_use", id: "a", name: "TodoWrite", input: { todos: [todo("only once", "pending")] } }]);
  // Caught mid-write, with no trailing newline.
  await writeFile(path, line.slice(0, 40));
  const r = newReader(path);
  assert.deepEqual(stateOf(await advance(r, path)).plan, []);

  await writeFile(path, `${line}\n`);
  const fold = await advance(r, path);
  // Parsed exactly once: a reader that dropped the partial tail would lose
  // it, and one that re-read from the old offset would double it.
  assert.deepEqual(
    stateOf(fold).plan.map((e) => e.content),
    ["only once"],
  );
});

test("a replaced or truncated transcript starts over instead of folding onto a stranger", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "srcy-reset-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = join(dir, "a.jsonl");
  const b = join(dir, "b.jsonl");
  await writeFile(a, `${record({ input_tokens: 0, cache_creation_input_tokens: 5_000, cache_read_input_tokens: 0, output_tokens: 700 })}\n`);
  const r = newReader(a);
  assert.equal(usageOf(await advance(r, a))?.output, 700);

  // A new session in the same directory. Its numbers are its own.
  await writeFile(b, `${record({ input_tokens: 0, cache_creation_input_tokens: 1_000, cache_read_input_tokens: 0, output_tokens: 9 })}\n`);
  assert.equal(usageOf(await advance(r, b))?.output, 9);

  // And a file that shrank cannot be resumed from an offset past its end.
  await writeFile(b, `${record({ input_tokens: 0, cache_creation_input_tokens: 7, cache_read_input_tokens: 0, output_tokens: 1 })}\n`);
  assert.equal(usageOf(await advance(r, b))?.output, 1);
});

// ---------------------------------------------------------------------------
// When the checker runs

test("a tree that was already clean still gets checked", () => {
  // The bug: a clean tree fingerprints to "", so a mark starting at "" reads
  // as "nothing changed" and the checker never runs at all.
  const first = checkStep("", null, 0, 1_000, false);
  assert.equal(first.run, false, "nothing runs on the first sighting");
  assert.equal(first.quietSince, 1_000, "but the clock starts");
  assert.equal(checkStep("", first.mark, first.quietSince, 5_000, false).run, true);
});

test("the checker waits for the tree to stop moving, then runs once", () => {
  let step = checkStep("a.ts:1:0", null, 0, 0, false);
  // Still being edited: the clock restarts, nothing runs.
  step = checkStep("a.ts:2:0", step.mark, step.quietSince, 1_000, false);
  assert.equal(step.run, false);
  assert.equal(step.quietSince, 1_000);
  // Quiet, but not long enough yet.
  assert.equal(checkStep("a.ts:2:0", step.mark, step.quietSince, 2_000, false).run, false);
  // Quiet long enough.
  const ran = checkStep("a.ts:2:0", step.mark, step.quietSince, 9_000, false);
  assert.equal(ran.run, true);
  // And not again on the same tree, or the rail would re-run a ten-second
  // typecheck once a second forever.
  assert.equal(checkStep("a.ts:2:0", ran.mark, ran.quietSince, 20_000, false).run, false);
  // Nor while one is already in flight.
  assert.equal(checkStep("a.ts:2:0", step.mark, step.quietSince, 9_000, true).run, false);
});

// ---------------------------------------------------------------------------
// Naming the session, and reading the command line

test("two repos with the same basename get different sessions", () => {
  // Otherwise `srcy` in ~/side/api re-attaches to the agent working in
  // ~/work/api: the reader types at an agent editing a repo they are not
  // looking at, beside a rail describing the other one.
  assert.notEqual(sessionName("/home/u/work/api"), sessionName("/home/u/side/api"));
  // Same path, same session — that is what makes re-attaching work at all.
  assert.equal(sessionName("/home/u/work/api"), sessionName("/home/u/work/api"));
  // --name still separates two sessions on one repo.
  assert.notEqual(sessionName("/home/u/work/api"), sessionName("/home/u/work/api", "review"));
  // tmux reads . and : as target syntax, so neither may appear in a name.
  assert.doesNotMatch(sessionName("/home/u/my.repo", "a:b"), /[.:]/);
});

test("a mistyped flag is refused, not ignored", () => {
  // The failure this prevents: `--agnet codex` silently starting the default
  // agent, giving a working session driven by the wrong one.
  assert.throws(() => parseShell(["--agnet", "codex"]), /unknown option/);
  assert.throws(() => parseShell(["--agent"]), /requires a value/);
  assert.deepEqual(parseShell([]).agent, ["claude"]);
  assert.deepEqual(parseShell(["--agent", "codex"]).agent, ["codex"]);
  assert.deepEqual(parseShell(["--", "claude", "--model", "opus"]).agent, ["claude", "--model", "opus"]);
  assert.equal(parseShell(["--name", "review"]).name, "review");
});

test("the layout turns on what the agents in the pane ask their terminal for", () => {
  // Claude Code wants focus-events, pi wants extended-keys for shift+enter.
  // Both are server-wide options, which is the whole reason srcy runs its own
  // tmux server: setting them on the reader's would reach into every other
  // session they have open and stay changed after srcy exits.
  const opts = new Map(
    plan(LAYOUT)
      .filter((s) => s[0] === "set-option")
      .map((s) => [s[3]!, s[4]!]),
  );
  assert.equal(opts.get("focus-events"), "on");
  assert.equal(opts.get("extended-keys"), "on");
});

test("every teardown the agent's shell runs reaches srcy's own server", () => {
  // A bare `tmux kill-session` from inside the pane talks to the default
  // server, where this session does not exist — so nothing is torn down and
  // the panels outlive the agent again.
  const start = plan(LAYOUT).find((s) => s[0] === "new-session")!;
  assert.match(start.at(-1)!, new RegExp(`${TMUX} kill-session`));
  assert.equal(TMUX.includes("-L"), true);
});

// ---------------------------------------------------------------------------
// Codex

// Shapes copied from a real ~/.codex/sessions log, not invented.
const cxMeta = (cwd: string): string =>
  JSON.stringify({ type: "session_meta", payload: { session_id: "s", cwd, cli_version: "0.147.0" } });

const cxTokens = (last: Record<string, number>, totalOut: number, window = 258_400): string =>
  JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: 20_987_367, output_tokens: totalOut },
        last_token_usage: last,
        model_context_window: window,
      },
    },
  });

const cxCall = (id: string, name: string, args: unknown): string =>
  JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) } });

const cxDone = (id: string): string =>
  JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: id, output: "ok" } });

function cxFold(lines: string[]) {
  const f = emptyFold();
  for (const l of lines) codexFold(f, l);
  return f;
}

test("codex occupancy is the last request's, against the window codex itself recorded", () => {
  // total_token_usage.input_tokens reaches twenty million against a 258k
  // window — summing it would peg the gauge at 100% forever, the same trap
  // the Claude reader has. And the window is read, not guessed: codex is the
  // only agent that writes it down.
  const f = cxFold([
    cxTokens({ input_tokens: 14_890, cached_input_tokens: 11_008 }, 261),
    cxTokens({ input_tokens: 161_209, cached_input_tokens: 160_512 }, 34_012),
  ]);
  const u = usageOf(f);
  assert.equal(u?.used, 161_209);
  assert.equal(u?.size, 258_400);
  assert.equal(u?.output, 34_012);
  assert.equal(Math.round((u?.cached ?? 0) * 100), 100);
  // A model with a different window is believed, not overridden by the
  // 200k/1M guess the Claude reader has to make.
  assert.equal(usageOf(cxFold([cxTokens({ input_tokens: 10 }, 1, 400_000)]))?.size, 400_000);
});

test("a codex call is in flight until its output lands", () => {
  const running = cxFold([cxCall("call_1", "shell", { command: ["npm", "test"] })]);
  assert.deepEqual(stateOf(running).activity, { tool: "shell", target: "npm test", since: undefined });
  assert.equal(stateOf(cxFold([cxCall("call_1", "shell", { command: ["npm", "test"] }), cxDone("call_1")])).activity, null);
});

test("codex's plan is read when it writes one", () => {
  // Unverified against a real log: update_plan exists as a tool but no
  // session on this machine has ever called it, so this is written from the
  // tool's shape.
  const f = cxFold([
    cxCall("call_p", "update_plan", {
      plan: [
        { step: "find the comparison", status: "completed" },
        { step: "fix the off-by-one", status: "in_progress" },
      ],
    }),
  ]);
  assert.deepEqual(stateOf(f).plan, [
    { content: "find the comparison", status: "completed" },
    { content: "fix the off-by-one", status: "in_progress" },
  ]);
});

test("codex sessions are found by the directory they declare, newest first", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "srcy-cx-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Filed by date, several levels down — the walk must not count levels.
  const day = join(root, "2026", "08", "19");
  await mkdir(day, { recursive: true });
  await writeFile(join(day, "old.jsonl"), `${cxMeta("/r/mine")}\n${cxTokens({ input_tokens: 5 }, 1)}\n`);
  await new Promise((r) => setTimeout(r, 20));
  await writeFile(join(day, "new.jsonl"), `${cxMeta("/r/mine")}\n${cxTokens({ input_tokens: 9 }, 2)}\n`);
  await writeFile(join(day, "other.jsonl"), `${cxMeta("/r/theirs")}\n`);

  assert.match((await findSession("/r/mine", root)) ?? "", /new\.jsonl$/);
  assert.match((await findSession("/r/theirs", root)) ?? "", /other\.jsonl$/);
  // A directory codex has never worked in is not somebody else's session.
  assert.equal(await findSession("/r/never", root), null);
});

test("the panel reads the format the agent in the pane actually writes", () => {
  // The agent name is a command, so anything unrecognised gets no source at
  // all: REPO, CHECKS and DIFF still work, since those come from git.
  assert.equal(sourceFor("claude"), CLAUDE);
  assert.equal(sourceFor("/usr/local/bin/codex"), CODEX);
  assert.equal(sourceFor("aider"), null);
  assert.equal(sourceFor(""), null);
});

// ---------------------------------------------------------------------------
// The tree

const FILES = ["README.md", "src/auth/token.ts", "src/auth/session.ts", "src/main.ts", "docs/a.md"];
const CHANGED = new Map([["src/auth/token.ts", { path: "src/auth/token.ts", touch: "wrote" as const, added: 1, removed: 1, problems: 0 }]]);

test("directories start closed, except the ones holding this session's work", () => {
  // A rail that hid the change behind a closed src/ would make you navigate
  // to see the thing you just asked about.
  const open = openForChanges(CHANGED.keys());
  assert.deepEqual([...open].sort(), ["src", "src/auth"]);
  const shown = treeRows(FILES, open, CHANGED).map((r) => r.path);
  assert.ok(shown.includes("src/auth/token.ts"), `the change is not visible: ${shown.join(", ")}`);
  // Everything else stays one row.
  assert.ok(shown.includes("docs"), "docs/ missing");
  assert.ok(!shown.includes("docs/a.md"), "an unrelated directory was opened");
});

test("the tree draws directories before files, each alphabetically", () => {
  const all = treeRows(FILES, new Set(["src", "src/auth", "docs"])).map((r) => r.path);
  assert.deepEqual(all, [
    "docs", "docs/a.md",
    "src", "src/auth", "src/auth/session.ts", "src/auth/token.ts", "src/main.ts",
    "README.md",
  ]);
});

test("ancestors names every directory on the way down, and toggle flips one", () => {
  assert.deepEqual(ancestors("a/b/c.ts"), ["a", "a/b"]);
  assert.deepEqual(ancestors("top.ts"), []);
});

test("opening one directory by hand does not freeze the rest of the view", () => {
  // The bug: a single "manual wins" set meant that touching one folder
  // stopped every other folder from opening for a change, so work the agent
  // did next stayed hidden behind a closed directory.
  const auto = new Set(["src"]);
  const opened = toggle(NOTHING, "docs", false);
  assert.deepEqual([...openSet(auto, opened)].sort(), ["docs", "src"]);

  // A directory closed by hand stays closed even once it holds a change,
  // and everything else still follows the work.
  const closed = toggle(NOTHING, "src", true);
  assert.deepEqual([...openSet(new Set(["src", "lib"]), closed)].sort(), ["lib"]);

  // And the override is remembered as an override: reopening it by hand
  // does not need the change to go away first.
  assert.deepEqual([...openSet(new Set(["src"]), toggle(closed, "src", false))].sort(), ["src"]);
});

test("the viewport keeps the cursor on screen without scrolling past the ends", () => {
  // Off either end is the failure that matters: a cursor you cannot see is a
  // cursor you cannot steer.
  assert.deepEqual(treeWindow(5, 3, 10), { start: 0, end: 5 });
  assert.deepEqual(treeWindow(100, 0, 10), { start: 0, end: 10 });
  assert.deepEqual(treeWindow(100, 99, 10), { start: 90, end: 100 });
  for (const cursor of [0, 1, 37, 98, 99]) {
    const w = treeWindow(100, cursor, 10);
    assert.ok(cursor >= w.start && cursor < w.end, `cursor ${cursor} outside ${JSON.stringify(w)}`);
    assert.equal(w.end - w.start, 10);
  }
});

test("a tree row is clipped to the rail, and a failing file spends its column on the failures", () => {
  const long = { path: "src/a-very-long-file-name.ts", name: "a-very-long-file-name.ts", depth: 2, dir: false,
    entry: { path: "src/a-very-long-file-name.ts", touch: "wrote" as const, added: 120, removed: 4, problems: 0 } };
  const frame = render(<TreeLine row={long} width={24} cursor={false} />).lastFrame() ?? "";
  // A wrapped row restarts at column zero and shifts every row under it.
  for (const line of frame.split("\n")) assert.ok(line.length <= 24, `row overflows: ${JSON.stringify(line)}`);

  const broken = { path: "t.ts", name: "t.ts", depth: 0, dir: false,
    entry: { path: "t.ts", touch: "wrote" as const, added: 1, removed: 1, problems: 2 } };
  const bad = render(<TreeLine row={broken} width={30} cursor={false} />).lastFrame() ?? "";
  // "+1 -1" is not what you act on when the file no longer compiles.
  assert.match(bad, /✖2/);
  assert.doesNotMatch(bad, /\+1 -1/);
});

test("every glyph the rail draws is one cell wide in every terminal", () => {
  // ● ○ ▶ █ are East-Asian *Ambiguous*: a terminal set to ambiguous-width
  // double renders them two cells, which tears a fixed-width column and
  // slides the gauge as it fills.
  const frames = [
    render(<TreeLine row={{ path: "s", name: "src", depth: 0, dir: true, open: true }} width={20} cursor />).lastFrame(),
    render(<TreeLine row={{ path: "s", name: "src", depth: 0, dir: true, open: false }} width={20} cursor={false} />).lastFrame(),
    render(<TreeLine row={{ path: "a.ts", name: "a.ts", depth: 1, dir: false,
      entry: { path: "a.ts", touch: "wrote" as const, added: 2, removed: 1, problems: 3 } }} width={24} cursor={false} />).lastFrame(),
    render(<NarrowUsage usage={{ used: 104_800, size: 200_000, output: 12_000, cached: 0.99 }} width={30} />).lastFrame(),
    render(<NarrowChecks result={{ ok: false, command: "c", tail: "", problems: [{ path: "a.ts", line: 4, message: "boom" }] }} width={30} />).lastFrame(),
  ];
  for (const frame of frames) {
    for (const ch of frame ?? "") {
      const w = eastAsianWidth(ch.codePointAt(0)!, { ambiguousAsWide: true });
      assert.equal(w, 1, `${JSON.stringify(ch)} (U+${ch.codePointAt(0)!.toString(16)}) is not one cell:\n${frame}`);
    }
  }
});

test("the cursor follows a file, not a row number", () => {
  // The agent creates files while you are reading. Held as an index, the
  // cursor points at a different file every time the list shifts under it.
  const before = treeRows(["src/b.ts", "src/c.ts"], new Set(["src"]));
  const after = treeRows(["src/a.ts", "src/b.ts", "src/c.ts"], new Set(["src"]));
  const was = cursorAt(before, "src/b.ts");
  assert.equal(before[was]?.path, "src/b.ts");
  assert.equal(after[was]?.path, "src/a.ts", "fixture no longer shifts; the test proves nothing");
  // Same file, wherever it moved to.
  assert.equal(after[cursorAt(after, "src/b.ts")]?.path, "src/b.ts");

  // A picked row that vanished — deleted, or hidden by a directory closing —
  // falls back to the session's work rather than to nothing.
  const changed = new Map([["src/c.ts", { path: "src/c.ts", touch: "wrote" as const, added: 1, removed: 0, problems: 0 }]]);
  const withChange = treeRows(["src/b.ts", "src/c.ts"], new Set(["src"]), changed);
  assert.equal(withChange[cursorAt(withChange, "src/gone.ts")]?.path, "src/c.ts");
  // And an untouched cursor starts on the work, not on row zero.
  assert.equal(withChange[cursorAt(withChange, null)]?.path, "src/c.ts");
  // With nothing changed and nothing picked, the top is the only answer.
  assert.equal(cursorAt(treeRows(["a.ts"], new Set()), null), 0);
});

test("elapsed time is coarse where coarse is what gets read", () => {
  assert.equal(elapsed(180), "0.2s");
  assert.equal(elapsed(4100), "4.1s");
  assert.equal(elapsed(12_400), "12s");
  assert.equal(elapsed(63_000), "1m03s");
  assert.equal(elapsed(605_000), "10m05s");
  // A clock that has not started must not render a negative age.
  assert.equal(elapsed(-5000), "0s");
});

test("the border says how long the current call has been running", () => {
  // A still picture of "running npm test" cannot tell you whether the agent
  // is working or wedged. The clock is what does.
  const a = { tool: "Bash", target: "npm test", since: 1_000 };
  assert.match(activityTitle(a, 48_000), /⟳ 47s Bash npm test/);
  // Without a clock reading, or without a start time, the title is just the
  // call — never a made-up duration.
  assert.doesNotMatch(activityTitle(a, 0), /s\s*$/);
  assert.doesNotMatch(activityTitle({ tool: "Bash", target: "x" }, 48_000), /47/);
  // The age survives truncation of a long target, at every width tmux might
  // hand a narrow rail — it is the part you cannot get by looking at the
  // agent's own pane, so it must never be what gets cut.
  for (const w of [10, 16, 24, 40]) {
    assert.match(activityTitle({ tool: "Bash", target: "y".repeat(200), since: 0 }, 90_000, w), /1m30s/, `width ${w}`);
  }
});

test("the rail draws the project, the plan and the gauge from what is on disk", async (t) => {
  // The one test that runs the rail end to end: a real repo, a real
  // transcript in the place the reader's agent would write it, and the
  // panel's own polling. Every other rail test checks a piece.
  const repo = await newRepo(t);
  await mkdir(join(repo, "src", "auth"), { recursive: true });
  await writeFile(join(repo, "src/auth/token.ts"), "a\n");
  await writeFile(join(repo, "docs.md"), "unrelated\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "base");
  await writeFile(join(repo, "src/auth/token.ts"), "a\nb\n");

  const dir = projectDir(repo);
  await mkdir(dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "s.jsonl"),
    [
      record({ input_tokens: 2, cache_creation_input_tokens: 600, cache_read_input_tokens: 94_000, output_tokens: 1_200 }),
      assistant([{ type: "tool_use", id: "p", name: "TodoWrite", input: { todos: [todo("fix the expiry", "in_progress")] } }]),
      "",
    ].join("\n"),
  );

  const { lastFrame, unmount } = render(<Rail cwd={repo} width={34} interactive={false} source={CLAUDE} />);
  t.after(() => unmount());
  await new Promise((r) => setTimeout(r, 900));
  const frame = lastFrame() ?? "";

  // The tree, opened to the work and closed elsewhere.
  assert.match(frame, /src\//, frame);
  assert.match(frame, /auth\//, frame);
  assert.match(frame, /token\.ts\s+\+1 -0/, frame);
  // The plan and the gauge, read from the transcript.
  assert.match(frame, /fix the expiry/, frame);
  assert.match(frame, /94\.6k|95k/, frame);
  assert.match(frame, /\u25ae/, frame); // the gauge itself, on the bottom edge
  assert.doesNotMatch(frame, /CONTEXT/, frame);
  // And nothing wrapped past the pane it was given.
  for (const line of frame.split("\n")) {
    assert.ok(line.length <= 34, `rail row overflows: ${JSON.stringify(line)}`);
  }
});

test("a check whose code has already moved says so instead of reading as current", () => {
  // Acting on a stale pass is the expensive mistake: a green line from
  // thirty seconds ago looks exactly like a green line from now.
  const failing = { ok: false, command: "npm run typecheck", tail: "",
    problems: [{ path: "src/a.ts", line: 1, message: "boom" }] };
  const fresh = render(<NarrowChecks result={failing} width={40} />).lastFrame() ?? "";
  const stale = render(<NarrowChecks result={failing} width={40} stale />).lastFrame() ?? "";
  assert.doesNotMatch(fresh, /moved/);
  assert.match(stale, /moved since/);
  // A stale pass must not keep claiming the build is green.
  const passing = { ...failing, ok: true, problems: [] };
  assert.match(render(<NarrowChecks result={passing} width={40} stale />).lastFrame() ?? "", /moved since/);
  assert.doesNotMatch(render(<NarrowChecks result={passing} width={40} />).lastFrame() ?? "", /moved/);
  // Staleness is not a fourth state to confuse with the other three.
  assert.match(render(<NarrowChecks result={undefined} width={40} stale />).lastFrame() ?? "", /not run yet/);
});

// ---------------------------------------------------------------------------
// What the checker actually said

const failing = (problems: { path: string; line: number; message: string }[], tail = ""): {
  command: string;
  ok: boolean;
  problems: { path: string; line: number; message: string }[];
  tail: string;
} => ({ command: "npm run typecheck", ok: false, problems, tail });

test("the dock prints the message the rail has no room for", () => {
  const problems = [
    { path: "src/auth/session.ts", line: 3, message: "error TS2532: Object is possibly 'undefined'." },
    { path: "src/auth/token.ts", line: 9, message: "error TS2345: Argument of type 'string' is not assignable." },
  ];
  const lines = problemLines(failing(problems), "src/auth/token.ts", 100);
  // The file on screen leads: the diff underneath is about that one.
  assert.match(lines[0]!, /token\.ts:9/, lines.join("\n"));
  assert.match(lines[0]!, /TS2345/, lines.join("\n"));
  assert.match(lines[1]!, /session\.ts:3/, lines.join("\n"));
  // Which is the whole point: the rail can say where, never what.
  const rail = render(<NarrowChecks result={failing(problems)} width={30} />).lastFrame() ?? "";
  assert.doesNotMatch(rail, /TS2532/, rail);

  // Nothing to say when the check passed, was never run, or does not exist.
  assert.deepEqual(problemLines({ ...failing([]), ok: true }, "a.ts", 80), []);
  assert.deepEqual(problemLines(undefined, "a.ts", 80), []);
  assert.deepEqual(problemLines(null, "a.ts", 80), []);
});

test("the dock caps the failure list and says what it cut", () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    path: `src/deeply/nested/module${i}.ts`,
    line: i + 1,
    message: `error TS2532: Object is possibly 'undefined' and this sentence runs well past any pane ${i}`,
  }));
  const lines = problemLines(failing(many), undefined, 100);
  assert.equal(lines.length, 5, lines.join("\n"));
  assert.match(lines[4]!, /…and 5 more/, lines.join("\n"));
  // And every line is clipped to the pane, never wrapped onto the diff.
  for (const line of problemLines(failing(many), undefined, 24)) {
    assert.ok(line.length <= 24, JSON.stringify(line));
  }
});

test("a failure that named no file still shows its output somewhere", () => {
  // Parsed nothing means the tail is the only evidence there is, and no
  // other pane draws it — a red rail with no message anywhere is the state
  // this exists to prevent.
  const lines = problemLines(failing([], "\nlink error: undefined symbol _start\nexit 2\n"), "a.ts", 80);
  assert.deepEqual(lines, ["  link error: undefined symbol _start", "  exit 2"]);
});

test("the panels pass a check result between processes without tmux mangling it", async (t) => {
  // tmux 3.4 was the first transport: set-option refuses a value past ~16 KB,
  // and `$name` in a value reads back with a backslash inserted, which makes
  // JSON.parse throw. Both are exercised here.
  const session = `srcy-test-bus-${process.pid}`;
  t.after(() => rm(join(tmpdir(), `${session}.json`), { force: true }));
  const problems = Array.from({ length: 20 }, (_, i) => ({
    path: `src/very/deeply/nested/module${i}.ts`,
    line: i + 1,
    message: `error TS2532: $HOME is possibly 'undefined' ${"x".repeat(400)}`,
  }));
  publish(session, { file: "src/auth/token.ts" });
  publish(session, { checks: failing(problems, "tail") });
  const got = await readShared(session);
  assert.equal(got.file, "src/auth/token.ts");
  assert.deepEqual(got.checks?.problems, problems);

  // An unwritten session is "nothing picked", not a crash.
  assert.deepEqual(await readShared(`srcy-test-absent-${process.pid}`), {});
});

test("the dock gives the diff the rows the failures took", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "srcy-dockrows-"));
  const session = `srcy-test-dock-${process.pid}`;
  t.after(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(join(tmpdir(), `${session}.json`), { force: true });
  });
  await writeFile(join(repo, "a.ts"), "const a = 1\n");
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "t@t");
  await git(repo, "config", "user.name", "t");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "base");
  // Long enough that the diff has to clip. With the failure line taking a
  // row and nothing giving one back, the pane overflows — and Ink overdraws
  // rather than scrolling, so the overflow lands on top of the border.
  await writeFile(
    join(repo, "a.ts"),
    `const a = 1\n${Array.from({ length: 12 }, (_, i) => `const v${i} = ${i}`).join("\n")}\n`,
  );
  publish(session, {
    file: "a.ts",
    checks: failing([
      { path: "a.ts", line: 2, message: "error TS1000: nope" },
      { path: "a.ts", line: 3, message: "error TS1001: also nope" },
      { path: "a.ts", line: 4, message: "error TS1002: still nope" },
    ]),
  });

  const { lastFrame, unmount } = render(<Dock cwd={repo} rows={8} width={70} session={session} />);
  t.after(() => unmount());
  await new Promise((r) => setTimeout(r, 900));
  const frame = lastFrame() ?? "";
  assert.match(frame, /TS1000: nope/, frame);
  assert.match(frame, /const v11 = 11/, frame);
  // The three failure rows came out of the diff's budget, not out of the pane.
  assert.ok(frame.split("\n").length <= 8, `${frame.split("\n").length} rows in a pane of 8:\n${frame}`);
});

// The pane the whole upgrade is for: not the tail of the newest hunk, the
// whole change. Every row carries its own new-side number, so there is no
// heading left to point at a line the reader cannot see.
test("the dock shows every hunk of the file, and says how to move", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "srcy-review-"));
  const session = `srcy-test-review-${process.pid}`;
  t.after(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(join(tmpdir(), `${session}.json`), { force: true });
  });
  const base = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
  await writeFile(join(repo, "a.ts"), `${base}\n`);
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "t@t");
  await git(repo, "config", "user.name", "t");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "base");
  // Two edits far enough apart that git makes two hunks of them. The old
  // pane could only ever draw the second.
  const edited = base.replace("line 1\n", "line 1\nFIRST EDIT\n").replace("line 18", "line 18\nSECOND EDIT");
  await writeFile(join(repo, "a.ts"), `${edited}\n`);

  const { lastFrame, unmount } = render(<Dock cwd={repo} rows={40} width={70} session={session} />);
  t.after(() => unmount());
  await new Promise((r) => setTimeout(r, 900));
  const frame = lastFrame() ?? "";
  assert.match(frame, /FIRST EDIT/, frame);
  assert.match(frame, /SECOND EDIT/, frame);
  // And the keys are on screen rather than behind a `?` nobody presses.
  assert.match(frame, /n\/p file/, frame);
});

// The TURN baseline is only worth having if it is honest. It is taken the
// moment a request lands, and thrown away rather than shipped when the agent
// turns out to have already started writing — the shape of a fast agent, and
// the one case where a baseline would hide exactly what it was opened to show.
test("a turn baseline is refused when the agent had already started writing", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "srcy-baseline-"));
  const log = join(repo, "session.jsonl");
  t.after(() => rm(repo, { recursive: true, force: true }));
  await writeFile(join(repo, "a.ts"), "const a = 1\n");
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "t@t");
  await git(repo, "config", "user.name", "t");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "base");

  const at = Date.parse("2026-08-25T10:00:00.000Z");
  const iso = (ms: number): string => new Date(ms).toISOString();
  const said = JSON.stringify({ type: "user", timestamp: iso(at), message: { role: "user", content: "fix the thing" } });
  await writeFile(log, `${said}\n`);
  // A named function: readSession keys its remembered offset by it.
  async function findFixture(): Promise<string> {
    return log;
  }
  const source: Source = { find: findFixture, fold: claudeFold };

  const clean = await baseline(repo, source, at);
  assert.match(clean.turn ?? "", /^[0-9a-f]{40}$/, JSON.stringify(clean));
  assert.equal(clean.turnWhy, undefined);

  // Now the agent starts editing, and the same request is baselined again.
  const wrote = JSON.stringify({
    type: "assistant",
    timestamp: iso(at + 500),
    message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "a.ts" } }] },
  });
  await appendFile(log, `${wrote}\n`);
  const late = await baseline(repo, source, at);
  assert.equal(late.turn, undefined, "a baseline taken after the work is not a baseline");
  assert.match(late.turnWhy ?? "", /already writing/);
});

test("a reopened session does not pin the dock to last time's file", async (t) => {
  // The session name is derived from the repo, so it comes back identical
  // tomorrow — and so does the state file, still holding whatever was picked
  // before. The rail clears it before the dock can read it.
  const repo = await mkdtemp(join(tmpdir(), "srcy-stale-"));
  const session = `srcy-test-stale-${process.pid}`;
  const state = join(tmpdir(), `${session}.json`);
  t.after(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(state, { force: true });
  });
  await writeFile(join(repo, "a.ts"), "const a = 1\n");
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "t@t");
  await git(repo, "config", "user.name", "t");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "base");
  await writeFile(state, JSON.stringify({ file: "gone-yesterday.ts" }));

  const { unmount } = render(<Rail cwd={repo} width={30} height={20} session={session} interactive={false} />);
  t.after(() => unmount());
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await readShared(session)).file, undefined);
});

test("an in-place edit re-runs the checker, even though the churn is identical", async (t) => {
  // The commonest edit an agent makes is replacing a line with a different
  // line: the fix for the bug it introduced three seconds ago. Churn counts
  // cannot see it — `+1 -1` before, `+1 -1` after — so a fingerprint built
  // from counts left the sidebar showing the verdict from before the fix, and
  // not even marked stale, because nothing looked like it had moved.
  const repo = await mkdtemp(join(tmpdir(), "srcy-mark-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await writeFile(join(repo, "a.ts"), "const a = 1\n");
  await git(repo, "init", "-q");
  await git(repo, "config", "user.email", "t@t");
  await git(repo, "config", "user.name", "t");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "base");

  await writeFile(join(repo, "a.ts"), "const a = 2\n");
  const broke = await repoState(repo);
  await writeFile(join(repo, "a.ts"), "const a = 3\n");
  const fixed = await repoState(repo);

  assert.deepEqual(
    broke.files.map((f) => [f.added, f.removed]),
    fixed.files.map((f) => [f.added, f.removed]),
    "the churn is identical either way — that is the whole problem",
  );
  assert.notEqual(fingerprint(broke), fingerprint(fixed), "the checker would never run again");

  // The same tree twice is the same mark, or the checker would run every poll.
  assert.equal(fingerprint(await repoState(repo)), fingerprint(fixed));

  // And the same holds for a file git has never seen, whose content is not in
  // `git diff HEAD` at all.
  await writeFile(join(repo, "new.ts"), "export const x = 1\n");
  const before = fingerprint(await repoState(repo));
  await writeFile(join(repo, "new.ts"), "export const x = 2\n");
  assert.notEqual(fingerprint(await repoState(repo)), before);
});
