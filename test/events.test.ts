import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { MAX_EVENT_BYTES, listen, parseEvent, send, socketPath, type ExternalEvent } from "../src/events.js";
import { emit, line, sourceAttention } from "../src/status.js";
import { readEvents, type SrcyEvent } from "../src/state.js";
import { newRepo } from "./helpers.js";

const ev = (over: Partial<ExternalEvent> = {}): ExternalEvent => ({
  version: 1,
  source: "proof",
  type: "proof.run.completed",
  ...over,
});

test("only the envelope is validated — the tool's own metadata is nobody's business", () => {
  // A source srcy has never heard of, an event type it has never heard of,
  // and metadata it could not interpret if it wanted to. All valid.
  const odd = parseEvent(JSON.stringify({ version: 1, source: "my-weird-tool", type: "banana.completed", metadata: { anything: true } }));
  assert.equal(odd?.source, "my-weird-tool");
  assert.deepEqual(odd?.metadata, { anything: true });

  // The envelope, and only the envelope.
  assert.equal(parseEvent(JSON.stringify({ source: "p", type: "t" })), null, "version is required");
  assert.equal(parseEvent(JSON.stringify({ version: 1, type: "t" })), null, "source is required");
  assert.equal(parseEvent(JSON.stringify({ version: 1, source: "p" })), null, "type is required");
  assert.equal(parseEvent(JSON.stringify({ version: 1, source: " ", type: "t" })), null);

  // An unknown version is refused rather than read as though it were this
  // one — that is the whole point of versioning the envelope.
  assert.equal(parseEvent(JSON.stringify({ version: 2, source: "p", type: "t" })), null);

  // Never a throw, whatever arrives.
  assert.equal(parseEvent("not json at all"), null);
  assert.equal(parseEvent("[1,2,3]"), null);
  assert.equal(parseEvent("null"), null);
  assert.equal(parseEvent(`{"version":1,"source":"p","type":"t","metadata":${"x".repeat(MAX_EVENT_BYTES)}}`), null);
});

test("a level srcy does not recognise is no level at all", () => {
  // srcy repeats the sender's reading and never invents one: a made-up level
  // is dropped, not rounded to `error`.
  assert.equal(parseEvent(JSON.stringify(ev({ level: "critical" as never })))?.level, undefined);
  assert.equal(parseEvent(JSON.stringify(ev({ level: "error" })))?.level, "error");
  // A sender's own timestamp is kept; a nonsense one is not.
  assert.equal(parseEvent(JSON.stringify(ev({ timestamp: 1789698123000 })))?.timestamp, 1789698123000);
  assert.equal(parseEvent(JSON.stringify(ev({ timestamp: -1 })))?.timestamp, undefined);
});

test("a socket path too long for the kernel falls back, and both sides agree", () => {
  // Linux caps a Unix socket path at 108 bytes, macOS at 104 — short enough
  // that a repo a few directories down overruns it. The sender computes this
  // from the same repo path, so there is nothing to discover.
  const shallow = socketPath("/r");
  assert.equal(shallow, "/r/.srcy/srcy.sock");
  const deep = socketPath(`/${"d".repeat(200)}`);
  assert.ok(deep.length < 100, deep);
  assert.equal(deep, socketPath(`/${"d".repeat(200)}`), "the same repo always resolves to the same socket");
  assert.notEqual(deep, socketPath(`/${"e".repeat(200)}`), "two repos never share one");
});

test("an event crosses the socket, and a malformed one loses only itself", async (t) => {
  const repo = await newRepo(t);
  const got: ExternalEvent[] = [];
  const receiver = await listen(repo, (e) => void got.push(e));
  assert.notEqual(receiver, null);
  t.after(async () => receiver?.close());

  assert.equal(await send(repo, ev({ summary: "Falsification passed", level: "info" })), true);
  await settle();
  assert.equal(got.length, 1);
  assert.equal(got[0]?.summary, "Falsification passed");

  // Two good lines around a bad one, down one connection. Nothing crashes
  // and the good ones arrive: a tool with a bug in its hook must not be able
  // to take the session down with it.
  await raw(repo, [
    JSON.stringify(ev({ type: "a" })),
    "{ this is not json",
    JSON.stringify({ version: 1 }),
    JSON.stringify(ev({ type: "b" })),
  ].join("\n") + "\n");
  await settle();
  assert.deepEqual(got.slice(1).map((e) => e.type), ["a", "b"]);

  // NDJSON's newline separates; a sender that wrote one object and hung up
  // still said something.
  await raw(repo, JSON.stringify(ev({ type: "c" })));
  await settle();
  assert.equal(got[got.length - 1]?.type, "c");
});

test("a second receiver on one repo does not steal the first one's address", async (t) => {
  const repo = await newRepo(t);
  const first = await listen(repo, () => {});
  t.after(async () => first?.close());
  assert.notEqual(first, null);
  // Null is not an error — two rails on one repo happens, and the second
  // simply does not listen.
  assert.equal(await listen(repo, () => {}), null);
});

