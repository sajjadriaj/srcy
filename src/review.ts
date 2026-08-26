import { TOP_LEVEL, hunkLines } from "./cockpit.js";
import type { FileDiff } from "./diff.js";
import type { Problem } from "./checks.js";

// The dock, as a reviewer rather than a preview.
//
// It used to draw the tail of the newest hunk of the newest file, which
// answers "what is the agent typing" and nothing else. Everything below is
// the rest of the question: the whole change, every hunk, navigable, with
// the pane saying which part of it you are looking at and whether it is
// still following the agent or holding still because you asked it to.
//
// Pure on purpose — no ink, no git, no timers. What the dock owns is
// keystrokes and rows; what this owns is where those land.

// Which change is under review. The agent's turn, the session, or every
// uncommitted line — three different questions, and answering one while
// labelled as another is the failure this whole module exists to avoid.
export type Scope = "turn" | "session" | "head";

// One rendered row. `sign` is a diff prefix — ' ', '+', '-' — or '@' for a
// hunk heading, which is not a line of the file and so carries no number.
export interface Span {
  from: number;
  to: number;
}

export interface Side {
  num: string;
  sign: string;
  text: string;
  // The part of `text` that actually differs from the line it replaced, when
  // there is a line it replaced and the two have something in common. An
  // off-by-one fix is one character inside eighty, and finding it by eye is
  // the work the pane exists to save.
  mark?: Span;
}

// The span that differs between two lines, as a common prefix and a common
// suffix. Undefined when they share neither end: a line rewritten outright
// is all changed, and marking all of it says nothing that the `-` and `+`
// do not already say.
//
// The two spans are separate because they are in different strings — the
// same edit is one character wide on one side and none on the other, which
// is exactly what a one-character insertion looks like.
export function spans(a: string, b: string): { a: Span; b: Span } | undefined {
  if (a === b) return undefined;
  const max = Math.min(a.length, b.length);
  let head = 0;
  while (head < max && a[head] === b[head]) head++;
  // Bounded by what the prefix left, so the two never overlap and claim the
  // same characters twice.
  let tail = 0;
  while (tail < max - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  if (head === 0 && tail === 0) return undefined;
  return { a: { from: head, to: a.length - tail }, b: { from: head, to: b.length - tail } };
}

// Marks every run of removals against the run of additions that replaced it,
// pairing by position the way the split view does. Mutates: the rows were
// built a line ago and belong to nobody else yet.
function markRuns(lines: ReviewLine[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.sign !== "-") {
      i++;
      continue;
    }
    let cut = i;
    while (cut < lines.length && lines[cut]!.sign === "-") cut++;
    let add = cut;
    while (add < lines.length && lines[add]!.sign === "+") add++;
    for (let k = 0; k < Math.min(cut - i, add - cut); k++) {
      const sp = spans(lines[i + k]!.text, lines[cut + k]!.text);
      if (sp === undefined) continue;
      lines[i + k]!.mark = sp.a;
      lines[cut + k]!.mark = sp.b;
    }
    i = add > cut ? add : cut;
  }
}

// One row of the pane. `right` is the new side of a side-by-side row: absent
// in the unified view, and absent on a hunk heading, which spans both columns
// because it describes them both. Split rows keep the same list type as
// unified ones, which is what lets scrolling, hunk jumps and the title work
// on either view without knowing which is on screen — they count rows and
// look for `@`.
export interface ReviewLine extends Side {
  right?: Side;
}

// Where the reader is. The file is held by path, not by index: the list is
// rewritten every time the agent writes anything, and an index quietly means
// a different file each time it shifts.
export interface Position {
  path: string;
  top: number;
  pinned: boolean;
}

export const START: Position = { path: "", top: 0, pinned: false };

export interface Review {
  pos: Position;
  files: FileDiff[];
  // How many rows the pane has for diff content.
  rows: number;
  // The file the agent wrote last, which is what FOLLOW follows.
  newest: string;
  scope: Scope;
  // Why this scope has nothing to show. A scope whose baseline could not be
  // taken says so; it never silently falls back to another one, because a
  // diff labelled TURN that is really every uncommitted line is worth less
  // than an empty pane that admits it.
  note?: string;
  // Side-by-side rather than unified. A view, not a different diff: the same
  // hunks, paired up.
  split?: boolean;
  // How far back through the turns this is, as the title should say it:
  // "-2" on TURN. Empty for the turn you are in.
  era?: string;
}

export type Action =
  | "next-file"
  | "prev-file"
  | "next-hunk"
  | "prev-hunk"
  | "down"
  | "up"
  | "page-down"
  | "page-up"
  | "top"
  | "bottom"
  | "follow";

// Every row of one file's diff, hunk headings included. Headings are part of
// the same list rather than drawn separately so that scrolling, hunk jumps
// and the hunk counter all measure the same thing.
const BLANK: Side = { num: "", sign: " ", text: "" };

