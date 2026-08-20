import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/ui.js";
import type { AgentSession, PermissionRequest } from "../src/acp.js";
import { createWorktree, git, type Worktree } from "../src/git.js";
import { newRepo, write } from "./helpers.js";

function fakeSession(): AgentSession {
  return {
    sessionId: "fake-session",
    modes: null,
    prompt: async () => "end_turn",
    cancel: async () => {},
    setMode: async () => {},
    close: async () => {},
  };
}

// A worktree stub for tests that never touch review — Worktree has no
// private fields, so a plain object satisfies its shape structurally.
function fakeWorktree(): Worktree {
  return {
    repo: "/nonexistent/repo",
    path: "/nonexistent/repo/.ctui/wt/s1",
    branch: "ctui/s1",
    base: "0000000000000000000000000000000000000000",
    diff: async () => "",
  } as Worktree;
}

function tick(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ordered like the live adapter (fact from the task brief): allow_always
// first, allow_once second. A client that matched by array position instead
// of option.kind would hand the agent "always allow" on a plain "y".
const liveOrderedOptions: PermissionRequest["options"] = [
  { optionId: "allow_always", kind: "allow_always", name: "Always Allow" },
  { optionId: "allow", kind: "allow_once", name: "Allow" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
];

test("app mounts showing branch and mode, and renders an approval prompt when one is pending", async () => {
  const bridge = new EventEmitter();
  const { lastFrame } = render(
    React.createElement(App, {
      branch: "ctui/s1",
      session: fakeSession(),
      bridge,
      worktree: fakeWorktree(),
      initialMode: "default",
      modeDegraded: false,
      explain: false,
      onExit: () => {},
    }),
  );
  await tick();

  const initial = lastFrame() ?? "";
  assert.match(initial, /ctui\/s1/);
  assert.match(initial, /default mode/);

  bridge.emit(
    "permission",
    { title: "Write file", options: liveOrderedOptions, toolCall: { toolCallId: "tc-1" } } satisfies PermissionRequest,
    () => {},
  );
  await tick();

  const withPrompt = lastFrame() ?? "";
  assert.match(withPrompt, /Write file/);
  assert.match(withPrompt, /\[y\] allow/);
  assert.match(withPrompt, /\[n\] reject/);
});

test("pressing y resolves the approval prompt with the allow_once option's id, not array position 0", async () => {
  const bridge = new EventEmitter();
  const { stdin } = render(
    React.createElement(App, {
      branch: "ctui/s1",
      session: fakeSession(),
      bridge,
      worktree: fakeWorktree(),
      initialMode: "default",
      modeDegraded: false,
      explain: false,
      onExit: () => {},
    }),
  );
  await tick();

  let resolvedWith: string | null | undefined;
  bridge.emit(
    "permission",
    { title: "Write file", options: liveOrderedOptions, toolCall: { toolCallId: "tc-1" } } satisfies PermissionRequest,
    (id: string | null) => {
      resolvedWith = id;
    },
  );
  await tick();

  stdin.write("y");
  await tick();

  assert.equal(resolvedWith, "allow");
});

// The two security-relevant paths for the review gate: the accept key must
// be inert until there is something selected AND an explanation has
// arrived, and the escape hatch (A) must leave a visible, honest trailer
// rather than pretending an explanation exists.

test("a does nothing while the summary is pending, and does nothing with no hunk selected", async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "a.txt", "one\nchanged\n");

  // A prompt() that never resolves on its own, so summaryPending can be
  // observed deterministically instead of racing a real answer.
  // A holder rather than a bare `let`: TypeScript cannot prove the callback
  // below runs before the call site, and narrows a plain variable to null.
  const gate: { resolve?: () => void } = {};
  const promptCalls: string[] = [];
  const session: AgentSession = {
    sessionId: "fake-session",
    modes: null,
    prompt: async (text: string) => {
      promptCalls.push(text);
      await new Promise<void>((resolve) => {
        gate.resolve = resolve;
      });
      return "end_turn";
    },
    cancel: async () => {},
    setMode: async () => {},
    close: async () => {},
  };

  const bridge = new EventEmitter();
  const { stdin, lastFrame } = render(
    React.createElement(App, {
      branch: wt.branch,
      session,
      bridge,
      worktree: wt,
      initialMode: "default",
      modeDegraded: false,
      explain: false,
      onExit: () => {},
    }),
  );
  await tick();

  stdin.write("r"); // open review; fires the explain-gate prompt
  await tick(60);

  assert.match(lastFrame() ?? "", /review/);
  assert.equal(promptCalls.length, 1, "opening review should send the explain prompt exactly once");

  const before = await readFile(join(repo, "a.txt"), "utf8");

  // No hunk selected yet: "a" must refuse, regardless of the summary.
  stdin.write("a");
  await tick();
  assert.match(lastFrame() ?? "", /select at least one hunk/i);

  // Select a hunk, but the explain-gate prompt has still not resolved.
  stdin.write(" ");
  await tick();
  stdin.write("a");
  await tick();
  assert.match(lastFrame() ?? "", /summary/i);

  const afterGate = await readFile(join(repo, "a.txt"), "utf8");
  assert.equal(afterGate, before, "accept must not touch the real repo while the gate is refusing");

  const status = await git(repo, "status", "--porcelain");
  assert.equal(status, "", "nothing should have been staged or committed while gated");

  gate.resolve?.();
  await tick();
});

