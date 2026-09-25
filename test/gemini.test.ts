import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GEMINI, findSession, parse, projectHash } from "../src/gemini.js";
import { readSession, stateOf, usageOf } from "../src/transcript.js";

// A chat file the way gemini-cli writes one: a single JSON document,
// rewritten whole after every message, under a directory named by the
// sha256 of the project path.
const at = (s: number): string => `2026-09-24T07:00:${String(s).padStart(2, "0")}.000Z`;

const chat = (messages: unknown[]): string =>
  JSON.stringify({ sessionId: "g1", projectHash: "x", startTime: at(0), lastUpdated: at(9), messages });

const user = (text: string, when: string): unknown => ({ id: "u", timestamp: when, type: "user", content: text });

const gemini = (content: string, when: string, extra: Record<string, unknown> = {}): unknown => ({
  id: "g",
  timestamp: when,
  type: "gemini",
  content,
  model: "gemini-2.5-pro",
  tokens: { input: 12_000, output: 300, cached: 9_000, thoughts: 50, tool: 0, total: 12_350 },
  ...extra,
});

test("the project directory is the sha256 of the path, as gemini names it", () => {
  // Checked against a real ~/.gemini/tmp: the directory for /home/u is
  // exactly sha256("/home/u"), no salt and no trailing slash.
  assert.equal(projectHash("/home/u/p"), createHash("sha256").update("/home/u/p").digest("hex"));
  assert.notEqual(projectHash("/home/u/p"), projectHash("/home/u/q"));
});

test("gemini occupancy is the last reply's prompt, against the million-token window it ships with", () => {
  const f = parse(chat([user("go", at(0)), gemini("ok", at(1)), gemini("done", at(2), { tokens: { input: 20_000, output: 10, cached: 5_000, total: 20_010 } })]));
  const u = usageOf(f);
  assert.equal(u?.used, 20_000);
  assert.equal(u?.output, 310);
  assert.equal(Math.round((u?.cached ?? 0) * 100), 25);
  assert.equal(u?.model, "gemini-2.5-pro");
  assert.equal(u?.size, 1_048_576);
});

test("a gemini turn is the reader's text, its tool calls are in flight until they finish, and it ends with the reply", () => {
  const running = parse(
    chat([
      user("fix the expiry", at(0)),
      gemini("", at(1), { toolCalls: [{ id: "t1", name: "run_shell_command", args: { command: "npm test" }, status: "executing" }] }),
    ]),
  );
  const s = stateOf(running);
  assert.equal(s.turn?.text, "fix the expiry");
  assert.deepEqual(s.activity, { tool: "run_shell_command", target: "npm test", since: Date.parse(at(1)) });
  assert.equal(s.wrote, Date.parse(at(1)));
  assert.equal(s.ended, undefined);

  const done = parse(
    chat([
      user("fix the expiry", at(0)),
      gemini("", at(1), { toolCalls: [{ id: "t1", name: "read_file", args: { file_path: "/r/a.ts" }, status: "success" }] }),
      gemini("Done. Tests pass.", at(2)),
    ]),
  );
  const d = stateOf(done);
  assert.equal(d.activity, null);
  assert.equal(d.wrote, undefined, "a read is not a write");
  assert.equal(d.ended, Date.parse(at(2)));
  assert.equal(d.reply, "Done. Tests pass.");

  // Not JSON, or not a chat: no state, never a throw.
  assert.equal(stateOf(parse("{nope")).turn, undefined);
  assert.equal(stateOf(parse("[]")).turn, undefined);
});

test("a rewritten chat file is re-read whole, and the newest one for the project is the session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "srcy-gem-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = "/r/mine";
  const chats = join(root, projectHash(cwd), "chats");
  await mkdir(chats, { recursive: true });
  await writeFile(join(chats, "session-old.json"), chat([user("first", at(0))]));
  await new Promise((r) => setTimeout(r, 20));
  const path = join(chats, "session-new.json");
  await writeFile(path, chat([user("second", at(1))]));
  assert.equal(await findSession(cwd, root), path);
  assert.equal(await findSession("/r/never", root), null);

  // The whole point of `parse` over `fold`: the file is not appended to, it
  // is replaced, so the reader has to start over when it changes.
  const source = { ...GEMINI, find: async (): Promise<string | null> => path };
  const one = await readSession(cwd, source);
  assert.equal(one?.turn?.text, "second");
  await new Promise((r) => setTimeout(r, 20));
  await writeFile(path, chat([user("second", at(1)), gemini("done", at(2)), user("third", at(3))]));
  const two = await readSession(cwd, source);
  assert.equal(two?.turn?.text, "third");
  assert.equal(two?.usage?.used, 12_000);
});
