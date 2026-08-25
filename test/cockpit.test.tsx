import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { ChecksPane, diffStats, hunkLines, LiveDiff, mapEntries, PlanBar, planFrom,  } from "../src/cockpit.js";
import { splitDiff, type FileDiff } from "../src/diff.js";

// A real two-file diff, the shape splitDiff actually produces — writing the
// FileDiff objects by hand would test the components against a shape git
// never emits.
const DIFF = [
  "diff --git a/src/auth/token.ts b/src/auth/token.ts",
  "index 1111111..2222222 100644",
  "--- a/src/auth/token.ts",
  "+++ b/src/auth/token.ts",
  "@@ -39,4 +39,4 @@ export function verify(t: string) {",
  "   const exp = decode(t)",
  "-  if (exp < now)",
  "+  if (exp <= now)",
  "     return null",
  "   return session",
  "diff --git a/README.md b/README.md",
  "index 3333333..4444444 100644",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,2 +1,3 @@",
  " # project",
  "+a new line",
  " ",
  "",
].join("\n");

function files(): FileDiff[] {
  return splitDiff(DIFF);
}

test("diffStats counts changed lines and ignores context", () => {
  const token = files().find((f) => f.path === "src/auth/token.ts")!;
  assert.deepEqual(diffStats(token), { added: 1, removed: 1 });

  const readme = files().find((f) => f.path === "README.md")!;
  assert.deepEqual(diffStats(readme), { added: 1, removed: 0 });
});

test("mapEntries reports a file the agent edited and reverted as merely read", () => {
  // No diff section for it: the worktree is the authority for "wrote", so
  // claiming a change that no longer exists would be a lie the map tells
  // right up until review shows nothing there.
  const entries = mapEntries([], ["src/auth/token.ts"]);
  assert.equal(entries[0]!.touch, "read");
  assert.equal(entries[0]!.added, 0);
});

test("hunkLines shows the new-side number against a removed line too", () => {
  const token = files().find((f) => f.path === "src/auth/token.ts")!;
  const lines = hunkLines(token.hunks[0]!.body, token.hunks[0]!.newStart);
  assert.deepEqual(
    lines.map((l) => [l.num, l.sign]),
    [
      ["39", " "],
      ["40", "-"],
      // The replacement reads as line 40 changing, not as 40 vanishing and
      // 41 appearing: only new-side lines advance the counter.
      ["40", "+"],
      ["41", " "],
      ["42", " "],
    ],
  );
});

test("hunkLines gives the no-newline marker no line number", () => {
  const lines = hunkLines(" a\n\\ No newline at end of file\n", 7);
  assert.deepEqual(lines.map((l) => l.num), ["7", ""]);
});

test("LiveDiff renders the current file's changed lines", () => {
  const token = files().find((f) => f.path === "src/auth/token.ts")!;
  const { lastFrame } = render(<LiveDiff file={token} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /src\/auth\/token\.ts:39/);
  assert.match(frame, /40 - {3}if \(exp < now\)/);
  assert.match(frame, /40 \+ {3}if \(exp <= now\)/);
});

test("LiveDiff keeps the newest lines when a hunk is longer than the pane", () => {
  const body = Array.from({ length: 30 }, (_, i) => `+line ${i + 1}`).join("\n") + "\n";
  const file: FileDiff = {
    path: "big.txt",
    header: "",
    binary: false,
    hunks: [{ header: "@@ -1,0 +1,30 @@", body, func: "", newStart: 1, newCount: 30 }],
  };
  const frame = render(<LiveDiff file={file} maxLines={5} />).lastFrame() ?? "";
  assert.match(frame, /line 30/);
  assert.doesNotMatch(frame, /line 25\b/);
});

