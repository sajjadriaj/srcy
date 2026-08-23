import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import type { AgentSession } from "../src/acp.js";
import { UsageBar } from "../src/cockpit.js";
import type { Worktree } from "../src/git.js";
import { App } from "../src/ui.js";
import { parseUsage, projectDir, transcriptUsage } from "../src/usage.js";
import { newRepo } from "./helpers.js";

// One assistant record, shaped the way Claude Code writes them.
function rec(
  usage: Record<string, number>,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "assistant",
    ...extra,
    message: { role: "assistant", model: "claude-opus-5", usage },
  });
}

const TURN_ONE = { input_tokens: 2, cache_creation_input_tokens: 17_255, cache_read_input_tokens: 24_217, output_tokens: 923 };
const TURN_TWO = { input_tokens: 2, cache_creation_input_tokens: 606, cache_read_input_tokens: 94_223, output_tokens: 1269 };

test("occupancy is the last request's, not the sum of every request's", () => {
  // Each record describes one API call. Summing them would climb past the
  // window size within a few turns and read as a session permanently at
  // 100% — the number every caching agent would produce.
  const u = parseUsage([rec(TURN_ONE), rec(TURN_TWO)].join("\n"));
  assert.equal(u?.used, 2 + 606 + 94_223);
  // Output is the one total that genuinely accumulates: it is what the
  // agent has written, and none of it goes away.
  assert.equal(u?.output, 923 + 1269);
  assert.equal(Math.round((u?.cached ?? 0) * 100), 99);
});

test("a subagent's context does not move the gauge, but its output still counts", () => {
  // Sidechains run in their own window and land in the same file. Letting
  // one set `used` makes the gauge jump to a stranger's context and back,
  // which reads as the agent's own window emptying itself.
  const withSide = parseUsage(
    [
      rec(TURN_ONE),
      rec({ input_tokens: 1, cache_creation_input_tokens: 400, cache_read_input_tokens: 3_000, output_tokens: 77 }, { isSidechain: true }),
    ].join("\n"),
  );
  assert.equal(withSide?.used, 2 + 17_255 + 24_217);
  assert.equal(withSide?.output, 923 + 77);
});

test("a transcript with nothing to measure reports nothing, never a zero", () => {
  // Same contract as the ACP path: an unmeasured window must render blank,
  // because an empty gauge reads as "plenty of room".
  assert.equal(parseUsage(""), null);
  assert.equal(parseUsage('{"type":"user","message":{"role":"user"}}'), null);
  // The agent is still writing, so the last line is routinely half-written.
  assert.equal(parseUsage([rec(TURN_ONE), '{"type":"assis'].join("\n"))?.used, 2 + 17_255 + 24_217);
});

test("a window already past 200k is proof of the larger one", () => {
  // The transcript never says how big the window is. Guessing 200k for a
  // session that has plainly exceeded it would paint it as permanently
  // full — the one reading that changes what a user does next.
  assert.equal(parseUsage(rec({ ...TURN_ONE, cache_read_input_tokens: 24_217 }))?.size, 200_000);
  assert.equal(parseUsage(rec({ ...TURN_ONE, cache_read_input_tokens: 400_000 }))?.size, 1_000_000);
});

test("the transcript directory is named the way Claude Code names it", () => {
  // Every non-alphanumeric character becomes a dash, so a worktree under
  // .ctui/wt lands in a directory with a doubled dash where the dot was.
  assert.match(projectDir("/home/u/p/.ctui/wt/s1"), /projects\/-home-u-p--ctui-wt-s1$/);
});

test("a transcript from before this run is not read as this run's", async (t) => {
  const dir = await newRepo(t);
  const stale = join(dir, "stale.jsonl");
  await writeFile(stale, rec(TURN_ONE), "utf8");
  const since = Date.now();
  // Left in place, an earlier session's totals put a number on screen about
  // work the reader never started.
  await utimes(stale, new Date(since - 60_000), new Date(since - 60_000));
  assert.equal(await transcriptUsage(dir, since, dir), null);

  const live = join(dir, "live.jsonl");
  await writeFile(live, rec(TURN_TWO), "utf8");
  assert.equal((await transcriptUsage(dir, since, dir))?.used, 2 + 606 + 94_223);
});

test("a directory with no transcript at all is not an error", async (t) => {
  const dir = await newRepo(t);
  assert.equal(await transcriptUsage(dir, 0, join(dir, "nope")), null);
});

test("the gauge shows output and cache only when something measured them", () => {
  // The agent's own usage_update has no field for either, so a gauge fed by
  // ACP must not grow columns it cannot fill.
  const acp = render(<UsageBar usage={{ used: 100_000, size: 200_000 }} />).lastFrame() ?? "";
  assert.match(acp, /50%/);
  assert.doesNotMatch(acp, /out |cache /, acp);

  const local = render(<UsageBar usage={{ used: 94_831, size: 200_000, output: 2192, cached: 94_223 / 94_831 }} />).lastFrame() ?? "";
  assert.match(local, /out 2\.2k/, local);
  assert.match(local, /cache 99%/, local);
});

