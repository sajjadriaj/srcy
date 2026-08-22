import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import React from "react";
import { Box } from "ink";
import { render } from "ink-testing-library";
import type { AgentSession } from "../src/acp.js";
import { PlanBar, RepoMap, type MapEntry } from "../src/cockpit.js";
import { git } from "../src/git.js";
import type { Worktree } from "../src/git.js";
import { App } from "../src/ui.js";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { newRepo, write } from "./helpers.js";

function entry(path: string, over: Partial<MapEntry> = {}): MapEntry {
  return { path, touch: "wrote", added: 1, removed: 0, problems: 0, ...over };
}

test("an unfocused repo map carries no cursor at all", () => {
  const { lastFrame } = render(<RepoMap entries={[entry("src/a.ts"), entry("src/b.ts")]} />);
  const frame = lastFrame() ?? "";
  // A caret with no keyboard behind it is an invitation to press keys that
  // do nothing.
  assert.doesNotMatch(frame, /►/, frame);
  assert.match(frame, /^REPO$/m, frame);
});

test("the cursor counts file rows, not screen rows — directory headers are not selectable", () => {
  // Two directories means two header rows interleaved among the files. A
  // cursor that counted rendered lines would land on "lib/" here.
  const entries = [entry("src/a.ts"), entry("src/b.ts"), entry("lib/c.ts")];
  const { lastFrame } = render(<RepoMap entries={entries} cursor={2} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /►.*c\.ts/, frame);
  assert.doesNotMatch(frame, /►.*(a\.ts|b\.ts|\/$)/, frame);
  // Focus is announced, so it is clear which pane the keyboard is in.
  assert.match(frame, /REPO ▸/, frame);
});

test("the caret occupies a column that is blank otherwise, so focus never reflows the rows", () => {
  const entries = [entry("src/a.ts")];
  const off = (render(<RepoMap entries={entries} />).lastFrame() ?? "").split("\n");
  const on = (render(<RepoMap entries={entries} cursor={0} />).lastFrame() ?? "").split("\n");
  const fileRow = (rows: string[]): string => rows.find((r) => r.includes("a.ts"))!;
  assert.equal(fileRow(off).length, fileRow(on).length, `${fileRow(off)}\n${fileRow(on)}`);
  assert.equal(fileRow(off).indexOf("a.ts"), fileRow(on).indexOf("a.ts"));
});

const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

function renderApp(worktree: Worktree, bridge: EventEmitter): ReturnType<typeof render> {
  const session = {
    sessionId: "s1",
    prompt: async () => "",
    cancel: async () => {},
    close: async () => {},
  } as unknown as AgentSession;
  return render(
    <App
      branch="ctui/s1"
      session={session}
      bridge={bridge}
      worktree={worktree}
      initialMode="default"
      modeDegraded={false}
      explain={false}
      onExit={() => {}}
    />,
  );
}

const A_DIFF = [
  "diff --git a/a.txt b/a.txt",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -29,2 +29,4 @@",
  " line 29",
  "+TWO",
  "+three",
  " line 30",
  "",
].join("\n");

// Long enough that where the view lands is a real question: the change is
// two thirds down, so a view that opened at line 1 would show none of it.
const SEEDED = Array.from({ length: 38 }, (_, i) => `line ${i + 1}`);
const EDITED = [...SEEDED.slice(0, 29), "TWO", "three", ...SEEDED.slice(29)];

