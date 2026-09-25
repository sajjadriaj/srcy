import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PI, findSession, foldLine } from "../src/pi.js";
import { emptyFold, stateOf, usageOf } from "../src/transcript.js";

// Records shaped the way pi writes them: one JSON object per line, every
// message wrapped in `{type: "message", message: {...}}`, the session's
// directory in the first line.
const head = (cwd: string): string => JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-09-24T07:00:19.091Z", cwd });

const at = (s: number): string => `2026-09-24T07:00:${String(s).padStart(2, "0")}.000Z`;

const user = (text: string, when: string): string =>
  JSON.stringify({ type: "message", timestamp: when, message: { role: "user", content: [{ type: "text", text }] } });

const assistant = (
  content: unknown[],
  usage: Record<string, number>,
  stopReason: string,
  when: string,
  model = "ornith-1.5-9b",
): string => JSON.stringify({ type: "message", timestamp: when, message: { role: "assistant", content, usage, stopReason, model } });

const result = (id: string, when: string): string =>
  JSON.stringify({ type: "message", timestamp: when, message: { role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: "ok" }] } });

const USAGE = { input: 100, output: 231, cacheRead: 74_164, cacheWrite: 0, totalTokens: 74_495 };

function fold(lines: string[]): ReturnType<typeof emptyFold> {
  const f = emptyFold();
  for (const l of lines) foldLine(f, l);
  return f;
}

test("pi occupancy is what the last request held, and output is the running sum", () => {
  const f = fold([
    head("/r"),
    assistant([{ type: "text", text: "hi" }], { ...USAGE, cacheRead: 1000 }, "stop", at(1)),
    assistant([{ type: "text", text: "hi" }], USAGE, "stop", at(2)),
  ]);
  const u = usageOf(f);
  assert.equal(u?.used, 100 + 74_164);
  assert.equal(u?.output, 231 * 2);
  assert.equal(Math.round((u?.cached ?? 0) * 100), 100);
  assert.equal(u?.model, "ornith-1.5-9b");
});

test("a pi tool call is in flight until its result lands, and only writes move the baseline", () => {
  const call = (id: string, name: string, args: unknown, when: string): string =>
    assistant([{ type: "toolCall", id, name, arguments: args }], USAGE, "toolUse", when);
  const running = fold([head("/r"), user("go", at(0)), call("c1", "bash", { command: "npm test" }, at(1))]);
  assert.deepEqual(stateOf(running).activity, { tool: "bash", target: "npm test", since: Date.parse(at(1)) });
  assert.equal(stateOf(running).wrote, Date.parse(at(1)));
  assert.equal(stateOf(running).ran.get("npm test"), Date.parse(at(1)));
  // A read is not a write.
  const read = fold([head("/r"), user("go", at(0)), call("c2", "read", { path: "/r/a.ts" }, at(1))]);
  assert.equal(stateOf(read).wrote, undefined);
  assert.equal(stateOf(read).activity?.target, "/r/a.ts");
  const done = fold([head("/r"), call("c1", "bash", { command: "npm test" }, at(1)), result("c1", at(2))]);
  assert.equal(stateOf(done).activity, null);
});

test("pi's turn is the reader's text, and it ends when the model stops", () => {
  const f = fold([
    head("/r"),
    user("fix the expiry", at(0)),
    assistant([{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }], USAGE, "toolUse", at(1)),
    result("c1", at(2)),
    assistant([{ type: "text", text: "Done, tests pass." }], USAGE, "stop", at(3)),
  ]);
  const s = stateOf(f);
  assert.equal(s.turn?.text, "fix the expiry");
  assert.equal(s.turn?.at, Date.parse(at(0)));
  assert.equal(s.ended, Date.parse(at(3)));
  assert.equal(s.reply, "Done, tests pass.");
  // Mid-turn, nothing has ended.
  const mid = fold([head("/r"), user("go", at(0)), assistant([], USAGE, "toolUse", at(1))]);
  assert.equal(stateOf(mid).ended, undefined);
});

test("pi sessions are found by the directory they declare, newest first", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "srcy-pi-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "--r-mine--");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "old.jsonl"), `${head("/r/mine")}\n`);
  await new Promise((r) => setTimeout(r, 20));
  await writeFile(join(dir, "new.jsonl"), `${head("/r/mine")}\n`);
  const other = join(root, "--r-theirs--");
  await mkdir(other, { recursive: true });
  await writeFile(join(other, "s.jsonl"), `${head("/r/theirs")}\n`);
  // A package below the root is this repo's agent.
  const below = join(root, "--r-below-pkg--");
  await mkdir(below, { recursive: true });
  await writeFile(join(below, "s.jsonl"), `${head("/r/below/pkg")}\n`);

  assert.match((await findSession("/r/mine", root)) ?? "", /new\.jsonl$/);
  assert.match((await findSession("/r/theirs", root)) ?? "", /s\.jsonl$/);
  assert.match((await findSession("/r/below", root)) ?? "", /below-pkg--\/s\.jsonl$/);
  assert.equal(await findSession("/r/never", root), null);
  assert.equal(PI.fold, foldLine);
});
