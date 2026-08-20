// Hunk is one @@ block. Body is kept byte-identical to what git produced —
// it is handed back to `git apply` unmodified, so anything clever done to it
// here is a corruption waiting to happen.
export interface Hunk {
  header: string; // the @@ line
  body: string; // every line after it, newline-terminated
  func: string; // enclosing function, from git's xfuncname; may be empty
  newStart: number; // first line number on the new side
  newCount: number; // how many new-side lines this hunk covers
}

// FileDiff is one file's section of a unified diff.
export interface FileDiff {
  path: string;
  header: string; // "diff --git ..." through the last line before the first @@
  hunks: Hunk[];
  binary: boolean;
}

// Exported (not just module-internal) because git.test.ts reaches for it
// directly, the same way git_test.go calls the package-private hunkRe in Go.
export const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

// splitDiff carves a unified diff into files and hunks by moving raw text.
//
// Hunk ends are found by consuming exactly the line counts declared in the
// @@ header, never by string-matching for the next boundary. A context line
// that happens to read "diff --git ..." is real and common in documentation
// and test fixtures, and matching on it would silently truncate a hunk.
export function splitDiff(raw: string): FileDiff[] {
  if (raw.trim() === "") return [];
  const lines = raw.split("\n");
  // A trailing newline yields a final empty element; drop it so it does not
  // become a spurious body line.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const files: FileDiff[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("diff --git ")) {
      i++; // preamble or trailing junk
      continue;
    }
    const gitLine = lines[i];
    const header: string[] = [lines[i]];
    let plusLine = "";
    let minusLine = "";
    let renameToLine = "";
    let binary = false;
    i++;
    // Header runs until the first hunk or the next file.
    while (
      i < lines.length &&
      !lines[i].startsWith("@@ ") &&
      !lines[i].startsWith("diff --git ")
    ) {
      if (lines[i].startsWith("Binary files ") || lines[i].startsWith("GIT binary patch")) {
        binary = true;
      }
      if (lines[i].startsWith("+++ ")) {
        plusLine = lines[i];
      } else if (lines[i].startsWith("--- ")) {
        minusLine = lines[i];
      } else if (lines[i].startsWith("rename to ")) {
        renameToLine = lines[i];
      }
      header.push(lines[i]);
      i++;
    }
    const path = filePath(gitLine, renameToLine, plusLine, minusLine);
    const headerText = header.join("\n") + "\n";

    const hunks: Hunk[] = [];
    while (i < lines.length && lines[i].startsWith("@@ ")) {
      const [h, next] = readHunk(lines, i);
      hunks.push(h);
      i = next;
    }
    files.push({ path, header: headerText, hunks, binary });
  }
  return files;
}

// readHunk consumes one hunk starting at lines[start], which must be an @@
// line, and returns it plus the index of the line after it.
function readHunk(lines: string[], start: number): [Hunk, number] {
  const m = hunkRe.exec(lines[start]);
  const header = lines[start] + "\n";
  if (m === null) {
    // ponytail: prefix scan is the known-inferior fallback, used only where
    // the @@ counts are unavailable. Correct input never reaches this path.
    const body: string[] = [];
    let i = start + 1;
    while (
      i < lines.length &&
      !lines[i].startsWith("@@ ") &&
      !lines[i].startsWith("diff --git ")
    ) {
      body.push(lines[i]);
      i++;
    }
    const h: Hunk = {
      header,
      body: body.length > 0 ? body.join("\n") + "\n" : "",
      func: "",
      newStart: 0,
      newCount: 0,
    };
    return [h, i];
  }
  // JS leaves a non-participating optional group as `undefined`, where Go's
  // FindStringSubmatch would give "" — normalize before countOr1 sees it.
  let oldLeft = countOr1(m[2] ?? "");
  const newStart = atoi(m[3]);
  let newLeft = countOr1(m[4] ?? "");
  const newCount = newLeft;
  const func = m[5].trim();

  const body: string[] = [];
  let i = start + 1;
  while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
    const l = lines[i];
    if (l.startsWith("\\")) {
      // "\ No newline at end of file"
      // Belongs to the preceding line; consumes no budget.
    } else if (l.startsWith("-")) {
      oldLeft--;
    } else if (l.startsWith("+")) {
      newLeft--;
    } else {
      // context line, or an empty line meaning empty context
      oldLeft--;
      newLeft--;
    }
    body.push(l);
    i++;
  }
  // A trailing no-newline marker sits outside the line budget.
  if (i < lines.length && lines[i].startsWith("\\")) {
    body.push(lines[i]);
    i++;
  }
  const h: Hunk = {
    header,
    body: body.length > 0 ? body.join("\n") + "\n" : "",
    func,
    newStart,
    newCount,
  };
  return [h, i];
}

// buildPatch reassembles the selected hunks into a patch for `git apply`.
// Files with no selected hunk are omitted entirely; a selected binary file
// keeps its whole section, because there is nothing in it to select.
export function buildPatch(
  files: FileDiff[],
  selected: (fi: number, hi: number) => boolean,
): string {
  let out = "";
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    if (f.binary) {
      if (selected(fi, 0)) out += f.header;
      continue;
    }
    const kept: Hunk[] = [];
    for (let hi = 0; hi < f.hunks.length; hi++) {
      if (selected(fi, hi)) kept.push(f.hunks[hi]);
    }
    if (kept.length === 0) {
      if (f.hunks.length === 0 && selected(fi, 0)) {
        // mode-only, pure rename
        out += f.header;
      }
      continue;
    }
    out += f.header;
    for (const h of kept) {
      out += h.header;
      out += h.body;
    }
  }
  return out;
}

