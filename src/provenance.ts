import { hunkRe, type FileDiff } from "./diff.js";
import { git } from "./git.js";

// What produced one line of a file. `prompt` is the human's own words when
// the commit carries a Ctui-Prompt trailer, and the commit subject
// otherwise — a line written by hand still has a provenance, it just isn't
// a prompt.
export interface LineOrigin {
  sha: string; // "" for a line this session added, which has no commit yet
  date: string;
  label: string;
}

// The origin shown for lines this session wrote: they are the thing under
// review, and they have no commit to point at yet.
export const PENDING: LineOrigin = { sha: "", date: "", label: "this session" };

// mapToOld turns a line number in the changed file into its line number in
// the committed one, or 0 for a line this session added.
//
// This is what makes the gutter possible at all: the file the reviewer is
// reading does not exist in git yet, so its line numbers cannot be blamed
// directly. Everything unchanged has a counterpart in HEAD, and the diff is
// exactly the description of how to find it.
export function mapToOld(f: FileDiff): (newLine: number) => number {
  // Each hunk's old/new spans, in file order. newStart/newCount are already
  // on Hunk; the old side is only in the @@ header, so it is parsed back
  // out here rather than widening Hunk for one caller.
  const spans: { oldStart: number; oldCount: number; newStart: number; newCount: number; body: string }[] = [];
  for (const hunk of f.hunks) {
    const m = hunkRe.exec(hunk.header.replace(/\n$/, ""));
    if (!m) continue;
    spans.push({
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: hunk.newStart,
      newCount: hunk.newCount,
      body: hunk.body,
    });
  }
  spans.sort((a, b) => a.newStart - b.newStart);

  return (newLine: number): number => {
    let delta = 0; // how far the new file has drifted from the old one so far
    for (const span of spans) {
      if (newLine < span.newStart) break;
      if (newLine < span.newStart + span.newCount) {
        // Inside the hunk: walk its body, advancing each side by the lines
        // that exist on it, until the new-side counter reaches newLine.
        let oldAt = span.oldStart;
        let newAt = span.newStart;
        for (const line of span.body.split("\n")) {
          if (line === "" || line.startsWith("\\")) continue;
          const sign = line[0];
          if (sign === "-") {
            oldAt++;
            continue;
          }
          if (newAt === newLine) return sign === "+" ? 0 : oldAt;
          newAt++;
          if (sign !== "+") oldAt++;
        }
        return 0;
      }
      delta += span.newCount - span.oldCount;
    }
    const old = newLine - delta;
    return old > 0 ? old : 0;
  };
}

// Matches git blame --porcelain's header line: "<sha> <oldline> <newline>"
// optionally followed by a group size.
const BLAME_HEADER = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

// blameLines maps each line of a file at HEAD to the commit that last
// touched it. Porcelain rather than the human format because the human one
// embeds author names and dates in a layout that changes with the data.
export function parseBlame(porcelain: string): Map<number, string> {
  const byLine = new Map<number, string>();
  for (const line of porcelain.split("\n")) {
    const m = BLAME_HEADER.exec(line);
    if (m) byLine.set(Number(m[2]), m[1]!);
  }
  return byLine;
}

const REC = "CTUIP\x1f";

// commitLabels looks up how each commit should be described. The
// Ctui-Prompt trailer wins: it is the human's own words, and it is what
// makes the gutter answer "why is this here" rather than "what was this
// commit called".
export async function commitLabels(repo: string, shas: Iterable<string>): Promise<Map<string, LineOrigin>> {
  const unique = [...new Set(shas)].filter((s) => s !== "" && !/^0{40}$/.test(s));
  const out = new Map<string, LineOrigin>();
  if (unique.length === 0) return out;

  const format = `${REC}%H\x1f%ad\x1f%(trailers:key=Ctui-Prompt,valueonly)\x1f%s`;
  const text = await git(repo, "show", "--no-patch", `--format=${format}`, "--date=short", ...unique);
  for (const chunk of text.split(REC).slice(1)) {
    const [sha, date, prompt, ...rest] = chunk.split("\x1f");
    if (sha === undefined || date === undefined) continue;
    const subject = rest.join("\x1f").split("\n")[0] ?? "";
    const trailer = (prompt ?? "").trim().split("\n")[0] ?? "";
    out.set(sha.trim(), {
      sha: sha.trim(),
      date: date.trim(),
      label: trailer !== "" ? trailer : subject.trim(),
    });
  }
  return out;
}

// lineOrigins is the whole gutter for one file: for every line of the file
// as the reviewer sees it, what produced it.
//
// Two git calls per file, not one per line: blame the committed version
// once, then describe each distinct commit once. A per-line `git log -L`
// (what `ctui why` does for a single line, correctly) would be one process
// per line of the file.
//
// ponytail: blame is against HEAD, so a line's provenance is where it stood
// when this session started. Good enough — the session's own lines are
// already labelled PENDING, and nothing else can have moved underneath it.
export async function lineOrigins(
  repo: string,
  path: string,
  lineCount: number,
  diff: FileDiff | undefined,
): Promise<Map<number, LineOrigin>> {
  const origins = new Map<number, LineOrigin>();
  const toOld = diff ? mapToOld(diff) : (n: number): number => n;

  let blame: Map<number, string>;
  try {
    blame = parseBlame(await git(repo, "blame", "--porcelain", "HEAD", "--", path));
  } catch {
    // The file does not exist at HEAD — the agent created it, so every
    // line of it belongs to this session.
    for (let n = 1; n <= lineCount; n++) origins.set(n, PENDING);
    return origins;
  }

  const shas = new Set<string>();
  const oldOf = new Map<number, number>();
  for (let n = 1; n <= lineCount; n++) {
    const old = toOld(n);
    oldOf.set(n, old);
    const sha = old === 0 ? undefined : blame.get(old);
    if (sha !== undefined) shas.add(sha);
  }

  const labels = await commitLabels(repo, shas);
  for (let n = 1; n <= lineCount; n++) {
    const old = oldOf.get(n)!;
    const sha = old === 0 ? undefined : blame.get(old);
    const label = sha === undefined ? undefined : labels.get(sha);
    origins.set(n, label ?? PENDING);
  }
  return origins;
}