test("tab focuses the map, j moves, enter opens the file at what this session changed", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "a.txt", SEEDED.join("\n") + "\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "seed a.txt");
  await write(repo, "a.txt", EDITED.join("\n") + "\n");
  await write(repo, "zz.txt", "untouched\n");
  const worktree = { path: repo, repo, diff: async () => A_DIFF } as unknown as Worktree;
  const bridge = new EventEmitter();
  const { stdin, lastFrame, unmount } = renderApp(worktree, bridge);
  t.after(() => unmount());
  await settle(80);

  // A read gives the map a second row, so j has somewhere to go and the
  // cursor's starting position is observable.
  bridge.emit("update", { kind: "tool_call", toolCallId: "1", toolKind: "read", toolPath: "zz.txt", raw: {} });
  // A write is what puts a.txt in the map with a diff behind it.
  bridge.emit("update", { kind: "tool_call", toolCallId: "2", toolKind: "edit", toolPath: "a.txt", raw: {} });
  await settle(250);

  assert.doesNotMatch(lastFrame() ?? "", /►/, "cursor showing before the pane was focused");
  stdin.write("\t");
  await settle(120);
  assert.match(lastFrame() ?? "", /►.*a\.txt/, `tab did not focus the map:\n${lastFrame()}`);

  stdin.write("j");
  await settle(120);
  assert.match(lastFrame() ?? "", /►.*zz\.txt/, `j did not move the cursor:\n${lastFrame()}`);
  stdin.write("k");
  await settle(120);
  assert.match(lastFrame() ?? "", /►.*a\.txt/, `k did not move the cursor back:\n${lastFrame()}`);
  // The keys that steer a focused pane must not also land in the prompt —
  // the same leak ctrl-p had when it opened the picker.
  assert.doesNotMatch(lastFrame() ?? "", /> *[jk]/, `navigation keys leaked into the prompt:\n${lastFrame()}`);

  stdin.write("\r");
  await settle(400);
  const opened = lastFrame() ?? "";
  // The point of opening it is what changed, so the view lands there and
  // marks exactly those lines — not the whole hunk span around them.
  assert.match(opened, /\+ {4}30 {2}TWO/, `changed line not marked:\n${opened}`);
  assert.match(opened, /\+ {4}31 {2}three/, `changed line not marked:\n${opened}`);
  // The hunk spans four new-side lines; only two of them are new. Marking
  // the span would flag two lines the session never touched.
  assert.doesNotMatch(opened, /\+ {4}29 {2}line 29/, `unchanged line marked as changed:\n${opened}`);
  assert.doesNotMatch(opened, /\+ {4}32 {2}line 30/, `unchanged line marked as changed:\n${opened}`);
  // The view opened where the change is, not at the top of the file.
  assert.doesNotMatch(opened, /line 5$/m, `view opened at the top of the file:\n${opened}`);
  // And the gutter says where the rest of the file came from.
  assert.match(opened, /── this session/, `no provenance on a file opened from the map:\n${opened}`);

  // Escape returns to the session, not to a file picker that was never open.
  stdin.write("\x1b");
  await settle(150);
  assert.doesNotMatch(lastFrame() ?? "", /OPEN {2}\d+ files/, `escape dropped the reader in the picker:\n${lastFrame()}`);
  assert.match(lastFrame() ?? "", /\[tab\] repo map/, `escape did not return to the session:\n${lastFrame()}`);
});

test("the cursor stays on the file it was on when the agent writes one that sorts above it", async (t) => {
  const repo = await newRepo(t);
  const worktree = { path: repo, repo, diff: async () => "" } as unknown as Worktree;
  const bridge = new EventEmitter();
  const { stdin, lastFrame, unmount } = renderApp(worktree, bridge);
  t.after(() => unmount());
  await settle(80);

  const read = (path: string, id: string): boolean =>
    bridge.emit("update", { kind: "tool_call", toolCallId: id, toolKind: "read", toolPath: path, raw: {} });
  read("src/m.ts", "1");
  read("src/z.ts", "2");
  await settle(150);

  stdin.write("\t");
  await settle(120);
  stdin.write("j");
  await settle(150);
  assert.match(lastFrame() ?? "", /►.*z\.ts/, `cursor not on z.ts:\n${lastFrame()}`);

  // The agent reads a file that sorts first. An index-based cursor would
  // now be pointing at m.ts — the selection would have slid onto a
  // different file under the reader's hands, mid-turn, without a keypress.
  read("src/a.ts", "3");
  await settle(150);
  const frame = lastFrame() ?? "";
  assert.match(frame, /►.*z\.ts/, `cursor slid to another file:\n${frame}`);
  assert.doesNotMatch(frame, /►.*(a\.ts|m\.ts)/, frame);
});