// filePath picks the file's path. It prefers the `+++`/`--- ` content
// lines: each is a single field, so it survives spaces and git's quoting,
// where splitting the `diff --git` line on whitespace does not. Failing
// that (a mode-only change or a pure rename has no content lines at all),
// a rename's `rename to ` line carries the new path exactly and unambiguously.
// Only a mode-only or binary change with no other source falls back to
// parsing the `diff --git` line itself.
function filePath(gitLine: string, renameToLine: string, plusLine: string, minusLine: string): string {
  if (plusLine !== "") {
    const p = pathFromDiffLine(plusLine, "+++ ", "b/");
    if (p !== "") return p;
  }
  if (minusLine !== "") {
    const p = pathFromDiffLine(minusLine, "--- ", "a/");
    if (p !== "") return p;
  }
  if (renameToLine !== "") {
    const prefix = "rename to ";
    const stripped = renameToLine.startsWith(prefix) ? renameToLine.slice(prefix.length) : renameToLine;
    return unquotePath(stripped);
  }
  return pathFromGitLine(gitLine);
}

// pathFromDiffLine extracts the path from a `+++ ` or `--- ` line, stripping
// only that side's own "a/"/"b/" prefix (ownPrefix) — never both, or a real
// directory literally named "b" gets eaten along with the marker (e.g.
// `--- a/b/x.txt` must yield "b/x.txt", not "x.txt"). Returns "" for
// /dev/null (add or delete), letting the caller fall back to the other side.
function pathFromDiffLine(line: string, marker: string, ownPrefix: string): string {
  const p = line.startsWith(marker) ? line.slice(marker.length) : line;
  if (p === "/dev/null") return "";
  const unq = unquotePath(p);
  return unq.startsWith(ownPrefix) ? unq.slice(ownPrefix.length) : unq;
}

// unquotePath undoes what git did to a path before writing it to a
// unified-diff line. Order matters: a trailing TAB (the timestamp
// separator, which git appends whenever the path contains a space — on
// both the old and new side alike) must come off before the C-style
// quoting is parsed, or a quoted path with a space in it fails to unquote
// and comes back with the quotes, octal escapes, and tab all still
// attached. unquoteCStyle understands git's quoting the way Go's
// strconv.Unquote does — including \NNN octal byte escapes, which is the
// part JSON.parse and friends do not support.
function unquotePath(p: string): string {
  if (p.endsWith("\t")) p = p.slice(0, -1);
  if (p.startsWith('"')) {
    const unq = unquoteCStyle(p);
    if (unq !== null) return unq;
  }
  return p;
}

const simpleEscapes: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  "\\": 0x5c,
  '"': 0x22,
  "'": 0x27,
};

// unquoteCStyle decodes a double-quoted, C-escaped path the way git wrote
// it: literal bytes plus \t \n \\ \" ... escapes and \NNN three-digit octal
// byte escapes for anything non-ASCII or non-printable. It collects raw
// bytes rather than decoding escape-by-escape into JS characters, because a
// non-ASCII path is emitted as a run of several \NNN escapes that only form
// a valid character once decoded together as UTF-8 (e.g. "é" is \303\251 —
// two bytes, not two code points). Returns null on anything malformed, the
// same "leave it quoted" fallback strconv.Unquote's error triggers.
function unquoteCStyle(p: string): string | null {
  if (p.length < 2 || p[0] !== '"' || p[p.length - 1] !== '"') return null;
  const inner = p.slice(1, -1);
  const bytes: number[] = [];
  let i = 0;
  while (i < inner.length) {
    const c = inner[i];
    if (c === "\\") {
      const next = inner[i + 1];
      if (next === undefined) return null;
      if (next >= "0" && next <= "7") {
        const oct = inner.slice(i + 1, i + 4);
        if (oct.length !== 3 || !/^[0-7]{3}$/.test(oct)) return null;
        const val = parseInt(oct, 8);
        if (val > 255) return null;
        bytes.push(val);
        i += 4;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(simpleEscapes, next)) {
        bytes.push(simpleEscapes[next]);
        i += 2;
        continue;
      }
      return null;
    }
    for (const b of Buffer.from(c, "utf8")) bytes.push(b);
    i++;
  }
  return Buffer.from(bytes).toString("utf8");
}

// pathFromGitLine recovers the path from `diff --git a/P b/P` for a section
// with nothing else to read it from — a mode-only change or a binary file,
// neither renamed. Old and new are identical here: a rename carries its own
// `rename from`/`rename to` lines, handled before this is ever reached.
// Splitting on whitespace breaks the moment P itself contains a space, so
// this instead finds the "P b/P" split point where both halves match.
//
// The quoted form (`diff --git "a/P" "b/P"`, for a non-ASCII path) is left
// unhandled here, same as before this fix — nothing in this fallback's
// input set exercises it.
function pathFromGitLine(line: string): string {
  const prefix = "diff --git a/";
  if (!line.startsWith(prefix)) return "";
  const rest = line.slice(prefix.length);
  for (let i = 0; i + 3 <= rest.length; i++) {
    if (rest.slice(i, i + 3) === " b/" && rest.slice(0, i) === rest.slice(i + 3)) {
      return rest.slice(0, i);
    }
  }
  return rest;
}

// Exported for the same reason as hunkRe: git.test.ts calls it directly.
export function countOr1(s: string): number {
  if (s === "") return 1; // "@@ -3 +3 @@" means a single line
  return atoi(s);
}

function atoi(s: string): number {
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}