// splitHunk pairs a hunk's removals with its additions, one row each.
//
// A unified hunk is a run of `-` followed by a run of `+`, separated by
// context. Pairing by position within the run is what makes the columns line
// up on the edit — the common case is one line replaced by one line, and an
// uneven run leaves blanks on the short side rather than sliding the rest of
// the file out of step.
//
// Numbering is per side: the left column is the old file and the right is the
// new one, which is the whole reason there are two. The unified view numbers
// everything by the new file, so a deleted line there carries the number of
// whatever replaced it — right for one column, wrong for two.
function splitHunk(body: string, oldStart: number, newStart: number): ReviewLine[] {
  const out: ReviewLine[] = [];
  let o = oldStart;
  let n = newStart;
  let dels: Side[] = [];
  let adds: Side[] = [];
  const flush = (): void => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const del = dels[i];
      const add = adds[i];
      const sp = del === undefined || add === undefined ? undefined : spans(del.text, add.text);
      if (sp !== undefined) {
        del!.mark = sp.a;
        add!.mark = sp.b;
      }
      out.push({ ...(del ?? BLANK), right: add ?? BLANK });
    }
    dels = [];
    adds = [];
  };
  for (const line of body.split("\n")) {
    if (line === "") continue;
    const sign = line[0]!;
    const text = line.slice(1);
    // "\ No newline at end of file" describes the line above rather than
    // being one. The unified view has a spare column for it; a split row
    // would have to pick a side, and either choice is a line the file does
    // not contain.
    if (sign === "\\") continue;
    if (sign === "+") {
      adds.push({ num: String(n++), sign: "+", text });
      continue;
    }
    // A `-` after a `+` starts a second change block rather than continuing
    // the first.
    if (sign === "-") {
      if (adds.length > 0) flush();
      dels.push({ num: String(o++), sign: "-", text });
      continue;
    }
    flush();
    out.push({ num: String(o++), sign: " ", text, right: { num: String(n++), sign: " ", text } });
  }
  flush();
  return out;
}

export function fileLines(f: FileDiff, split = false): ReviewLine[] {
  if (f.binary) return [{ num: "", sign: " ", text: `${f.path} — binary` }];
  const out: ReviewLine[] = [];
  for (const h of f.hunks) {
    out.push({ num: "", sign: "@", text: `${h.newStart}  ${h.func === "" ? TOP_LEVEL : h.func}` });
    if (split) {
      out.push(...splitHunk(h.body, h.oldStart, h.newStart));
      continue;
    }
    const body = hunkLines(h.body, h.newStart) as ReviewLine[];
    markRuns(body);
    out.push(...body);
  }
  // A rename or a mode change has no hunks at all. Saying so beats an empty
  // pane, which reads as "nothing happened" about a file that moved.
  if (out.length === 0) out.push({ num: "", sign: " ", text: `${f.path} — metadata only` });
  return out;
}

// The order to read a turn's files in.
//
// git's order is the order git found them, which is alphabetical and has
// nothing to do with what deserves a reader first. After a forty-call turn
// that is the difference between reviewing and skimming.
//
// A failing gate leads because it is a fact rather than a guess about risk.
// Deletions come next: a file that is gone is the hardest change to notice by
// reading what is left. Then new files, which have no previous version and so
// have never been read by anyone. Then churn, then the path, so the order is
// stable when nothing separates two files.
export function byRisk(files: FileDiff[], problems: Problem[]): FileDiff[] {
  const broken = new Set(problems.map((p) => p.path));
  const rank = (f: FileDiff): number => {
    if (broken.has(f.path)) return 0;
    if (f.header.includes("deleted file mode ")) return 1;
    if (f.header.includes("new file mode ")) return 2;
    return 3;
  };
  const churn = (f: FileDiff): number => f.hunks.reduce((n, h) => n + h.body.split("\n").length, 0);
  return [...files].sort((a, b) => rank(a) - rank(b) || churn(b) - churn(a) || a.path.localeCompare(b.path));
}

export interface View {
  file?: FileDiff;
  index: number; // 0-based position of `file` in the scoped file list
  files: number;
  lines: ReviewLine[];
  top: number;
  hunk: number; // 1-based, of `hunks`; 0 when the file has none
  hunks: number;
  pinned: boolean;
  title: string;
}

// Which file is on screen, and whether the pane is following or held.
//
// A pinned path that is no longer in the list — the agent reverted the file,
// or the scope changed under it — falls back to following rather than to an
// empty pane. There is no way to show a diff that does not exist, and a
// reviewer left staring at nothing while the agent works is the worse of the
// two failures.
function locate(r: Review): { index: number; pinned: boolean } {
  if (r.pos.pinned) {
    const found = r.files.findIndex((f) => f.path === r.pos.path);
    if (found >= 0) return { index: found, pinned: true };
  }
  const newest = r.files.findIndex((f) => f.path === r.newest);
  return { index: newest >= 0 ? newest : 0, pinned: false };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(n, hi));
}