const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("a finished turn fills the gauge from the transcript the agent left on disk", async (t) => {
  const repo = await newRepo(t);
  const worktree = { path: repo, repo, diff: async () => "" } as unknown as Worktree;
  const bridge = new EventEmitter();
  // A turn that ends, because the read happens when the turn does.
  const session = {
    sessionId: "s1",
    prompt: async () => "end_turn",
    cancel: async () => {},
    close: async () => {},
  } as unknown as AgentSession;

  const { stdin, lastFrame, unmount } = render(
    <App
      branch="ctui/s1"
      session={session}
      bridge={bridge}
      worktree={worktree}
      initialMode="default"
      modeDegraded={false}
      explain={false}
      onExit={() => {}}
    />,
  );
  t.after(() => unmount());

  await settle(80);
  // Nothing has run yet, and the default adapter never sends usage_update at
  // all — so without the transcript this row stays blank for the whole
  // session, which is what it did before this path existed.
  assert.doesNotMatch(lastFrame() ?? "", /CONTEXT/);

  // Written where the real agent writes it: the path is derived from the
  // worktree exactly as Claude Code derives it, so this test fails if that
  // naming rule is ever wrong.
  const dir = projectDir(repo);
  await mkdir(dir, { recursive: true });
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(dir, "s1.jsonl"), [rec(TURN_ONE), rec(TURN_TWO)].join("\n"), "utf8");

  stdin.write("go");
  await settle(80);
  stdin.write("\r");
  await settle(400);

  const frame = lastFrame() ?? "";
  assert.match(frame, /CONTEXT/, frame);
  assert.match(frame, /95k\/200k/, frame);
  assert.match(frame, /out 2\.2k/, frame);
  assert.match(frame, /cache 99%/, frame);
});

test("the agent's own number wins, and the transcript never overwrites it", async (t) => {
  const repo = await newRepo(t);
  const worktree = { path: repo, repo, diff: async () => "" } as unknown as Worktree;
  const bridge = new EventEmitter();
  const session = {
    sessionId: "s1",
    prompt: async () => "end_turn",
    cancel: async () => {},
    close: async () => {},
  } as unknown as AgentSession;

  const { stdin, lastFrame, unmount } = render(
    <App
      branch="ctui/s1"
      session={session}
      bridge={bridge}
      worktree={worktree}
      initialMode="default"
      modeDegraded={false}
      explain={false}
      onExit={() => {}}
    />,
  );
  t.after(() => unmount());
  await settle(80);

  const dir = projectDir(repo);
  await mkdir(dir, { recursive: true });
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(dir, "s1.jsonl"), rec(TURN_TWO), "utf8");

  // An adapter that does report usage is reporting the window it is actually
  // managing, which the transcript can only approximate. Once it speaks, the
  // fallback has to stay quiet — two sources fighting over one row would
  // make the gauge flicker between them every turn.
  bridge.emit("update", { kind: "usage_update", usage: { used: 20_000, size: 200_000 }, raw: {} });
  await settle(80);

  stdin.write("go");
  await settle(80);
  stdin.write("\r");
  await settle(400);

  const frame = lastFrame() ?? "";
  assert.match(frame, /20k\/200k/, frame);
  assert.doesNotMatch(frame, /95k/, frame);
  assert.doesNotMatch(frame, /cache /, frame);
});

test("the gauge moves during a turn, not only once it is over", async (t) => {
  const repo = await newRepo(t);
  const worktree = { path: repo, repo, diff: async () => "" } as unknown as Worktree;
  const bridge = new EventEmitter();
  // A turn that never ends, which is the only state in which "during the
  // turn" means anything. A gauge that waits for the turn cannot answer the
  // question anyone asks of it — whether this turn is about to fill the
  // window — because that answer would arrive after the turn did.
  const session = {
    sessionId: "s1",
    prompt: () => new Promise<string>(() => {}),
    cancel: async () => {},
    close: async () => {},
  } as unknown as AgentSession;

  const { stdin, lastFrame, unmount } = render(
    <App
      branch="ctui/s1"
      session={session}
      bridge={bridge}
      worktree={worktree}
      initialMode="default"
      modeDegraded={false}
      explain={false}
      onExit={() => {}}
    />,
  );
  t.after(() => unmount());
  await settle(80);

  const dir = projectDir(repo);
  await mkdir(dir, { recursive: true });
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(join(dir, "s1.jsonl"), [rec(TURN_ONE), rec(TURN_TWO)].join("\n"), "utf8");

  stdin.write("go");
  await settle(80);
  stdin.write("\r");
  await settle(2600);

  const frame = lastFrame() ?? "";
  assert.match(frame, /running \d/, `turn already over — this test proves nothing:\n${frame}`);
  assert.match(frame, /CONTEXT/, frame);
  assert.match(frame, /95k\/200k/, frame);
});
