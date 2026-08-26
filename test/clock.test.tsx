import assert from "node:assert/strict";
import test from "node:test";
import { gauge, tokens } from "../src/cockpit.js";

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

test("tokens abbreviates to the precision anyone reads", () => {
  // Under ten thousand the decimal is the signal; past a million nobody
  // reads the digits, they read "this session is enormous".
  assert.equal(tokens(999), "999");
  assert.equal(tokens(9_400), "9.4k");
  assert.equal(tokens(94_600), "95k");
  assert.equal(tokens(1_250_000), "1.3M");
});
