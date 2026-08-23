import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// git diff output can be large; Node's default execFile maxBuffer (1MB)
// truncates it long before Go's unbounded bytes.Buffer ever would.
const MAX_BUFFER = 200 * 1024 * 1024;

interface ExecResult {
  stdout: string;
  stderr: string;
}

// run executes git and returns its output.
async function run(dir: string, args: string[]): Promise<ExecResult> {
  try {
    const child = execFileAsync("git", args, {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
    });
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
