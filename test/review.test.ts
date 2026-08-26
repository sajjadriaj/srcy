import test from "node:test";
import assert from "node:assert/strict";
import { splitDiff } from "../src/diff.js";
import { PAST_MAX, pushPast, rowFor, type Past } from "../src/panels.js";
import { START, actionFor, byRisk, fileLines, move, scopeFor, spans, view, type Review } from "../src/review.js";

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

// The scope label has to mean what it says. A TURN with no baseline shows
// nothing and explains itself; it never quietly renders HEAD's diff under
// TURN's title, which is the one failure that makes the label worse than
// having no scopes at all.
test("a scope with no baseline says why rather than showing another one's diff", () => {
  const v = view(r({ scope: "turn", note: "the agent was already writing — press c to start one" }));
  assert.equal(v.lines.length, 0);
  assert.equal(v.file, undefined);
  assert.match(v.title, /TURN/);
  assert.match(v.title, /already writing/);
});

test("1, 2 and 3 pick the three scopes and nothing else does", () => {
  assert.equal(scopeFor("1"), "turn");
  assert.equal(scopeFor("2"), "session");
  assert.equal(scopeFor("3"), "head");
  assert.equal(scopeFor("4"), undefined);
  assert.equal(scopeFor("f"), undefined);
});

// Side by side. The pairing is the whole feature; everything else about the
// pane is meant to carry over unchanged, which is what these check.
const rewrite = splitDiff(`diff --git a/t.ts b/t.ts
--- a/t.ts
+++ b/t.ts
@@ -3,5 +3,6 @@ func verify()
   const exp = decode(t).exp
-  if (exp < now())
-    return null
+  if (exp <= now())
+    return null
+  audit(t)
   return session
`);

test("split pairs the change and numbers each column by its own file", () => {
  const v = view({ pos: { path: "t.ts", top: 0, pinned: true }, files: rewrite, rows: 40, newest: "t.ts", scope: "head", split: true });
  const rows = v.lines.filter((l) => l.sign !== "@");

  // The left column is the old file and the right is the new one — the whole
  // reason there are two. Unified numbers both by the new file, which is
  // right for one column and wrong for two.
  assert.deepEqual(rows.map((l) => l.num), ["3", "4", "5", "", "6"]);
  assert.deepEqual(rows.map((l) => l.right?.num), ["3", "4", "5", "6", "7"]);

  // One replaced line sits opposite the line that replaced it, on one row.
  const changed = rows.find((l) => l.sign === "-")!;
  assert.equal(changed.text.trim(), "if (exp < now())");
  assert.equal(changed.right?.text.trim(), "if (exp <= now())");

  // The addition with nothing to replace gets a blank, not a borrowed line:
  // sliding the rest of the column up by one would misalign every row after
  // it, which is the one thing this view cannot survive.
  const odd = rows.find((l) => l.right?.text.trim() === "audit(t)")!;
  assert.equal(odd.num, "");
  assert.equal(odd.text, "");
});

test("split is a view, so the pane still moves the way it did", () => {
  const pinned = { path: "t.ts", top: 0, pinned: true };
  const base = { files: rewrite, rows: 3, newest: "t.ts", scope: "head" as const };
  // A heading is still a heading, so hunk counting and jumps read it the
  // same way — the row list is the same type either way, only shorter.
  assert.equal(view({ ...base, pos: pinned, split: true }).hunks, 1);
  assert.equal(move({ ...base, pos: pinned, split: true }, "down").top, 1);
  // Fewer rows, because two lines of a rewrite are now one row.
  const unified = view({ ...base, pos: pinned }).lines.length;
  const side = view({ ...base, pos: pinned, split: true }).lines.length;
  assert.ok(side < unified, `${side} !< ${unified}`);
});

test("a failing line lands on the row that shows it", () => {
  const lines = fileLines(rewrite[0]!);
  // The line the gate named, exactly.
  assert.equal(Number(lines[rowFor(lines, 6)]!.num), 6);
  // A line the diff does not include lands on the nearest row above it, not
  // at the top of the file: the hunk before a failure is context for it.
  const above = rowFor(lines, 99);
  assert.ok(above > 0, `${above} — a line past the diff should not reset to the top`);
  assert.equal(rowFor(lines, 1), 0);
  assert.equal(rowFor([], 4), 0);

  // Split rows carry the new file on the right, which is the side a gate's
  // line numbers are in.
  const side = fileLines(rewrite[0]!, true);
  assert.equal(Number(side[rowFor(side, 6)]!.right?.num), 6);
});

