import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installSignalCleanup } from "../src/index.js";

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
