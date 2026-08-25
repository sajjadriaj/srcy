import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { git } from "../src/git.js";

// newRepo makes a temp git repo with one commit and returns its path.
// The directory is removed after the test via t.after, the node:test
// equivalent of Go's t.TempDir() auto-cleanup.
export async function newRepo(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "srcy-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "user.email", "t@t");
  await write(dir, "a.txt", "one\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-qm", "init");
  return dir;
}

export async function write(dir: string, name: string, content: string): Promise<void> {
  await writeFile(join(dir, name), content, "utf8");
}
