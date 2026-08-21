import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const execFileAsync = promisify(execFile);

// git diff output can be large; Node's default execFile maxBuffer (1MB)
// truncates it long before Go's unbounded bytes.Buffer ever would.
const MAX_BUFFER = 200 * 1024 * 1024;

interface ExecResult {
  stdout: string;
  stderr: string;
}

// run executes git. When `stdin` is given it is written to the child's
// stdin and the pipe closed — used for patches and commit messages, neither
// of which fits on a command line. `extraEnv` is merged over process.env,
// for plumbing that needs GIT_INDEX_FILE pointed at a scratch index.
async function run(dir: string, args: string[], stdin?: string, extraEnv?: NodeJS.ProcessEnv): Promise<ExecResult> {
  try {
    const child = execFileAsync("git", args, {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
    });
    if (stdin !== undefined) {
      child.child.stdin?.end(stdin, "utf8");
    }
    const { stdout, stderr } = await child;
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

// gitStdin runs git with `input` written to its stdin — for a patch or a
// commit message, neither of which belongs on a command line.
async function gitStdin(dir: string, input: string, ...args: string[]): Promise<string> {
  const { stdout } = await run(dir, args, input);
  return stdout.trim();
}

// gitEnv/gitStdinEnv are git()/gitStdin() with extra environment variables —
// used only for plumbing against a scratch GIT_INDEX_FILE, which must never
// touch the worktree's real index.
async function gitEnv(dir: string, env: NodeJS.ProcessEnv, ...args: string[]): Promise<string> {
  const { stdout } = await run(dir, args, undefined, env);
  return stdout.trim();
}

async function gitStdinEnv(dir: string, input: string, env: NodeJS.ProcessEnv, ...args: string[]): Promise<string> {
  const { stdout } = await run(dir, args, input, env);
  return stdout.trim();
}

// Worktree is one session's isolated checkout.
export class Worktree {
  readonly repo: string; // the user's repository
  readonly path: string; // .ctui/wt/<name>
  readonly branch: string; // ctui/<name>
  // Repo HEAD at creation; every diff is taken against this. Not readonly:
  // advanceAfterAccept moves it forward after every successful accept, so a
  // hunk already applied never shows up in the next diff. Only that method
  // should ever assign it.
  base: string;

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
      // Without --binary, git emits "Binary files … differ" for a changed
      // binary file — not real patch data, so `git apply` rejects it
      // ("cannot apply binary patch without full index line"). Worse, git
      // apply treats the whole patch as one unit, so one unappliable binary
      // section fails every other (text) hunk in the same accept too.
      "--binary",
      "--no-ext-diff",
      "--no-textconv",
      this.base,
    );
  }

  // advanceAfterAccept moves base forward to old base + `patch`, so that a
  // hunk just accepted stops showing up in the next diff() and isn't
  // re-applied on the next accept. Built entirely with plumbing against a
  // scratch index (GIT_INDEX_FILE) — the worktree's real index and working
  // tree are never touched.
  //
  // Deliberately NOT "set base to the repo's new HEAD": that only agrees
  // with this while the user's own branch hasn't moved. If they commit
  // unrelated work in the meantime, reading HEAD as the new base would make
  // diff() start showing the inverse of their own commits as pending
  // changes — wrong exactly when it matters most.
  async advanceAfterAccept(patch: string): Promise<void> {
    const dir = await fs.mkdtemp(join(tmpdir(), "ctui-index-"));
    const indexFile = join(dir, "index");
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      await gitEnv(this.path, env, "read-tree", this.base);
      await gitStdinEnv(this.path, patch, env, "apply", "--cached");
      const tree = await gitEnv(this.path, env, "write-tree");
      this.base = await git(this.path, "commit-tree", tree, "-p", this.base, "-m", "ctui: accepted");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
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

// dirtyPaths returns which of `paths` already have unstaged or staged
// changes in the user's repo (not the worktree — the real repo applyPatch
// targets). The caller must refuse to apply anything touching one of these
// before ever calling applyPatch: --3way is not atomic the way plain `git
// apply` is — on a path with the user's own staged content, a conflicting
// 3-way merge can write conflict markers into their file AND replace their
// staged version in the index with the (rejected) 3-way merge state, then
// still exit non-zero. Refusing up front is the fix; applyPatch itself
// makes no attempt to be safe against this, by design (see its own comment).
export async function dirtyPaths(repo: string, paths: string[]): Promise<string[]> {
  const dirty: string[] = [];
  for (const p of paths) {
    const [unstaged, staged] = await Promise.all([
      isDirty(repo, ["diff", "--quiet", "--", p]),
      isDirty(repo, ["diff", "--cached", "--quiet", "--", p]),
    ]);
    if (unstaged || staged) dirty.push(p);
  }
  return dirty;
}

// isDirty runs a `git diff --quiet` variant, whose real API is its exit
// code: 0 means no difference, 1 means there is one, and anything else is a
// genuine error that must not be swallowed as "clean".
async function isDirty(repo: string, args: string[]): Promise<boolean> {
  try {
    await run(repo, args);
    return false;
  } catch (err) {
    if (err instanceof Error && /exit status 1:/.test(err.message)) return true;
    throw err;
  }
}

// applyPatch applies a patch to the user's repository.
//
// --3way lets git use blob context to place a hunk whose surroundings have
// drifted; --index keeps the working tree and index in step so the commit
// that follows sees exactly what was applied.
//
// Unlike plain `git apply`, --3way is NOT atomic: on conflict it can write
// conflict markers into a file and partially update the index before
// exiting non-zero, and with multiple files in one patch, files that don't
// conflict can land fully applied and staged while a sibling fails. Callers
// MUST refuse to call this at all for any path with the user's own pending
// changes (see dirtyPaths) — that is what actually prevents the dangerous
// case, not anything in here. What this function still guarantees is
// honest reporting: on failure it never claims "nothing changed" without
// having checked, so a conflict caused by something other than a dirty
// target (e.g. the patch's base has drifted from HEAD) is at least
// described accurately rather than misreported as a no-op.
export async function applyPatch(repo: string, patch: string): Promise<void> {
  try {
    await gitStdin(repo, patch, "apply", "--3way", "--index", "-");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const report = await describeApplyFailure(repo).catch((describeErr) => ` (could not inspect repo state after the failure: ${describeErr})`);
    throw new Error(`${detail}${report}`);
  }
}

// describeApplyFailure inspects the repo immediately after a failed
// `git apply --3way --index` and reports exactly what landed: which paths
// applied cleanly and are now staged, and which are left with conflict
// markers (git ls-files -u lists a conflicted path once per stage, 1/2/3).
async function describeApplyFailure(repo: string): Promise<string> {
  const [unmerged, stagedNames] = await Promise.all([
    git(repo, "ls-files", "-u"),
    git(repo, "diff", "--cached", "--name-only"),
  ]);
  const conflicted = new Set(
    unmerged
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "")
      // `ls-files -u` format: "<mode> <sha> <stage>\t<path>"
      .map((l) => l.slice(l.indexOf("\t") + 1)),
  );
  const staged = stagedNames
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !conflicted.has(l));

  if (conflicted.size === 0 && staged.length === 0) {
    return " — nothing was applied";
  }
  const parts: string[] = [];
  if (staged.length > 0) parts.push(`applied and staged: ${staged.join(", ")}`);
  if (conflicted.size > 0) parts.push(`conflict markers written to: ${[...conflicted].join(", ")}`);
  return ` — ${parts.join("; ")}`;
}

