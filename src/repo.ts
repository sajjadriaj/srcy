import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { splitDiff, type FileDiff } from "./diff.js";
import { diffStats, type MapEntry } from "./cockpit.js";
import { git } from "./git.js";
import type { Problem } from "./checks.js";

// What the repo looks like right now, derived from git alone.
//
// This is the half of the panels that works for every agent. srcy does not
// speak to the agent — it is the real binary in its own pane — so "what
// changed" is answered the way a second terminal would answer it: by asking
// git. Claude Code, Codex, opencode, aider, or a human typing vim all move
// these numbers identically.

export interface RepoState {
  files: MapEntry[];
  diffs: FileDiff[];
  // What the working tree contains, not just which lines moved. Churn counts
  // alone cannot tell one edit from another: replacing a line with a different
  // line of the same length leaves `+1 -1` exactly as it was, and that is the
  // commonest edit an agent makes — the fix for the bug it just introduced.
  //
  // ponytail: hashes the whole diff each poll. The `git diff HEAD` that
  // produced it costs more; revisit only if a repo turns up where it does not.
  mark: string;
  // The same fingerprint taken apart: one `[path, stamp]` per changed file,
  // sorted by path. `mark` is the hash of this list, so the two can never
  // disagree — and a gate that watches only `src/**` can hash the entries it
  // cares about instead of being invalidated by every edit in the repo.
  stamps: [string, string][];
}

// srcy's own runtime state is not a change to the project.
//
// .srcy/state.json holds the gate verdicts, and it is written the moment a
// gate finishes. Counting it as part of the tree makes every verdict
// invalidate itself on the way to disk: the pass lands, the mark moves
// because the pass landed, and the rail reports "code moved since" about the
// run that just happened. The timeline and the checkpoint log are written on
// the same beat and would do the same thing. Skipped here rather than only in
// .gitignore, because a repo that has not added those lines yet must not be
// broken by it.
const RUNTIME = new Set([".srcy/state.json", ".srcy/events.jsonl", ".srcy/checkpoints.jsonl"]);

export function runtimeFile(path: string): boolean {
  return RUNTIME.has(path);
}


// One file's content fingerprint, from the diff git already produced for it.
// Header included: a rename with no content change is a change.
function fileStamp(f: FileDiff): string {
  const h = createHash("sha1").update(f.header);
  for (const k of f.hunks) h.update(k.header).update("\n").update(k.body);
  return h.digest("hex");
}

// A new file's churn is its whole length. Showing "+0 -0" for one — which
// is what git's own diff against HEAD reports, since the file isn't in it —
// reads as "nothing changed here" about the file that changed most.
//
// Read rather than shelled out to: `git diff --no-index` is one subprocess
// per untracked file, and this runs on a timer.
// ponytail: caps at 2MB, above which the count is not what anyone is
// reading the rail for.
const MAX_COUNT_BYTES = 2_000_000;

// What git calls a tree with nothing in it: the same hash in every repo.
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";


interface Churn {
  added: number;
  removed: number;
  // An untracked file is not in `git diff HEAD`, so it has to be marked
  // separately. Its content is already read here to count the lines, so
  // hashing it costs nothing extra — and unlike size and mtime it cannot miss
  // two same-length writes inside one millisecond. A file too big to read
  // falls back to the stat, which is all there is.
  stamp: string;
}

async function newFileChurn(repo: string, path: string): Promise<Churn> {
  const none = { added: 0, removed: 0, stamp: "" };
  try {
    const full = join(repo, path);
    const info = await stat(full);
    if (info.size > MAX_COUNT_BYTES) return { ...none, stamp: `${info.size}:${info.mtimeMs}` };
    const text = await readFile(full, "utf8");
    const stamp = createHash("sha1").update(text).digest("hex");
    if (text === "") return { ...none, stamp };
    return { added: text.split("\n").length - (text.endsWith("\n") ? 1 : 0), removed: 0, stamp };
  } catch {
    return none; // binary, unreadable, or deleted since
  }
}

