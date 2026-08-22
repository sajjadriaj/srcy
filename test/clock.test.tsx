import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import React from "react";
import { eastAsianWidth } from "get-east-asian-width";
import { render } from "ink-testing-library";
import type { AgentSession } from "../src/acp.js";
import { ChecksPane, densityBar, dur, gauge, money, Outline, tokens, UsageBar } from "../src/cockpit.js";
import { RepoMap } from "../src/cockpit.js";
import type { Worktree } from "../src/git.js";
import { App } from "../src/ui.js";
import { newRepo } from "./helpers.js";

test("dur keeps a decimal where it changes the meaning and drops it where it doesn't", () => {
  // Under ten seconds the decimal is the whole signal: 0.2s is a cache hit,
  // 4.1s is a real call. Past a minute nobody reads the seconds.
  assert.equal(dur(180), "0.2s");
  assert.equal(dur(4100), "4.1s");
  assert.equal(dur(9999), "10.0s");
  assert.equal(dur(12_400), "12s");
  assert.equal(dur(59_400), "59s");
  assert.equal(dur(63_000), "1m03s");
  assert.equal(dur(605_000), "10m05s");
  // A clock that has not started yet must not render a negative time.
  assert.equal(dur(-5_000_000), "0.0s");
});

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

test("tokens and money round to what someone actually reads", () => {
  assert.equal(tokens(940), "940");
  assert.equal(tokens(1234), "1.2k");
  assert.equal(tokens(104_800), "105k");
  assert.equal(tokens(1_250_000), "1.3M");
  assert.equal(money(0.41, "USD"), "$0.41");
  // A fraction of a cent still has to read as more than zero.
  assert.equal(money(0.004, "USD"), "$0.004");
  // The currency is whatever the agent said it was.
  assert.equal(money(3, "EUR"), "EUR 3.00");
});

test("UsageBar renders nothing at all when the adapter never reported usage", () => {
  // An unmeasured window drawn as an empty one reads as "plenty of room".
  const { lastFrame } = render(<UsageBar usage={null} />);
  assert.equal((lastFrame() ?? "").trim(), "");
});

test("UsageBar shows fill, counts and cost when it has them", () => {
  const { lastFrame } = render(<UsageBar usage={{ used: 104_800, size: 200_000, cost: { amount: 0.41, currency: "USD" } }} />);
  const frame = lastFrame() ?? "";
  assert.match(frame, /CONTEXT/);
  assert.match(frame, /52%/);
  assert.match(frame, /105k\/200k/);
  assert.match(frame, /\$0\.41/);
});

test("the repo map legend names only markers that are on screen", () => {
  const wroteOnly = render(
    <RepoMap entries={[{ path: "a.ts", touch: "wrote", added: 1, removed: 0, problems: 0 }]} />,
  ).lastFrame();
  assert.match(wroteOnly ?? "", /▪ wrote/);
  // Nothing is failing, so a "✖ failing" key teaches the reader to hunt for
  // a marker that isn't there.
  assert.doesNotMatch(wroteOnly ?? "", /failing/);
  assert.doesNotMatch(wroteOnly ?? "", /▫ read/);

  const failing = render(
    <RepoMap entries={[{ path: "a.ts", touch: "wrote", added: 1, removed: 0, problems: 2 }]} />,
  ).lastFrame();
  assert.match(failing ?? "", /✖ failing/);
});

test("every glyph the panes draw is one cell wide in every terminal", () => {
  // ● ○ ▶ █ are East-Asian *Ambiguous*: a terminal configured
  // ambiguous-width=double renders them two cells. ✖ is Neutral, so mixing
  // the two in one column puts a failing row a cell off from every other
  // row — inside a fixed-width box, which tears the border. The gauge is
  // worse: mixing an Ambiguous fill with a Neutral empty changes the bar's
  // length as it fills, sliding the percentage beside it.
  const frames = [
    render(
      <RepoMap
        entries={[
          { path: "a.ts", touch: "wrote", added: 1, removed: 0, problems: 0 },
          { path: "b.ts", touch: "read", added: 0, removed: 0, problems: 0 },
          { path: "c.ts", touch: "wrote", added: 1, removed: 1, problems: 2 },
        ]}
        cursor={0}
      />,
    ).lastFrame(),
    render(<UsageBar usage={{ used: 104_800, size: 200_000 }} />).lastFrame(),
    // The density ramp was the last Ambiguous run left: ▁▂▃…█ mixed with a
    // Neutral empty bucket tears the bar the same way it tore the gauge.
    render(
      <Outline entries={[{ func: "verify()", added: 2, removed: 1 }]} bar={densityBar([2, 3, 9], 12, 8)} />,
    ).lastFrame(),
    render(
      <ChecksPane
        result={{ ok: false, command: "npm test", problems: [{ path: "a.ts", line: 4, message: "boom" }], tail: "" }}
        running={false}
      />,
    ).lastFrame(),
  ];
  for (const frame of frames) {
    for (const ch of frame ?? "") {
      const width = eastAsianWidth(ch.codePointAt(0)!, { ambiguousAsWide: true });
      assert.equal(width, 1, `${JSON.stringify(ch)} (U+${ch.codePointAt(0)!.toString(16)}) is not one cell wide:\n${frame}`);
    }
  }
});