test("A accepts without a summary and the resulting commit records Ctui-Prompt: <none>", async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "a.txt", "one\nchanged\n");

  const bridge = new EventEmitter();
  const { stdin } = render(
    React.createElement(App, {
      branch: wt.branch,
      session: fakeSession(), // resolves the explain prompt immediately with no text
      bridge,
      worktree: wt,
      initialMode: "default",
      modeDegraded: false,
      explain: false,
      onExit: () => {},
    }),
  );
  await tick();

  stdin.write("r");
  await tick(60);
  stdin.write(" "); // select the only hunk
  await tick();
  stdin.write("A"); // accept unexplained — must not wait on anySummary
  await tick(80);

  const got = await readFile(join(repo, "a.txt"), "utf8");
  assert.equal(got, "one\nchanged\n", "the accepted hunk should have landed in the real repo");

  const msg = await git(repo, "log", "-1", "--format=%B");
  assert.match(msg, /Ctui-Prompt: <none>/, `commit message missing the unexplained marker:\n${msg}`);
  assert.match(msg, new RegExp(`Ctui-Session: ${wt.branch.replace("ctui/", "")}`));

  const trailer = await git(repo, "log", "-1", "--format=%(trailers:key=Ctui-Prompt,valueonly)");
  assert.equal(trailer.trim(), "<none>");
});

// --explain: understanding, not writing. "r" must be refused rather than
// opening review, regardless of whatever the agent left in the worktree.
test("--explain: pressing r does not open review, and the status line says so", async () => {
  const bridge = new EventEmitter();
  const { stdin, lastFrame } = render(
    React.createElement(App, {
      branch: "ctui/why1",
      session: fakeSession(),
      bridge,
      worktree: fakeWorktree(),
      initialMode: "default",
      modeDegraded: false,
      explain: true,
      onExit: () => {},
    }),
  );
  await tick();

  const initial = lastFrame() ?? "";
  assert.match(initial, /ctui\/why1 · explain · nothing is kept/);

  stdin.write("r");
  await tick();

  const after = lastFrame() ?? "";
  assert.match(after, /explain session — nothing to accept/);
  assert.ok(!after.includes("[space] select"), "review pane must not have opened in an explain session");

  // The refused "r" still reaches TextInput (it's still focused), the same
  // quirk closeReview() works around for a real review — but there's no
  // review-close cycle to piggyback the cleanup on here, so it needs its
  // own cleanup. Left unfixed, this "r" prefixes whatever gets typed next.
  await tick();
  const afterCleanup = lastFrame() ?? "";
  assert.ok(!afterCleanup.includes("> r"), `stray "r" leaked into the input box:\n${afterCleanup}`);
});