export async function repoState(repo: string, problems: Problem[] = []): Promise<RepoState> {
  const count = new Map<string, number>();
  for (const p of problems) count.set(p.path, (count.get(p.path) ?? 0) + 1);

  // Against HEAD, not the index: an agent that staged its work is still an
  // agent whose work you have not read yet. A repo with no commit yet has
  // no HEAD, and is diffed against the empty tree instead — the rail went
  // blank on exactly the repo a reader had just created for the agent.
  const base = await git(repo, "rev-parse", "--verify", "-q", "HEAD").then(() => "HEAD").catch(() => EMPTY_TREE);
  const raw = await git(repo, "diff", base).catch(() => "");
  const diffs = splitDiff(raw).filter((f) => !runtimeFile(f.path));

  const files: MapEntry[] = diffs.map((f) => {
    const { added, removed } = diffStats(f);
    // git says which of the three this is in the file's own header, so the
    // distinction costs no extra call: `deleted file mode` and `new file
    // mode` are lines git writes there and nowhere else.
    const touch = f.header.includes("deleted file mode ")
      ? ("deleted" as const)
      : f.header.includes("new file mode ")
        ? ("added" as const)
        : ("wrote" as const);
    return { path: f.path, touch, added, removed, problems: count.get(f.path) ?? 0 };
  });

  const stamps: [string, string][] = diffs.map((f) => [f.path, fileStamp(f)]);
  const seen = new Set(files.map((f) => f.path));
  const status = await git(repo, "status", "--porcelain", "-uall").catch(() => "");
  for (const line of status.split("\n")) {
    if (!line.startsWith("?? ")) continue;
    const path = line.slice(3).trim();
    if (path === "" || seen.has(path) || runtimeFile(path)) continue;
    const { added, removed, stamp } = await newFileChurn(repo, path);
    stamps.push([path, stamp]);
    // Untracked: it did not exist at HEAD, which is the same thing `new file
    // mode` says about a staged one.
    files.push({ path, touch: "added", added, removed, problems: count.get(path) ?? 0 });
  }

  // A failing file the agent has not touched still belongs on the map: the
  // reader's question is "what is broken", and git's answer to "what moved"
  // does not contain it.
  for (const [path, n] of count) {
    if (seen.has(path) || files.some((f) => f.path === path)) continue;
    files.push({ path, touch: "read", added: 0, removed: 0, problems: n });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  stamps.sort(([a], [b]) => a.localeCompare(b));
  const mark = createHash("sha1")
    .update(stamps.map(([p, s]) => `${p}\u0000${s}`).join("\u0001"))
    .digest("hex");
  return { files, diffs, mark, stamps };
}

// Every file in the project, for the rail's tree — tracked plus untracked,
// minus whatever .gitignore excludes. git is asked rather than the directory
// walked so that node_modules and build output are somebody else's problem.
export async function listPaths(repo: string): Promise<string[]> {
  const out = await git(repo, "ls-files", "-co", "--exclude-standard").catch(() => "");
  // Minus srcy's own verdict file, for the same reason the fingerprint skips
  // it: a project that has not added the .gitignore line yet should not find
  // srcy's droppings in the tree it came here to read.
  return out.split("\n").filter((l) => l !== "" && !runtimeFile(l));
}

// The objective the project pinned, if it pinned one. A transcript's newest
// request is the newest thing you said, which is not the same as what you are
// trying to do: it is replaced every turn, and a compaction or a model change
// can leave it describing a detour. A file in the repo outlives all three.
export async function loadTask(cwd: string): Promise<string> {
  const raw = await readFile(join(cwd, ".srcy", "task.md"), "utf8").catch(() => "");
  // It is markdown, so the first line is usually a heading and its hashes are
  // punctuation rather than something to read.
  return (
    raw
      .split("\n")
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .find((l) => l !== "") ?? ""
  );
}
