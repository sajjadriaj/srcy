import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { git } from "../src/git.js";
import { installSignalCleanup } from "../src/index.js";
import { newRepo } from "./helpers.js";

// I10: closing the terminal (SIGHUP) or a plain SIGTERM must close the
// agent's own process group, not just let the default Node behaviour
// terminate ctui and orphan whatever `detached: true` spawned. Real OS
// signals and process.exit() are deliberately not exercised here — sending
// SIGTERM to this process would kill the whole test run, and process.exit()
// inside a test would abort the suite before later tests run. What's under
// test is the cleanup logic itself: a fake `process` (a plain EventEmitter)
// stands in for real signal delivery, and a fake `exit` records its call
// instead of terminating anything.
function fakeProc(): { proc: Pick<NodeJS.Process, "once" | "exit">; emitter: EventEmitter; exitCode: number[] } {
  const emitter = new EventEmitter();
  const exitCode: number[] = [];
  const proc: Pick<NodeJS.Process, "once" | "exit"> = {
    once: (event: string | symbol, listener: (...args: unknown[]) => void) => {
      emitter.once(event, listener);
      return proc as NodeJS.Process;
    },
    exit: ((code?: number) => {
      exitCode.push(code ?? 0);
    }) as NodeJS.Process["exit"],
  };
  return { proc, emitter, exitCode };
}

test("installSignalCleanup closes the session and exits on SIGTERM", async () => {
  const closed: string[] = [];
  const session = { close: async () => void closed.push("closed") };
  const { proc, emitter, exitCode } = fakeProc();

  installSignalCleanup(session, proc);
  emitter.emit("SIGTERM");
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(closed, ["closed"]);
  assert.deepEqual(exitCode, [0]);
});

test("installSignalCleanup closes the session and exits on SIGHUP (closing the terminal)", async () => {
  const closed: string[] = [];
  const session = { close: async () => void closed.push("closed") };
  const { proc, emitter, exitCode } = fakeProc();

  installSignalCleanup(session, proc);
  emitter.emit("SIGHUP");
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(closed, ["closed"]);
  assert.deepEqual(exitCode, [0]);
});

// Both signals feed the same cleanup; it must run exactly once even if both
// fire (e.g. a terminal closing can raise more than one signal).
test("installSignalCleanup only runs once even if both signals fire", async () => {
  const closed: string[] = [];
  const session = { close: async () => void closed.push("closed") };
  const { proc, emitter, exitCode } = fakeProc();

  installSignalCleanup(session, proc);
  emitter.emit("SIGTERM");
  emitter.emit("SIGHUP");
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(closed, ["closed"]);
  assert.deepEqual(exitCode, [0]);
});

// Cleanup must still terminate the process even if closing the session
// itself fails — an agent stuck mid-close must not leave ctui hanging
// around after the terminal that launched it is gone.
test("installSignalCleanup still exits if session.close() rejects", async () => {
  const session = { close: async () => Promise.reject(new Error("boom")) };
  const { proc, emitter, exitCode } = fakeProc();

  installSignalCleanup(session, proc);
  emitter.emit("SIGTERM");
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(exitCode, [0]);
});

// `npm link` and `npm install -g` install the CLI as a symlink in
// node_modules/.bin, so argv[1] is that symlink while import.meta.url is the
// real file. An entry-point guard that compares them unresolved makes every
// installed ctui exit 0 having done nothing — no error, no output, no clue.
// This runs the CLI through a symlink the way an install does; asserting on
// `why` output is what makes the failure visible rather than silent.
test("runs when invoked through a symlink, as an install does", async (t) => {
  const repo = await newRepo(t);
  await git(repo, "commit", "-q", "--allow-empty", "-m", "second");
  const introduced = (await git(repo, "rev-parse", "HEAD~1")).slice(0, 8);

  const link = join(await mkdtemp(join(tmpdir(), "ctui-bin-")), "ctui");
  t.after(async () => {
    await rm(dirname(link), { recursive: true, force: true });
  });
  await symlink(fileURLToPath(new URL("../src/index.ts", import.meta.url)), link);

  const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(tsx, [link, "why", "a.txt:1"], { cwd: repo });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
  });

  assert.ok(out.includes(introduced), `expected provenance for ${introduced}, got ${JSON.stringify(out)}`);
});