test("tab is inert while the map is empty, so the prompt keeps the keyboard", async (t) => {
  const repo = await newRepo(t);
  const worktree = { path: repo, repo, diff: async () => "" } as unknown as Worktree;
  const { stdin, lastFrame, unmount } = renderApp(worktree, new EventEmitter());
  t.after(() => unmount());
  await settle(80);

  stdin.write("\t");
  await settle(80);
  // Focus into a pane with no rows would leave every key inert: no cursor
  // to move, nothing to open, and a prompt that has stopped accepting text.
  stdin.write("hello");
  await settle(120);
  const frame = lastFrame() ?? "";
  assert.match(frame, /> hello/, `the prompt stopped taking input:\n${frame}`);
  assert.match(frame, /\[tab\] repo map/, frame);
});

test("git blame failing leaves the file readable rather than blanking the view", async (t) => {
  // provenance is an enrichment; a repo state it cannot describe must not
  // cost the reader the file itself.
  const repo = await newRepo(t);
  await write(repo, "b.txt", "line\n");
  await git(repo, "add", "-A");
  const worktree = { path: repo, repo, diff: async () => "" } as unknown as Worktree;
  const bridge = new EventEmitter();
  const { stdin, lastFrame, unmount } = renderApp(worktree, bridge);
  t.after(() => unmount());
  await settle(80);

  // b.txt is staged but never committed, so `git blame HEAD -- b.txt` fails.
  bridge.emit("update", { kind: "tool_call", toolCallId: "1", toolKind: "read", toolPath: "b.txt", raw: {} });
  await settle(150);
  stdin.write("\t");
  await settle(100);
  stdin.write("\r");
  await settle(400);
  assert.match(lastFrame() ?? "", /line/, `file content lost:\n${lastFrame()}`);
});

test("exactly one pane says it has the keyboard, and tab moves which one", async (t) => {
  const repo = await newRepo(t);
  const worktree = { path: repo, repo, diff: async () => "" } as unknown as Worktree;
  const bridge = new EventEmitter();
  const { stdin, lastFrame, unmount } = renderApp(worktree, bridge);
  t.after(() => unmount());
  await settle(80);
  bridge.emit("update", { kind: "tool_call", toolCallId: "1", toolKind: "read", toolPath: "a.ts", raw: {} });
  await settle(150);

  // Two panes both claiming focus, or neither claiming it, is worse than no
  // marker at all: the reader would have to press a key to find out.
  const marked = (frame: string): string[] =>
    (frame.match(/\b(REPO|AGENT) ▸/g) ?? []).map((m) => m.split(" ")[0]!);

  assert.deepEqual(marked(lastFrame() ?? ""), ["AGENT"], lastFrame() ?? "");
  stdin.write("\t");
  await settle(120);
  assert.deepEqual(marked(lastFrame() ?? ""), ["REPO"], lastFrame() ?? "");
  stdin.write("\t");
  await settle(120);
  assert.deepEqual(marked(lastFrame() ?? ""), ["AGENT"], lastFrame() ?? "");
});

test("the prompt and the key hints sit inside the frame, not under it", async (t) => {
  const repo = await newRepo(t);
  const worktree = { path: repo, repo, diff: async () => "" } as unknown as Worktree;
  const { stdin, lastFrame, unmount } = renderApp(worktree, new EventEmitter());
  t.after(() => unmount());
  await settle(80);
  stdin.write("hello");
  await settle(120);

  const rows = (lastFrame() ?? "").split("\n");
  // The line you type into is part of the cockpit. Rendered below the closing
  // border it reads as shell output that happens to be underneath.
  assert.match(rows[rows.length - 1]!, /^╰─+╯$/, `frame does not end at its own border:\n${lastFrame()}`);
  const prompt = rows.find((r) => r.includes("> hello"));
  assert.ok(prompt, `prompt missing:\n${lastFrame()}`);
  assert.match(prompt, /^│.*│$/, `prompt is outside the border:\n${prompt}`);
  const hint = rows.find((r) => r.includes("[tab] repo map"))!;
  assert.match(hint, /^│.*│$/, `key hints are outside the border:\n${hint}`);
});

