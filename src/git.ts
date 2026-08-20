import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

const execFileAsync = promisify(execFile);

// git diff output can be large; Node's default execFile maxBuffer (1MB)
// truncates it long before Go's unbounded bytes.Buffer ever would.
const MAX_BUFFER = 200 * 1024 * 1024;

interface ExecResult {
  stdout: string;
  stderr: string;
}

async function run(dir: string, args: string[]): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; code?: number | string };
    const stderr = typeof e.stderr === "string" ? e.stderr : "";
    const reason = typeof e.code === "number" ? `exit status ${e.code}` : e.message;
    throw new Error(`git ${args.join(" ")}: ${reason}: ${stderr.trim()}`);
  }
}

// git runs a git command in dir and returns its trimmed stdout.
// On failure the error carries git's stderr verbatim: the user is going to
// debug this with the same command, so they should see what git said.
export async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(dir, args);
  return stdout.trim();
}

// gitRaw is git() without the trimming. Diff output is bytes we hand to
// `git apply` verbatim, and a trailing whitespace-only context line is
// content, not noise: trimming it leaves the @@ counts describing more
// lines than the body contains, which git rejects as a corrupt patch.
export async function gitRaw(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(dir, args);
  return stdout;
}

// Worktree is one session's isolated checkout.
export class Worktree {
  readonly repo: string; // the user's repository
  readonly path: string; // .ctui/wt/<name>
  readonly branch: string; // ctui/<name>
  readonly base: string; // repo HEAD at creation; every diff is taken against this

  constructor(repo: string, path: string, branch: string, base: string) {
    this.repo = repo;
    this.path = path;
    this.branch = branch;
    this.base = base;
  }

  // destroy removes the worktree and its branch. Force, because the agent
  // almost always leaves uncommitted work behind and we are discarding it
  // deliberately.
  async destroy(): Promise<void> {
    await git(this.repo, "worktree", "remove", "--force", this.path);
    await git(this.repo, "branch", "-D", this.branch);
  }

  // diff returns the worktree's changes against its base commit.
  //
  // It stages first: agents routinely leave work uncommitted, and a plain
  // `git diff` would silently omit every file they created. Staging is
  // harmless here because the worktree is disposable.
  async diff(): Promise<string> {
    const attrs = await writeAttributes(this.repo);
    await git(this.path, "add", "-A");
    // We are producing bytes for `git apply`, so the diff must be literal
    // regardless of how the user has configured *reading* diffs: neutralize
    // diff.mnemonicPrefix (c/i instead of a/b), diff.noprefix (no prefix at
    // all), and core.quotePath (which C-quotes any non-ASCII path — the only
    // path source left for a mode-only or binary section, which carries no
    // "+++"/"rename to" line for the unquote fallback to read instead); and
    // disable any external diff driver or textconv filter that would make
    // the output something other than a real patch. core.quotePath=false
    // still quotes a path containing an actual control character (e.g. a
    // literal tab), so that case stays quoted and goes through the existing
    // unquote branch rather than silently mis-parsing.
    return gitRaw(
      this.path,
      "-c",
      `core.attributesFile=${attrs}`,
      "-c",
      "diff.mnemonicPrefix=false",
      "-c",
      "diff.noprefix=false",
      "-c",
      "core.quotePath=false",
      "diff",
      "--cached",
      "--no-ext-diff",
      "--no-textconv",
      this.base,
    );
  }
}

// createWorktree branches from the repo's current HEAD into .ctui/wt/<name>.
export async function createWorktree(repo: string, name: string): Promise<Worktree> {
  const base = await git(repo, "rev-parse", "HEAD");
  const path = join(repo, ".ctui", "wt", name);
  const branch = `ctui/${name}`;
  await excludeCtui(repo);
  await git(repo, "worktree", "add", "-b", branch, path, base);
  const w = new Worktree(repo, path, branch, base);
  try {
    await runPostCreate(w);
  } catch (err) {
    try {
      await w.destroy();
    } catch (destroyErr) {
      throw new Error(`postcreate failed: ${err}: (also failed to rollback: ${destroyErr})`);
    }
    throw err;
  }
  return w;
}

// excludeCtui hides .ctui/ via .git/info/exclude rather than .gitignore:
// this is our bookkeeping, not a fact about the user's project, and it
// should never show up in their diff.
async function excludeCtui(repo: string): Promise<void> {
  let gitDir = await git(repo, "rev-parse", "--git-common-dir");
  if (!isAbsolute(gitDir)) {
    gitDir = join(repo, gitDir);
  }
  const excludePath = join(gitDir, "info", "exclude");
  await fs.mkdir(dirname(excludePath), { recursive: true, mode: 0o755 });
  let existing = "";
  try {
    existing = await fs.readFile(excludePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  for (const line of existing.split("\n")) {
    if (line.trim() === ".ctui/") return;
  }
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await fs.appendFile(excludePath, prefix + ".ctui/\n", { encoding: "utf8", mode: 0o644 });
}

// diffAttributes enables git's builtin funcname drivers so hunk headers
// carry the enclosing function. Blast radius reads those headers, so this
// is what makes it work at all.
//
// Without a driver git falls back to a generic heuristic that takes the last
// preceding unindented line, which for an indented method reports the
// enclosing class instead of the method — the wrong symbol, silently.
//
// This file is written inside .ctui and passed to git per-invocation via
// -c core.attributesFile. We never write to the repository's own
// .git/info/attributes: users legitimately keep custom diff, merge and
// textconv rules there, and no amount of careful merging into a shared file
// we do not own is worth the risk of eating them. core.attributesFile also
// sits at the lowest precedence, so a rule the user set anywhere still wins
// over ours, which is the correct relationship.
const diffAttributes = `*.go diff=golang
*.py diff=python
*.rs diff=rust
*.rb diff=ruby
*.php diff=php
*.java diff=java
*.kt diff=kotlin
*.cs diff=csharp
*.c diff=cpp
*.h diff=cpp
*.cc diff=cpp
*.cpp diff=cpp
*.m diff=objc
*.pl diff=perl
*.ex diff=elixir
*.exs diff=elixir
*.css diff=css
*.md diff=markdown
`;

// writeAttributes drops our driver mappings in .ctui and returns the path,
// for the caller to pass to git as core.attributesFile. It owns this file
// completely, so it can truncate without reading anything first.
async function writeAttributes(repo: string): Promise<string> {
  const path = join(repo, ".ctui", "attributes");
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o755 });
  await fs.writeFile(path, diffAttributes, { encoding: "utf8", mode: 0o644 });
  return path;
}

// runPostCreate runs .ctui/postcreate if it exists and is executable.
// Fresh worktrees have no node_modules and no build cache; what fixes that
// varies per repo, so it is a script that either exists or doesn't rather
// than a config file with a schema.
async function runPostCreate(w: Worktree): Promise<void> {
  const script = join(w.repo, ".ctui", "postcreate");
  let mode: number;
  try {
    mode = (await fs.stat(script)).mode;
  } catch {
    return;
  }
  if ((mode & 0o111) === 0) {
    return;
  }
  try {
    await execFileAsync(script, [], {
      cwd: w.path,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    throw new Error(`postcreate: ${e.message}: ${out}`);
  }
}
