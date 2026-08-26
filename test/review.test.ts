import test from "node:test";
import assert from "node:assert/strict";
import { splitDiff } from "../src/diff.js";
import { START, actionFor, move, view, type Review } from "../src/review.js";

const raw = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,3 @@ func Get(id string) error
 one
+two
 three
@@ -10 +11,2 @@ func retryAfter() int
 ten
+eleven
diff --git a/b.txt b/b.txt
new file mode 100644
--- /dev/null
+++ b/b.txt
@@ -0,0 +1 @@
+brand new
`;

const files = splitDiff(raw);

function r(over: Partial<Review> = {}): Review {
  return { pos: START, files, rows: 40, newest: "b.txt", scope: "head", ...over };
}

// The whole point of the pane: not the newest hunk's tail, all of it.
test("review shows every hunk of the file, not just the last one", () => {
  const v = view(r({ pos: { path: "a.txt", top: 0, pinned: true } }));
  assert.equal(v.hunks, 2, "second hunk missing from the rendered file");
  const text = v.lines.map((l) => l.text).join("\n");
  assert.match(text, /two/);
  assert.match(text, /eleven/);
  // New-side numbering, and a removed line carries the line it replaced.
  assert.deepEqual(
    v.lines.filter((l) => l.sign === "+").map((l) => l.num),
    ["2", "12"],
  );
});

// A reader who picked a file is looking at it on purpose; a reader who has
// not is watching the agent work. Both states have to be visible.
test("the title says the scope, the mode, and where in the change you are", () => {
  const following = view(r());
  assert.match(following.title, /HEAD/);
  assert.match(following.title, /FOLLOW/);
  assert.match(following.title, /b\.txt/);
  assert.match(following.title, /2\/2 files/);

  const pinned = view(r({ pos: { path: "a.txt", top: 0, pinned: true } }));
  assert.match(pinned.title, /PINNED/);
  assert.match(pinned.title, /1\/2 files/);
  assert.match(pinned.title, /1\/2 hunks/);
});

test("moving to the next hunk moves the hunk count with it", () => {
  const start: Review = r({ pos: { path: "a.txt", top: 0, pinned: true }, rows: 4 });
  const next = move(start, "next-hunk");
  const v = view({ ...start, pos: next });
  assert.equal(v.hunk, 2, "] did not reach the second hunk");
  assert.equal(v.lines[v.top]!.sign, "@", "] landed somewhere other than a hunk heading");
  // And back, without running off the top of the file.
  const back = move({ ...start, pos: next }, "prev-hunk");
  assert.equal(view({ ...start, pos: back }).hunk, 1);
  assert.equal(move({ ...start, pos: back }, "prev-hunk").top, 0);
});

test("n and p walk the changed files and pin what they land on", () => {
  // Following puts the pane on b.txt, the newest write and the last file.
  const start = r();
  const back = move(start, "prev-file");
  assert.equal(back.pinned, true, "walking the files did not take the pane off follow");
  assert.equal(view({ ...start, pos: back }).file?.path, "a.txt");
  // Past either end the cursor stays put rather than wrapping, which reads
  // as "there is more below" when there is not.
  assert.equal(view({ ...start, pos: move({ ...start, pos: back }, "prev-file") }).file?.path, "a.txt");
  const fwd = move({ ...start, pos: back }, "next-file");
  assert.equal(view({ ...start, pos: fwd }).file?.path, "b.txt");
  assert.equal(view({ ...start, pos: move({ ...start, pos: fwd }, "next-file") }).file?.path, "b.txt");
});

test("f gives the pane back to the agent's newest write", () => {
  const start = r({ pos: { path: "a.txt", top: 3, pinned: true } });
  const followed = move(start, "follow");
  const v = view({ ...start, pos: followed });
  assert.equal(v.file?.path, "b.txt");
  assert.match(v.title, /FOLLOW/);
});

// Following means the newest edit is on screen, which for a hunk longer than
// the pane is its tail — the same thing the pane showed before it could scroll.
test("following a long change lands on its newest lines", () => {
  const long = splitDiff(
    `diff --git a/c.txt b/c.txt
--- a/c.txt
+++ b/c.txt
@@ -1,3 +1,8 @@
 one
+a
+b
+c
+d
+e
 two
 three
`,
  );
  const v = view({ pos: START, files: long, rows: 3, newest: "c.txt", scope: "head" });
  assert.equal(v.lines.slice(v.top, v.top + 3).at(-1)?.text, "three");
});

// The pinned file is remembered by path, because the list it indexes into is
// rewritten by every write the agent makes.
test("a pinned file that disappears hands the pane back to follow", () => {
  const gone = r({ pos: { path: "vanished.txt", top: 9, pinned: true } });
  const v = view(gone);
  assert.equal(v.file?.path, "b.txt");
  assert.match(v.title, /FOLLOW/);
});

test("a clean tree says so instead of drawing an empty diff", () => {
  const v = view({ pos: START, files: [], rows: 10, newest: "", scope: "turn" });
  assert.equal(v.file, undefined);
  assert.equal(v.lines.length, 0);
  assert.match(v.title, /TURN/);
  assert.match(v.title, /clean/);
});

test("a binary file says what it is rather than rendering nothing", () => {
  const bin = splitDiff(`diff --git a/i.png b/i.png
Binary files a/i.png and b/i.png differ
`);
  const v = view({ pos: START, files: bin, rows: 10, newest: "i.png", scope: "head" });
  assert.equal(v.lines.length, 1);
  assert.match(v.lines[0]!.text, /binary/);
  assert.equal(v.hunks, 0);
});

test("scrolling stops at both ends of the file", () => {
  const start = r({ pos: { path: "a.txt", top: 0, pinned: true }, rows: 3 });
  assert.equal(move(start, "up").top, 0);
  const bottom = move(start, "bottom");
  const lines = view(start).lines.length;
  assert.equal(bottom.top, lines - 3);
  assert.equal(move({ ...start, pos: bottom }, "down").top, lines - 3);
  assert.equal(move({ ...start, pos: bottom }, "top").top, 0);
});

// The pane binds keys through this map, so a binding that silently does
// nothing fails here rather than under someone's fingers.
test("every key the pane advertises is bound", () => {
  assert.equal(actionFor("n"), "next-file");
  assert.equal(actionFor("p"), "prev-file");
  assert.equal(actionFor("]"), "next-hunk");
  assert.equal(actionFor("["), "prev-hunk");
  assert.equal(actionFor("j"), "down");
  assert.equal(actionFor("k"), "up");
  assert.equal(actionFor("g"), "top");
  assert.equal(actionFor("G"), "bottom");
  assert.equal(actionFor("f"), "follow");
  assert.equal(actionFor("", { downArrow: true }), "down");
  assert.equal(actionFor("", { upArrow: true }), "up");
  assert.equal(actionFor("", { pageDown: true }), "page-down");
  assert.equal(actionFor("", { pageUp: true }), "page-up");
  // Anything else belongs to whoever else is listening.
  assert.equal(actionFor("z"), undefined);
});