// commitAccepted commits ONLY the given paths, carrying the agent's own
// summary as the body and the provenance as trailers.
//
// This is what makes `why` free: `git log -L` already tracks a line through
// renames, moves and reformatting, so storing provenance in the commit
// means no sidecar file to keep in sync and nothing to lose.
export async function commitAccepted(
  repo: string,
  paths: string[],
  subject: string,
  body: string,
  session: string,
  prompt: string,
): Promise<void> {
  if (paths.length === 0) {
    throw new Error("refusing to commit: no paths");
  }
  let msg = subject;
  if (body !== "") {
    msg += "\n\n" + body;
  }
  msg += "\n\n" + `Ctui-Session: ${flattenTrailer(session)}\n` + `Ctui-Prompt: ${flattenTrailer(prompt)}\n`;

  // Scope the commit to exactly the paths we applied. A bare `git commit`
  // would sweep in whatever the user already had staged and stamp it with
  // trailers claiming the agent wrote it — false provenance is worse than
  // none, and this tool exists to make provenance trustworthy.
  await gitStdin(repo, msg, "commit", "-q", "-F", "-", "--", ...paths);
}

// flattenTrailer folds a value onto one line. Git trailers are line-based,
// so an embedded newline would silently end the trailer block and take the
// provenance with it.
function flattenTrailer(s: string): string {
  return s.split(/\s+/).filter((w) => w !== "").join(" ");
}

// Provenance is one commit that touched the line in question.
export interface Provenance {
  sha: string;
  date: string;
  session: string;
  prompt: string;
  body: string;
}

// A marker prefix on our own --format output. -L forces patch output, and a
// diff body can contain anything, including 40-hex strings, so a plain scan
// for "looks like a commit line" is not safe — this makes commit lines
// unambiguous. whyEnd bounds the other side of the same record: %b can
// itself contain embedded newlines (a multi-line commit body), and
// %(trailers:...,valueonly) emits a trailing newline of its own whenever
// the trailer is present but nothing at all when it's absent — so this
// output cannot be scanned line-by-line. Splitting the whole stream on
// whyMarker (never produced by a diff or a commit message) isolates one
// chunk per commit; whyEnd then marks exactly where that record's fields
// stop and -L's own patch output begins, so %b can be read whole without
// also swallowing the diff that follows it.
const whyMarker = "CTUI\x1f";
const whyEnd = "\x1eEND";

// why answers "why does this line exist" by walking the line's own history.
//
// `git log -L` follows a line through renames, moves and reformatting,
// which is the hard part of line-level provenance and the reason this is a
// git query rather than a database. Every field this needs — sha, date,
// and the provenance trailers — comes back from this single command via
// --format; no per-commit follow-up query.
export async function why(repo: string, file: string, line: number): Promise<Provenance[]> {
  const format =
    `${whyMarker}%H\x1f%ad\x1f%(trailers:key=Ctui-Session,valueonly)` +
    `\x1f%(trailers:key=Ctui-Prompt,valueonly)\x1f%b${whyEnd}`;
  const out = await git(repo, "log", `-L${line},${line}:${file}`, `--format=${format}`, "--date=short");

  const res: Provenance[] = [];
  for (const chunk of out.split(whyMarker).slice(1)) {
    const end = chunk.indexOf(whyEnd);
    if (end === -1) continue;
    const fields = chunk.slice(0, end).split("\x1f");
    if (fields.length < 5) continue;
    const [sha, date, session, prompt, ...bodyParts] = fields;
    res.push({
      sha,
      date: date.trim(),
      session: session.trim(),
      prompt: prompt.trim(),
      body: bodyParts.join("\x1f").trim(),
    });
  }
  return res;
}