test("emitting into nothing is not a failure, unless the sender asked for one", async (t) => {
  const repo = await newRepo(t);
  t.mock.method(console, "error", () => {});
  // A tool that breaks because the thing watching it is not running has been
  // coupled to it, which is the one outcome this design exists to prevent.
  assert.equal(await send(repo, ev()), false);
  assert.equal(await emit(repo, ["--source", "proof", "--type", "proof.run.started"]), 0);
  assert.equal(await emit(repo, ["--source", "proof", "--type", "proof.run.started", "--strict"]), 1);
  // A usage mistake is the sender's own, and is worth saying either way.
  assert.equal(await emit(repo, ["--type", "proof.run.started"]), 2);
});

test("emit reaches a listening srcy, from flags and from stdin alike", async (t) => {
  const repo = await newRepo(t);
  const got: ExternalEvent[] = [];
  const receiver = await listen(repo, (e) => void got.push(e));
  t.after(async () => receiver?.close());

  assert.equal(
    await emit(repo, ["--source", "proof", "--type", "proof.falsify.completed", "--level", "info", "--summary", "passed", "--metadata", '{"durationMs":4218}']),
    0,
  );
  await settle();
  assert.equal(got[0]?.summary, "passed");
  assert.deepEqual(got[0]?.metadata, { durationMs: 4218 });
  // Filled in when the sender did not set one, so every event has a time.
  assert.ok((got[0]?.timestamp ?? 0) > 0);

  // Metadata that is not JSON is carried rather than dropped: it is one
  // string the tool wanted kept, and keeping it is all srcy was going to do.
  assert.equal(await emit(repo, ["--source", "p", "--type", "t", "--metadata", "plain words"]), 0);
  await settle();
  assert.deepEqual(got[1]?.metadata, { value: "plain words" });
});

test("what a source said last is what srcy repeats, and it never revises the level", () => {
  const at = (source: string, level: SrcyEvent["level"], summary: string, treeHash?: string): SrcyEvent => ({
    at: 1,
    type: `${source}.x`,
    source,
    ...(level === undefined ? {} : { level }),
    summary,
    ...(treeHash === undefined ? {} : { treeHash }),
  });

  const items = sourceAttention(
    [at("proof", "error", "Found counterexample", "old"), at("bench", "warning", "p99 regressed")],
    "now",
  );
  assert.deepEqual(items.map((i) => [i.severity, i.gate]), [["error", "proof"], ["warning", "bench"]]);
  // The tree it was about is not the tree that is here, and srcy says so
  // without touching the result itself.
  assert.match(items[0]!.detail, /earlier tree/);

  // A source that reported an error and then reported something fine has
  // said the second thing more recently.
  assert.deepEqual(sourceAttention([at("proof", "error", "broke"), at("proof", "info", "fixed")], null), []);
  // A result the sender called `info` is information, whatever its metadata
  // might mean to someone who knew that tool.
  assert.deepEqual(sourceAttention([at("proof", "info", "0 of 40 properties held")], null), []);
  // No level at all is not a finding.
  assert.deepEqual(sourceAttention([at("proof", undefined, "something happened")], null), []);
});

test("the timeline reads srcy's own events and other tools' in one column", () => {
  assert.equal(line({ at: 0, type: "gate.pass", detail: "types  0s" }, null).slice(8), "  gate.pass       types  0s");
  const outside = line({ at: 0, type: "proof.x", source: "proof", level: "error", summary: "Found counterexample", treeHash: "old" }, "now");
  assert.match(outside, / ✗ proof {9}Found counterexample {2}· earlier tree$/);
  // No tree named means nothing claimed about one.
  assert.doesNotMatch(line({ at: 0, type: "proof.x", source: "proof", summary: "done" }, "now"), /earlier tree/);
});

test("an external event lands in the same log srcy writes its own to", async (t) => {
  const repo = await newRepo(t);
  await mkdir(join(repo, ".srcy"), { recursive: true });
  await writeFile(
    join(repo, ".srcy", "events.jsonl"),
    `${JSON.stringify({ at: 1, type: "gate.pass", detail: "types" })}\n${JSON.stringify({ at: 2, type: "proof.run.completed", source: "proof", summary: "done" })}\n`,
  );
  const events = await readEvents(repo);
  assert.equal(events.length, 2);
  assert.equal(events[1]?.source, "proof");
});

// The socket hands an event to the receiver on its own thread of control, so
// a test that asserts straight after a write is racing it.
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 120));
}

async function raw(repo: string, text: string): Promise<void> {
  const { createConnection } = await import("node:net");
  await new Promise<void>((resolve) => {
    const c = createConnection(socketPath(repo));
    c.on("connect", () => c.end(text, () => resolve()));
    c.on("error", () => resolve());
  });
}
