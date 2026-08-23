import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { splitDiff, type FileDiff } from "./diff.js";
import { diffStats, type MapEntry } from "./cockpit.js";
import { git } from "./git.js";
import type { Problem } from "./checks.js";

// What the repo looks like right now, derived from git alone.
//
// This is the half of the panels that works for every agent. ctui does not
// speak to the agent — it is the real binary in its own pane — so "what
// changed" is answered the way a second terminal would answer it: by asking
// git. Claude Code, Codex, opencode, aider, or a human typing vim all move
// these numbers identically.

export interface RepoState {
  files: MapEntry[];
  diffs: FileDiff[];
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

async function newFileChurn(repo: string, path: string): Promise<{ added: number; removed: number }> {
  try {
    const full = join(repo, path);
    if ((await stat(full)).size > MAX_COUNT_BYTES) return { added: 0, removed: 0 };
    const text = await readFile(full, "utf8");
    if (text === "") return { added: 0, removed: 0 };
    return { added: text.split("\n").length - (text.endsWith("\n") ? 1 : 0), removed: 0 };
  } catch {
    return { added: 0, removed: 0 }; // binary, unreadable, or deleted since
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
    return { path: f.path, touch: "wrote" as const, added, removed, problems: count.get(f.path) ?? 0 };
  });

  const seen = new Set(files.map((f) => f.path));
  const status = await git(repo, "status", "--porcelain", "-uall").catch(() => "");
  for (const line of status.split("\n")) {
    if (!line.startsWith("?? ")) continue;
    const path = line.slice(3).trim();
    if (path === "" || seen.has(path)) continue;
    files.push({ path, touch: "wrote", ...(await newFileChurn(repo, path)), problems: count.get(path) ?? 0 });
  }

  // A failing file the agent has not touched still belongs on the map: the
  // reader's question is "what is broken", and git's answer to "what moved"
  // does not contain it.
  for (const [path, n] of count) {
    if (seen.has(path) || files.some((f) => f.path === path)) continue;
    files.push({ path, touch: "read", added: 0, removed: 0, problems: n });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, diffs };
}

// Every file in the project, for the rail's tree — tracked plus untracked,
// minus whatever .gitignore excludes. git is asked rather than the directory
// walked so that node_modules and build output are somebody else's problem.
export async function listPaths(repo: string): Promise<string[]> {
  const out = await git(repo, "ls-files", "-co", "--exclude-standard").catch(() => "");
  return out.split("\n").filter((l) => l !== "");
}