test("the plan renders in the sidebar column, not across the whole width", async (t) => {
  const repo = await newRepo(t);
  const worktree = { path: repo, repo, diff: async () => "" } as unknown as Worktree;
  const bridge = new EventEmitter();
  const { lastFrame, unmount } = renderApp(worktree, bridge);
  t.after(() => unmount());
  await settle(80);
  bridge.emit("update", {
    kind: "plan",
    raw: { entries: [{ content: "fix the off-by-one", status: "in_progress" }] },
  });
  await settle(150);

  const row = (lastFrame() ?? "").split("\n").find((r) => r.includes("fix the off-by-one"))!;
  assert.ok(row, `plan not rendered:\n${lastFrame()}`);
  // The sidebar is 30 wide including its border, so a plan row that belongs
  // to it closes before column 32. Full-width means it fell back to the
  // bottom stack, under the token gauge, where it used to be buried.
  assert.ok(row.indexOf("fix the off-by-one") < 30, `plan is not in the sidebar:\n${row}`);
});

test("a plan step too long for its pane wraps under its own text", () => {
  const { lastFrame } = render(
    <Box width={20}>
      <PlanBar entries={[{ content: "add a regression test for the expiry boundary", status: "pending" }]} />
    </Box>,
  );
  const rows = (lastFrame() ?? "").split("\n");
  const first = rows.findIndex((r) => r.includes("add a"));
  const cont = rows[first + 1]!;
  // Wrapped back to column zero, a continuation reads as another step.
  assert.equal(cont.indexOf(cont.trim()), rows[first]!.indexOf("add a"), `continuation lost its indent:\n${lastFrame()}`);
});

test("walking the map cursor moves CHECKS onto the file under it", async (t) => {
  const repo = await newRepo(t);
  await write(
    repo,
    ".ctui-check.sh",
    ["#!/bin/sh", 'echo "aa.ts(1,1): error TS1: boom aa"', 'echo "zz.ts(2,1): error TS2: boom zz two"', 'echo "zz.ts(3,1): error TS3: boom zz three"', "exit 1", ""].join("\n"),
  );
  await chmod(join(repo, ".ctui-check.sh"), 0o755);
  await write(repo, "package.json", JSON.stringify({ scripts: { typecheck: "./.ctui-check.sh" } }));
  const worktree = { path: repo, repo, diff: async () => "" } as unknown as Worktree;
  const { stdin, lastFrame, unmount } = renderApp(worktree, new EventEmitter());
  t.after(() => unmount());
  await settle(80);

  // Checks run when a turn ends, so a turn has to end.
  stdin.write("go");
  await settle(80);
  stdin.write("\r");
  await settle(600);
  assert.match(lastFrame() ?? "", /aa\.ts:1 {2}error TS1/, `checks never ran:\n${lastFrame()}`);

  // Focus alone scopes to the first row; the cursor is what steers it after
  // that, and a pane wired to a constant would pass the first assertion.
  stdin.write("\t");
  await settle(150);
  assert.match(lastFrame() ?? "", /CHECKS {2}aa\.ts {2}✖ 1/, `checks did not follow focus:\n${lastFrame()}`);
  stdin.write("j");
  await settle(150);
  const frame = lastFrame() ?? "";
  assert.match(frame, /CHECKS {2}zz\.ts {2}✖ 2/, `checks did not follow the cursor:\n${frame}`);
  assert.match(frame, /line 3 {2}error TS3/, frame);
  assert.doesNotMatch(frame, /boom aa/, `other files' failures still listed:\n${frame}`);

  // Handing the keyboard back to the prompt hands the pane back to the whole
  // project. Left scoped, it would hide every other file's failures behind a
  // cursor the reader is no longer looking at.
  stdin.write("\t");
  await settle(150);
  const back = lastFrame() ?? "";
  assert.match(back, /boom aa/, `checks stayed scoped after focus left the map:\n${back}`);
  assert.doesNotMatch(back, /CHECKS {2}zz\.ts/, back);
});
