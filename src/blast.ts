import { git } from "./git.js";
import type { FileDiff } from "./diff.js";

// Language keywords that can precede a "(" without naming a function or
// method — matching one of these must never be reported as the symbol.
const KEYWORDS = new Set(["func", "def", "function", "if", "for", "while", "switch", "return", "class"]);

// Declaration keywords for a symbol with no "(" at all in its header line
// (a bare class/type/struct/interface declaration).
const DECL_KEYWORDS = ["class", "type", "struct", "interface"];

// symbolFrom extracts the enclosing symbol's name from a hunk's funcname
// context (Hunk.func in diff.ts, sourced from git's builtin xfuncname
// drivers — see the core.attributesFile setup in git.ts). Takes the first
// identifier immediately followed by "(" that isn't a language keyword;
// falls back to a bare class/type/struct/interface declaration when there
// is no "(" at all. Returns "" when nothing is detectable — a language with
// no builtin driver produces an empty header, and guessing is worse than
// reporting nothing.
export function symbolFrom(hunkHeader: string): string {
  const s = hunkHeader.trim();
  if (s === "") return "";

  const callRe = /\b([A-Za-z_]\w*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(s)) !== null) {
    if (!KEYWORDS.has(m[1])) return m[1];
  }

  for (const kw of DECL_KEYWORDS) {
    const declRe = new RegExp(`\\b${kw}\\s+([A-Za-z_]\\w*)`);
    const dm = declRe.exec(s);
    if (dm) return dm[1];
  }

  return "";
}

// Symbol is one changed symbol's blast radius: who else references it, and
// how many of those referencing files the agent actually opened.
export interface Symbol {
  name: string;
  callers: string[]; // referencing files, excluding the file(s) the symbol itself changed in
  readCount: number; // how many of `callers` are in readPaths
}

// ponytail: git's xfuncname plus git grep. Crude, zero deps, language-agnostic.
// Upgrade to tree-sitter or an LSP if the noise outweighs the signal on a real repo.
export async function blastRadius(repo: string, files: FileDiff[], readPaths: ReadonlySet<string>): Promise<Symbol[]> {
  // Group by symbol name first — "distinct changed symbol", not "distinct
  // (file, symbol) pair" — and remember every file it changed in, all of
  // which are excluded from its own caller list below.
  const changedIn = new Map<string, Set<string>>();
  const order: string[] = [];
  for (const f of files) {
    for (const h of f.hunks) {
      const name = symbolFrom(h.func);
      if (name === "") continue;
      let set = changedIn.get(name);
      if (!set) {
        set = new Set();
        changedIn.set(name, set);
        order.push(name);
      }
      set.add(f.path);
    }
  }

  const out: Symbol[] = [];
  for (const name of order) {
    const ownFiles = changedIn.get(name)!;
    let stdout = "";
    try {
      stdout = await git(repo, "grep", "-l", "-w", "--", name);
    } catch (err) {
      // `git grep` exits 1 when nothing matches — that's "no callers", not
      // an error. Anything else (bad repo, etc.) is real and must surface.
      if (!(err instanceof Error) || !/exit status 1:/.test(err.message)) throw err;
    }
    const callers = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !ownFiles.has(l));
    const readCount = callers.filter((c) => readPaths.has(c)).length;
    out.push({ name, callers, readCount });
  }
  return out;
}
