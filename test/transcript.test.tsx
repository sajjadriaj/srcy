import assert from "node:assert/strict";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { parseState, parseUsage, projectDir } from "../src/transcript.js";
import { foldLine as codexFold } from "../src/codex.js";
import { emptyFold, stateOf } from "../src/transcript.js";
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
  // .srcy/wt lands in a directory with a doubled dash where the dot was.
  assert.match(projectDir("/home/u/p/.srcy/wt/s1"), /projects\/-home-u-p--srcy-wt-s1$/);
});


// One user record and one tool call, shaped the way Claude Code writes them.
function said(text: unknown, at: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "user", timestamp: at, ...extra, message: { role: "user", content: text } });
}

function called(name: string, at: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: at,
    message: { role: "assistant", content: [{ type: "tool_use", id: `t-${name}`, name, input: { file_path: "a.ts" } }] },
  });
}

test("the turn is what the reader typed, not everything shaped like a user record", () => {
  const s = parseState(
    [
      said("first request", "2026-08-25T10:00:00.000Z"),
      // A tool result is a user record too — that is how the transcript
      // carries it — and so is anything the CLI injects, which arrives
      // wrapped in a tag. Neither is a request.
      said([{ type: "tool_result", tool_use_id: "t-Read", content: "..." }], "2026-08-25T10:00:01.000Z"),
      said("<system-reminder>be good</system-reminder>", "2026-08-25T10:00:02.000Z"),
      said("second request", "2026-08-25T10:00:03.000Z"),
      // A subagent's turn is not the session's turn.
      said("a subagent's brief", "2026-08-25T10:00:04.000Z", { isSidechain: true }),
    ].join("\n"),
  );
  assert.equal(s.turn?.text, "second request");
  assert.equal(s.turn?.at, Date.parse("2026-08-25T10:00:03.000Z"));
});

test("a read is not a write, and an unknown tool is", () => {
  // The asymmetry is the point: a baseline that quietly contains half the
  // agent's work hides the change the reader opened it to see.
  const read = parseState([said("go", "2026-08-25T10:00:00.000Z"), called("Read", "2026-08-25T10:00:01.000Z")].join("\n"));
  assert.equal(read.wrote, undefined);

  const wrote = parseState([said("go", "2026-08-25T10:00:00.000Z"), called("Edit", "2026-08-25T10:00:02.000Z")].join("\n"));
  assert.equal(wrote.wrote, Date.parse("2026-08-25T10:00:02.000Z"));

  const mcp = parseState([called("mcp__something__do", "2026-08-25T10:00:03.000Z")].join("\n"));
  assert.equal(mcp.wrote, Date.parse("2026-08-25T10:00:03.000Z"));
});

test("Codex's request and its writes read the same way", () => {
  const f = emptyFold();
  const line = (payload: unknown, at: string): string => JSON.stringify({ timestamp: at, payload });
  for (const l of [
    // Codex opens every session by injecting the environment as a user turn.
    line({ type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }] }, "2026-08-25T10:00:00.000Z"),
    line({ type: "message", role: "user", content: [{ type: "input_text", text: "make it green" }] }, "2026-08-25T10:00:01.000Z"),
    line({ type: "function_call", call_id: "c1", name: "update_plan", arguments: "{}" }, "2026-08-25T10:00:02.000Z"),
    line({ type: "function_call", call_id: "c2", name: "shell", arguments: '{"command":["ls"]}' }, "2026-08-25T10:00:03.000Z"),
  ]) {
    codexFold(f, l);
  }
  const s = stateOf(f);
  assert.equal(s.turn?.text, "make it green");
  assert.equal(s.wrote, Date.parse("2026-08-25T10:00:03.000Z"));
});
