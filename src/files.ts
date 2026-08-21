import { git } from "./git.js";

// How many matches the picker shows at once.
export const PICKER_ROWS = 10;

// listFiles is every file in the tree the agent is working in, including
// the ones it just created. `--others --exclude-standard` is what makes
// those visible: an agent's new file is untracked until something stages
// it, and "open any file" that cannot open the file the agent just wrote
// would be a strange kind of "any".
export async function listFiles(worktreePath: string): Promise<string[]> {
  const out = await git(worktreePath, "ls-files", "--cached", "--others", "--exclude-standard");
  if (out === "") return [];
  // Deduplicated because a path can be both staged and present on disk,
  // and git lists it under each.
  return [...new Set(out.split("\n").filter((l) => l !== ""))];
}

// filterFiles ranks paths against a query. Terms are whitespace-separated
// and must all appear somewhere in the path, so "auth tok" finds
// src/auth/token.ts without anyone having to remember the order.
//
// Ranking puts basename matches first, because someone typing "token" wants
// token.ts, not the twelve files under a directory that happens to contain
// the word. Ties break on the shorter path: it is the more likely target
// and the ordering has to be stable.
//
// ponytail: substring terms, not fuzzy subsequence matching. "tkn" finds
// nothing. Add a scorer when that starts costing keystrokes; it is a
// self-contained change to this one function.
export function filterFiles(files: string[], query: string, limit = PICKER_ROWS): string[] {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t !== "");
  if (terms.length === 0) return files.slice(0, limit);

  const scored: { path: string; rank: number }[] = [];
  for (const path of files) {
    const lower = path.toLowerCase();
    if (!terms.every((t) => lower.includes(t))) continue;
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    scored.push({ path, rank: terms.every((t) => base.includes(t)) ? 0 : 1 });
  }
  scored.sort((a, b) => a.rank - b.rank || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
  return scored.slice(0, limit).map((s) => s.path);
}