test("LiveDiff says something useful with no diff, a binary file, or no hunks", () => {
  assert.match(render(<LiveDiff />).lastFrame() ?? "", /no changes yet/);
  const bin: FileDiff = { path: "logo.png", header: "", binary: true, hunks: [] };
  assert.match(render(<LiveDiff file={bin} />).lastFrame() ?? "", /binary/);
  const renamed: FileDiff = { path: "b.txt", header: "", binary: false, hunks: [] };
  assert.match(render(<LiveDiff file={renamed} />).lastFrame() ?? "", /metadata only/);
});

test("PlanBar marks done, current, and pending steps differently", () => {
  const frame =
    render(
      <PlanBar
        entries={[
          { content: "find expiry check", status: "completed" },
          { content: "fix off-by-one", status: "in_progress" },
          { content: "add test", status: "pending" },
        ]}
      />,
    ).lastFrame() ?? "";
  assert.match(frame, /✔ find expiry check/);
  assert.match(frame, /▸ fix off-by-one/);
  assert.match(frame, /☐ add test/);
});

test("PlanBar renders nothing at all when there is no plan", () => {
  assert.equal(render(<PlanBar entries={[]} />).lastFrame(), "");
});

test("planFrom degrades to no plan instead of throwing on an unexpected payload", () => {
  assert.deepEqual(planFrom({ entries: [{ content: "a", status: "completed" }] }), [
    { content: "a", status: "completed" },
  ]);
  // A missing status is a plan step we can still show, so it defaults
  // rather than being dropped.
  assert.deepEqual(planFrom({ entries: [{ content: "a" }] }), [{ content: "a", status: "pending" }]);
  assert.deepEqual(planFrom({ entries: "nope" }), []);
  assert.deepEqual(planFrom({}), []);
  assert.deepEqual(planFrom(null), []);
  assert.deepEqual(planFrom({ entries: [{ content: 7 }, null, { content: "" }] }), []);
});

test("mapEntries gives a failing file its own row even if untouched", () => {
  // A caller that stopped compiling against a changed signature is exactly
  // the failure worth surfacing, and this session never opened it.
  const entries = mapEntries([], [], [{ path: "src/api/routes.ts", line: 9, message: "error" }]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.path, "src/api/routes.ts");
  assert.equal(entries[0]!.problems, 1);
});

test("ChecksPane never renders 'no check configured' the same as 'passing'", () => {
  const none = render(<ChecksPane result={null} running={false} />).lastFrame() ?? "";
  const passing =
    render(<ChecksPane result={{ command: "npm run typecheck", ok: true, problems: [], tail: "" }} running={false} />)
      .lastFrame() ?? "";
  assert.match(none, /none configured/);
  assert.doesNotMatch(none, /✔/);
  assert.match(passing, /✔ passing/);
});

test("ChecksPane lists failing locations and says how many it left out", () => {
  const problems = Array.from({ length: 7 }, (_, i) => ({
    path: `src/f${i}.ts`,
    line: i + 1,
    message: `error ${i}`,
  }));
  const frame =
    render(
      <ChecksPane result={{ command: "npm run typecheck", ok: false, problems, tail: "" }} running={false} />,
    ).lastFrame() ?? "";
  assert.match(frame, /✖ failing/);
  assert.match(frame, /src\/f0\.ts:1  error 0/);
  assert.match(frame, /…and 3 more/);
});

test("ChecksPane shows the output when a failure names no location", () => {
  // Otherwise a segfault or a missing binary renders as a failing header
  // with nothing under it — indistinguishable from a bug in our parser.
  const frame =
    render(
      <ChecksPane
        result={{ command: "./.srcy/check", ok: false, problems: [], tail: "Segmentation fault" }}
        running={false}
      />,
    ).lastFrame() ?? "";
  assert.match(frame, /Segmentation fault/);
});

test("ChecksPane says it is running rather than showing a stale verdict", () => {
  const frame =
    render(<ChecksPane result={{ command: "x", ok: true, problems: [], tail: "" }} running={true} />).lastFrame() ?? "";
  assert.match(frame, /running/);
  assert.doesNotMatch(frame, /✔ passing/);
});

