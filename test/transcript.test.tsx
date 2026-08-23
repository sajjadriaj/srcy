import assert from "node:assert/strict";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { parseUsage, projectDir } from "../src/transcript.js";
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