test("CHECKS says nothing before it has run, and speaks up once it has", () => {
  // "none configured" before ever looking is a claim about the project we
  // have not earned — the same class of lie as showing a pass.
  assert.equal((render(<ChecksPane result={undefined} running={false} />).lastFrame() ?? "").trim(), "");
  assert.match(render(<ChecksPane result={null} running={false} />).lastFrame() ?? "", /none configured/);
});

const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("a failed tool call reads as failed, and the one still running reads as running", async (t) => {
  const repo = await newRepo(t);
  const worktree = { path: repo, repo, diff: async () => "" } as unknown as Worktree;
  const bridge = new EventEmitter();
  // A turn that stays in flight for the length of the test, which is the
  // only state in which "still running" means anything.
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
  stdin.write("go");
  await settle(80);
  stdin.write("\r");
  await settle(80);

  const up = (u: Record<string, unknown>): boolean => bridge.emit("update", { raw: u, ...u });
  up({ kind: "tool_call", toolCallId: "1", toolKind: "execute", toolTitle: "Bash", toolPath: "npm test" });
  up({ kind: "tool_call", toolCallId: "2", toolKind: "execute", toolTitle: "Bash", toolPath: "npm run lint" });
  up({ kind: "tool_call", toolCallId: "3", toolKind: "read", toolTitle: "Read", toolPath: "a.txt" });
  up({ kind: "tool_call_update", toolCallId: "1", toolStatus: "failed" });
  up({ kind: "tool_call_update", toolCallId: "3", toolStatus: "completed" });
  await settle(1200); // past one tick of the turn clock

  const frame = lastFrame() ?? "";
  assert.match(frame, /✖ Execute {2}npm test/, `failed tool not marked:\n${frame}`);
  // The unfinished one carries the in-flight marker and a live duration —
  // without both it is indistinguishable from the finished line above it.
  assert.match(frame, /⟳ Execute {2}npm run lint {2}\d+\.\ds/, `in-flight tool not marked:\n${frame}`);
  // A tool that reported completion stops its own clock, even though the
  // turn around it is still going — otherwise every finished line keeps
  // ticking and the in-flight marker means nothing.
  assert.match(frame, /▸ Read {2}a\.txt {2}/, `completed tool still shown as running:\n${frame}`);
  // And the header says how long the turn itself has been going.
  assert.match(frame, /running \d+\.\ds/, `turn clock missing:\n${frame}`);
});

test("the context gauge appears in the cockpit only after a usage update arrives", async (t) => {
  const repo = await newRepo(t);
  const worktree = { path: repo, repo, diff: async () => "" } as unknown as Worktree;
  const bridge = new EventEmitter();
  const session = {
    sessionId: "s1",
    prompt: async () => "",
    cancel: async () => {},
    close: async () => {},
  } as unknown as AgentSession;

  const { lastFrame, unmount } = render(
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
  assert.doesNotMatch(lastFrame() ?? "", /CONTEXT/);

  bridge.emit("update", {
    kind: "usage_update",
    usage: { used: 50_000, size: 200_000 },
    raw: {},
  });
  await settle(80);
  const frame = lastFrame() ?? "";
  assert.match(frame, /CONTEXT/);
  assert.match(frame, /25%/);
  // No cost was reported, so none is invented.
  assert.doesNotMatch(frame, /\$/);
});

test("a failing file spends its count column on the failures, not the churn", () => {
  const frame =
    render(
      <RepoMap entries={[{ path: "token.ts", touch: "wrote", added: 1, removed: 1, problems: 2 }]} />,
    ).lastFrame() ?? "";
  // "+1 -1" is not what a reader does anything about when the file no longer
  // compiles, and the count is what makes the pane below a detail view
  // rather than a second copy of this row.
  assert.match(frame, /✖ {2}token\.ts.*✖2/, frame);
  assert.doesNotMatch(frame, /\+1 -1/, frame);
});

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
