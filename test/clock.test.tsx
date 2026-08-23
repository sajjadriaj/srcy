import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { eastAsianWidth } from "get-east-asian-width";
import { render } from "ink-testing-library";
import { ChecksPane, gauge, tokens } from "../src/cockpit.js";
import { newRepo } from "./helpers.js";

test("gauge never shows a used window as empty or an unfull one as full", () => {
  // Both ends are decisions the reader acts on: "nothing used yet" and
  // "no room left" must never appear when neither is true.
  assert.equal(gauge(0, 200_000, 10), "▯".repeat(10));
  assert.equal(gauge(1, 200_000, 10), "▮" + "▯".repeat(9));
  assert.equal(gauge(199_999, 200_000, 10), "▮".repeat(9) + "▯");
  assert.equal(gauge(200_000, 200_000, 10), "▮".repeat(10));
  assert.equal(gauge(100_000, 200_000, 10), "▮".repeat(5) + "▯".repeat(5));
  // A size we were never told is not a full window and not an empty one.
  assert.equal(gauge(10, 0, 10), "");
});

test("CHECKS says nothing before it has run, and speaks up once it has", () => {
  // "none configured" before ever looking is a claim about the project we
  // have not earned — the same class of lie as showing a pass.
  assert.equal((render(<ChecksPane result={undefined} running={false} />).lastFrame() ?? "").trim(), "");
  assert.match(render(<ChecksPane result={null} running={false} />).lastFrame() ?? "", /none configured/);
});

const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("CHECKS scopes to the file the map cursor is on, past the global cap", () => {
  const problems = Array.from({ length: 6 }, (_, i) => ({
    path: i % 2 === 0 ? "a.ts" : "b.ts",
    line: i + 1,
    message: `problem ${i + 1}`,
  }));
  const result = { ok: false, command: "npm test", problems, tail: "" };

  const global = render(<ChecksPane result={result} running={false} />).lastFrame() ?? "";
  // The global list is capped, so some failures are unreachable from it.
  assert.match(global, /…and 2 more/, global);
  assert.doesNotMatch(global, /problem 6/, global);

  const scoped = render(<ChecksPane result={result} running={false} focus="b.ts" />).lastFrame() ?? "";
  assert.match(scoped, /CHECKS {2}b\.ts {2}✖ 3/, scoped);
  // Every one of that file's failures, including the ones the cap cut —
  // moving the cursor is the way out of "…and N more".
  assert.match(scoped, /problem 6/, scoped);
  assert.doesNotMatch(scoped, /problem 1$/m, scoped);
  // The path is in the header, so the rows do not repeat it.
  assert.doesNotMatch(scoped, /✖ b\.ts:/, scoped);
});

test("a cursor on a file with nothing wrong leaves the global list alone", () => {
  // Scoping to an empty result would blank the pane and hide failures that
  // are still there — the cursor moved, the build did not get better.
  const result = {
    ok: false,
    command: "npm test",
    problems: [{ path: "a.ts", line: 1, message: "boom" }],
    tail: "",
  };
  const frame = render(<ChecksPane result={result} running={false} focus="clean.ts" />).lastFrame() ?? "";
  assert.match(frame, /a\.ts:1 {2}boom/, frame);
});