test("the part that actually changed is the part that gets marked", () => {
  // One character inside eighty is the case this exists for.
  const one = spans("  if (exp < now())", "  if (exp <= now())")!;
  assert.equal("  if (exp <= now())".slice(one.b.from, one.b.to), "=");
  // Nothing was removed to make room for it, so the removal's span is empty
  // — which is what an insertion looks like from the other side.
  assert.equal(one.a.from, one.a.to);

  // A line rewritten outright shares neither end. Marking all of it says
  // nothing the `-` and `+` do not already say.
  assert.equal(spans("aaa", "bbb"), undefined);
  assert.equal(spans("same", "same"), undefined);

  // Prefix and suffix never claim the same characters twice.
  const grow = spans("ab", "aXb")!;
  assert.equal("aXb".slice(grow.b.from, grow.b.to), "X");
  assert.equal(grow.a.from, grow.a.to);

  const both = splitDiff(`diff --git a/t.ts b/t.ts
--- a/t.ts
+++ b/t.ts
@@ -1,2 +1,2 @@ f()
-  if (exp < now())
+  if (exp <= now())
`)[0]!;
  // Unified and split reach the same answer: it is the same pairing.
  for (const split of [false, true]) {
    const rows = fileLines(both, split);
    const add = split ? rows.find((l) => l.right?.sign === "+")!.right! : rows.find((l) => l.sign === "+")!;
    assert.equal(add.text.slice(add.mark!.from, add.mark!.to), "=");
  }
});

test("the review pane reads worst first, not alphabetically", () => {
  const raw = splitDiff(`diff --git a/a-clean.ts b/a-clean.ts
--- a/a-clean.ts
+++ b/a-clean.ts
@@ -1,2 +1,3 @@ f()
 one
+two
 three
diff --git a/b-broken.ts b/b-broken.ts
--- a/b-broken.ts
+++ b/b-broken.ts
@@ -1 +1,2 @@ g()
 x
+y
diff --git a/c-gone.ts b/c-gone.ts
deleted file mode 100644
--- a/c-gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@ h()
-one
-two
diff --git a/d-new.ts b/d-new.ts
new file mode 100644
--- /dev/null
+++ b/d-new.ts
@@ -0,0 +1 @@ i()
+fresh
`);
  // git hands them over alphabetically, which has nothing to do with what
  // deserves a reader first.
  assert.deepEqual(raw.map((f) => f.path), ["a-clean.ts", "b-broken.ts", "c-gone.ts", "d-new.ts"]);

  const order = byRisk(raw, [{ path: "b-broken.ts", line: 1, message: "boom" }]).map((f) => f.path);
  // A failing gate is a fact, not a guess about risk. A deletion is the
  // hardest change to notice by reading what is left. A new file has no
  // previous version and so has never been read by anyone.
  assert.deepEqual(order, ["b-broken.ts", "c-gone.ts", "d-new.ts", "a-clean.ts"]);

  // Nothing broken: the same order minus the promotion.
  assert.deepEqual(byRisk(raw, []).map((f) => f.path), ["c-gone.ts", "d-new.ts", "a-clean.ts", "b-broken.ts"]);
  // Stable, and never mutating the list it was handed.
  assert.deepEqual(raw.map((f) => f.path), ["a-clean.ts", "b-broken.ts", "c-gone.ts", "d-new.ts"]);
});

test("the turn history keeps the last few, newest first, once each", () => {
  let list: Past[] = [];
  for (let i = 1; i <= 3; i++) list = pushPast(list, { at: i, text: `turn ${i}`, tree: `t${i}` });
  // Newest first: `,` steps backwards through time from where you are.
  assert.deepEqual(list.map((p) => p.text), ["turn 3", "turn 2", "turn 1"]);

  // The same turn seen again is not a second entry — the rail re-reads the
  // transcript every second and the newest request is the same request.
  list = pushPast(list, { at: 3, text: "turn 3", tree: "t3-again" });
  assert.equal(list.length, 3);
  assert.equal(list[0]?.tree, "t3-again");

  for (let i = 4; i <= 20; i++) list = pushPast(list, { at: i, text: `turn ${i}`, tree: `t${i}` });
  assert.equal(list.length, PAST_MAX);
  assert.equal(list[0]?.text, "turn 20");
  assert.equal(list[PAST_MAX - 1]?.text, `turn ${20 - PAST_MAX + 1}`);
});

test("the review title says which turn back it is looking at", () => {
  const files = splitDiff(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1,2 @@ f()
 one
+two
`);
  const base = { pos: { path: "a.txt", top: 0, pinned: true }, files, rows: 40, newest: "a.txt", scope: "turn" as const };
  assert.match(view(base).title, /REVIEW  TURN  /);
  // The scope word carries it, because the pane has one line to say where it
  // is and the diff below cannot say it at all.
  assert.match(view({ ...base, era: "-2" }).title, /REVIEW  TURN-2  /);
  // A turn srcy no longer holds says so rather than showing another scope.
  const gone = view({ ...base, era: "-9", note: "nothing kept from 9 turns back — srcy holds the last 8" });
  assert.match(gone.title, /TURN-9  nothing kept from 9 turns back/);
  assert.equal(gone.file, undefined);
});
