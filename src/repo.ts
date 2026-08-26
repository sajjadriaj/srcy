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
  // agent whose work you have not read yet.
  const raw = await git(repo, "diff", "HEAD").catch(() => "");
  const diffs = splitDiff(raw);

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

  const stamps: string[] = [];
  const seen = new Set(files.map((f) => f.path));
  const status = await git(repo, "status", "--porcelain", "-uall").catch(() => "");
  for (const line of status.split("\n")) {
    if (!line.startsWith("?? ")) continue;
    const path = line.slice(3).trim();
    if (path === "" || seen.has(path)) continue;
    const { added, removed, stamp } = await newFileChurn(repo, path);
    stamps.push(`${path}:${stamp}`);
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
  const mark = createHash("sha1").update(raw).update("\u0000").update(stamps.sort().join("\u0000")).digest("hex");
  return { files, diffs, mark };
}

// Every file in the project, for the rail's tree — tracked plus untracked,
// minus whatever .gitignore excludes. git is asked rather than the directory
// walked so that node_modules and build output are somebody else's problem.
export async function listPaths(repo: string): Promise<string[]> {
  const out = await git(repo, "ls-files", "-co", "--exclude-standard").catch(() => "");
  return out.split("\n").filter((l) => l !== "");
}