export function view(r: Review): View {
  const scope = r.scope.toUpperCase() + (r.era === undefined || r.era === "" ? "" : r.era);
  if (r.note !== undefined || r.files.length === 0) {
    return {
      index: 0,
      files: 0,
      lines: [],
      top: 0,
      hunk: 0,
      hunks: 0,
      pinned: false,
      title: `REVIEW  ${scope}  ${r.note ?? "clean — nothing to review"}`,
    };
  }
  const { index, pinned } = locate(r);
  const file = r.files[index]!;
  const lines = fileLines(file, r.split === true);
  const rows = Math.max(1, r.rows);
  const maxTop = Math.max(0, lines.length - rows);
  // Following means the newest edit is on screen. For a change longer than
  // the pane that is its tail — the same view the pane gave before it could
  // scroll, and the one the agent's last keystroke is in.
  //
  // A held position is clamped to a line rather than to `maxTop`, because a
  // hunk jump is allowed to put a heading at the top of a short tail: the
  // alternative is pressing `]` on the last hunk and having nothing move.
  const top = pinned ? clamp(r.pos.top, 0, Math.max(0, lines.length - 1)) : maxTop;
  const heads = lines.reduce<number[]>((acc, l, i) => (l.sign === "@" ? [...acc, i] : acc), []);
  const hunk = heads.length === 0 ? 0 : Math.max(1, heads.filter((i) => i <= top).length);
  const where = heads.length === 0 ? "" : `  ${hunk}/${heads.length} hunks`;
  return {
    file,
    index,
    files: r.files.length,
    lines,
    top,
    hunk,
    hunks: heads.length,
    pinned,
    title: `REVIEW  ${scope}  ${pinned ? "PINNED" : "FOLLOW"}  ${index + 1}/${r.files.length} files${where}  ${file.path}`,
  };
}

// Every action except `follow` pins. A reader who scrolled is reading: having
// the agent's next write yank the pane to another file mid-sentence is the
// behaviour that makes a live pane useless for review.
export function move(r: Review, action: Action): Position {
  const v = view(r);
  if (action === "follow" || v.file === undefined) return START;

  const rows = Math.max(1, r.rows);
  const maxTop = Math.max(0, v.lines.length - rows);
  const held = (path: string, top: number): Position => ({ path, top: clamp(top, 0, maxTop), pinned: true });
  // Scrolling stops where the last line reaches the bottom of the pane; a
  // hunk jump is allowed past that, so that the hunk you asked for is the
  // row you are looking at rather than one somewhere in the middle.
  const jump = (path: string, top: number): Position => ({ path, top: clamp(top, 0, Math.max(0, v.lines.length - 1)), pinned: true });

  if (action === "next-file" || action === "prev-file") {
    const i = clamp(v.index + (action === "next-file" ? 1 : -1), 0, r.files.length - 1);
    // Deliberately no wrap: arriving back at the first file after the last
    // one reads as "there is more below" when there is not.
    return { path: r.files[i]!.path, top: 0, pinned: true };
  }

  const path = v.file.path;
  const heads = v.lines.reduce<number[]>((acc, l, i) => (l.sign === "@" ? [...acc, i] : acc), []);
  switch (action) {
    case "next-hunk":
      return jump(path, heads.find((i) => i > v.top) ?? v.top);
    case "prev-hunk":
      return jump(path, [...heads].reverse().find((i) => i < v.top) ?? 0);
    case "down":
      return held(path, v.top + 1);
    case "up":
      return held(path, v.top - 1);
    case "page-down":
      return held(path, v.top + rows);
    case "page-up":
      return held(path, v.top - rows);
    case "top":
      return held(path, 0);
    case "bottom":
      return held(path, maxTop);
  }
}

// Which key does what.
//
// Split out of the pane so the bindings are testable without a terminal:
// Ink only reads keys from a real tty, and a keymap that quietly binds `[`
// to nothing looks exactly like a working pane until someone presses it.
//
// The names are a pager's, because that is what the reader already knows:
// j/k and the arrows scroll, g/G are the ends, PageUp/PageDown are pages.
// n/p walk files and ]/[ walk hunks, the way a review tool does.
export interface Chord {
  downArrow?: boolean;
  upArrow?: boolean;
  pageDown?: boolean;
  pageUp?: boolean;
}

export function actionFor(input: string, key: Chord = {}): Action | undefined {
  switch (input) {
    case "n":
      return "next-file";
    case "p":
      return "prev-file";
    case "]":
      return "next-hunk";
    case "[":
      return "prev-hunk";
    case "j":
      return "down";
    case "k":
      return "up";
    case "g":
      return "top";
    case "G":
      return "bottom";
    case "f":
      return "follow";
  }
  if (key.downArrow === true) return "down";
  if (key.upArrow === true) return "up";
  if (key.pageDown === true) return "page-down";
  if (key.pageUp === true) return "page-up";
  return undefined;
}

// The key line under the diff. Not hidden behind a `?`: the pane is one row
// taller for it, and a binding nobody can see is a binding nobody presses.
export const KEYS = " ]/[ hunk · n/p file · j/k scroll · s split · f follow · 1/2/3 scope · ,/. turn";

// The scope keys. Separate from `actionFor` because choosing what to review
// is not moving around inside it: the position survives the change, and a
// scope with no baseline is a state the pane has to say out loud.
export function scopeFor(input: string): Scope | undefined {
  if (input === "1") return "turn";
  if (input === "2") return "session";
  if (input === "3") return "head";
  return undefined;
}
