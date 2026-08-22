import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startSession, type AgentUpdate } from "../src/acp.js";
import { newRepo } from "./helpers.js";

// The fake agent is a real ACP agent (see fake-agent.ts, built on the SDK's
// AgentSideConnection) run as a child process in place of claude-code-acp.
const here = dirname(fileURLToPath(import.meta.url));
const tsxBin = join(here, "..", "node_modules", ".bin", "tsx");
const fakeAgentPath = join(here, "fake-agent.ts");

function argvFor(scenario: string, ...extra: string[]): string[] {
  return [tsxBin, fakeAgentPath, scenario, ...extra];
}

function permArgv(toolCallOverrides: Record<string, unknown> = {}): string[] {
  return argvFor("permission", JSON.stringify(toolCallOverrides));
}

test("prompt round-trips and streams updates in order; tool_call locations relativized", async (t) => {
  const cwd = await newRepo(t);
  const updates: AgentUpdate[] = [];
  const session = await startSession({
    cwd,
    argv: argvFor("updates"),
    onUpdate: (u) => updates.push(u),
    onPermission: async () => null,
  });
  t.after(() => session.close());

  const stopReason = await session.prompt("go");

  assert.equal(stopReason, "end_turn");
  assert.deepEqual(
    updates.map((u) => u.kind),
    ["agent_message_chunk", "agent_message_chunk", "tool_call", "tool_call", "usage_update"],
  );
  assert.equal(updates[0].text, "Hello ");
  assert.equal(updates[1].text, "world");

  // Location inside cwd comes back relative.
  assert.equal(updates[2].toolTitle, "Reading file");
  assert.equal(updates[2].toolPath, "inside.txt");

  // Location outside cwd stays absolute rather than a leading "../".
  const outsideAbs = join(dirname(cwd), "outside.txt");
  assert.equal(updates[3].toolPath, outsideAbs);
  assert.ok(!updates[3].toolPath?.startsWith(".."));

  // A tool's outcome reaches the UI: without it a failing command renders
  // exactly like a working one.
  assert.equal(updates[2].toolStatus, undefined);
  assert.equal(updates[3].toolStatus, "failed");

  // Context fill and cost, when the adapter reports them at all.
  assert.deepEqual(updates[4].usage, { used: 1234, size: 200000, cost: { amount: 0.5, currency: "USD" } });

  // cancel() is a plain notification; must not throw even post-turn.
  await session.cancel();
});

test("a permission request reaches onPermission and the chosen optionId is what the agent receives", async (t) => {
  const cwd = await newRepo(t);
  const updates: AgentUpdate[] = [];
  const session = await startSession({
    cwd,
    argv: permArgv(),
    onUpdate: (u) => updates.push(u),
    onPermission: async (req) => {
      // Match on kind, per the live adapter's actual shape (fact 4): ids and
      // array order are not something a real client should rely on.
      const chosen = req.options.find((o) => o.kind === "allow_once");
      assert.ok(chosen, "expected an allow_once option");
      return chosen.optionId;
    },
  });
  t.after(() => session.close());

  await session.prompt("go");

  assert.equal(updates.at(-1)?.text, "SELECTED:allow");
});

test("returning null from onPermission cancels rather than selects", async (t) => {
  const cwd = await newRepo(t);
  const updates: AgentUpdate[] = [];
  const session = await startSession({
    cwd,
    argv: permArgv(),
    onUpdate: (u) => updates.push(u),
    onPermission: async () => null,
  });
  t.after(() => session.close());

  await session.prompt("go");

  assert.equal(updates.at(-1)?.text, "CANCELLED");
});

test("a titleless permission gets a non-empty title", async (t) => {
  const cwd = await newRepo(t);
  let receivedTitle = "";
  const session = await startSession({
    cwd,
    argv: permArgv({ title: null, kind: "execute" }),
    onUpdate: () => {},
    onPermission: async (req) => {
      receivedTitle = req.title;
      return req.options[0].optionId;
    },
  });
  t.after(() => session.close());

  await session.prompt("go");

  assert.equal(receivedTitle, "execute"); // falls back to kind
  assert.notEqual(receivedTitle.trim(), "");
});

test("a control-character title is sanitized", async (t) => {
  const cwd = await newRepo(t);
  const dirty = "\x1b[31mDelete\x1b[0m file\x07";
  let receivedTitle = "";
  const session = await startSession({
    cwd,
    argv: permArgv({ title: dirty }),
    onUpdate: () => {},
    onPermission: async (req) => {
      receivedTitle = req.title;
      return req.options[0].optionId;
    },
  });
  t.after(() => session.close());

  await session.prompt("go");

  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(receivedTitle), `title still has control chars: ${JSON.stringify(receivedTitle)}`);
  assert.ok(receivedTitle.length > 0);
});

test("agent exiting mid-turn rejects prompt without hanging; close() after is safe and idempotent", async (t) => {
  const cwd = await newRepo(t);
  const session = await startSession({
    cwd,
    argv: argvFor("exit-mid-turn"),
    onUpdate: () => {},
    onPermission: async () => null,
  });

  await assert.rejects(() => session.prompt("go"));

  await session.close();
  await session.close(); // idempotent
});

test(
  "close() kills the whole process tree, not just its immediate child",
  { timeout: 10000 }, // removing the SIGKILL escalation used to hang this for the full 10-minute default instead of failing fast
  async (t) => {
    const cwd = await newRepo(t);
    const pidFile = join(cwd, "grandchild.pid");
    const session = await startSession({
      cwd,
      argv: argvFor("stubborn-child", pidFile),
      onUpdate: () => {},
      onPermission: async () => null,
    });
    // Written synchronously at the fake agent's module load, well before
    // initialize()/newSession() (awaited inside startSession) could return.
    const grandchildPid = Number((await readFile(pidFile, "utf8")).trim());
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
    assert.ok(isAlive(grandchildPid), "grandchild should be running before close()");

    const start = Date.now();
    await session.close();
    assert.ok(Date.now() - start < 3000, "close() must not hang");
    // Polled rather than asserted immediately: close() returning only means
    // SIGKILL was sent and conn.closed settled, not that the kernel has
    // finished reaping the grandchild — a zombie can still answer
    // process.kill(pid, 0) as "alive" for a brief window. Failed once during
    // the review sweep on an immediate assertion here.
    assert.ok(
      await waitUntilDead(grandchildPid, 2000),
      "close() must kill the grandchild too, not just its immediate child",
    );
  },
);

test("close() twice does not throw", async (t) => {
  const cwd = await newRepo(t);
  const session = await startSession({
    cwd,
    argv: argvFor("updates"),
    onUpdate: () => {},
    onPermission: async () => null,
  });

  await session.prompt("go");
  await session.close();
  await session.close();
});

test("scrubs CLAUDECODE and CLAUDE_CODE_SSE_PORT from the child env", async (t) => {
  const cwd = await newRepo(t);
  const prevClaudeCode = process.env.CLAUDECODE;
  const prevSsePort = process.env.CLAUDE_CODE_SSE_PORT;
  process.env.CLAUDECODE = "1";
  process.env.CLAUDE_CODE_SSE_PORT = "12345";
  t.after(() => {
    if (prevClaudeCode === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = prevClaudeCode;
    if (prevSsePort === undefined) delete process.env.CLAUDE_CODE_SSE_PORT;
    else process.env.CLAUDE_CODE_SSE_PORT = prevSsePort;
  });

  const updates: AgentUpdate[] = [];
  const session = await startSession({
    cwd,
    argv: argvFor("env-check"),
    onUpdate: (u) => updates.push(u),
    onPermission: async () => null,
  });
  t.after(() => session.close());

  await session.prompt("go");

  const seen = JSON.parse(updates[0]?.text ?? "{}");
  assert.equal(seen.claudecode, null);
  assert.equal(seen.ssePort, null);
});

// C4: startup failure must reject startSession() instead of hanging forever
// or crashing the whole process, on each of the three ways it can happen.
test("startSession rejects instead of hanging when the binary does not exist (spawn ENOENT)", async (t) => {
  const cwd = await newRepo(t);
  const start = Date.now();
  await assert.rejects(
    startSession({
      cwd,
      argv: ["/definitely/not/a/real/binary-xyz"],
      onUpdate: () => {},
      onPermission: async () => null,
    }),
  );
  assert.ok(Date.now() - start < 3000, "must reject promptly, not hang");
});

test("startSession rejects when the adapter exits before ever answering initialize", async (t) => {
  const cwd = await newRepo(t);
  await assert.rejects(
    startSession({
      cwd,
      argv: argvFor("exit-immediately"),
      onUpdate: () => {},
      onPermission: async () => null,
    }),
  );
});

test("startSession rejects via its startup timeout when the adapter hangs during initialize, and kills it rather than leaking it", async (t) => {
  const cwd = await newRepo(t);
  const pidFile = join(cwd, "hung.pid");
  const start = Date.now();
  await assert.rejects(
    startSession({
      cwd,
      argv: argvFor("hang-init", pidFile),
      startupTimeoutMs: 200,
      onUpdate: () => {},
      onPermission: async () => null,
    }),
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `should fail close to the 200ms startup timeout, took ${elapsed}ms`);

  const hungPid = Number((await readFile(pidFile, "utf8")).trim());
  assert.ok(Number.isInteger(hungPid) && hungPid > 0);
  assert.ok(
    await waitUntilDead(hungPid, 2000),
    "a startup failure must kill the child, not leave it running as an orphan",
  );
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Polls rather than asserting immediately after an action that only
// guarantees a kill signal was sent: process.kill(pid, 0) can still report a
// just-killed process as "alive" for a brief window while the kernel
// finishes reaping it.
async function waitUntilDead(pid: number, deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}
