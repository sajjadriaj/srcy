import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { App, splitSummary } from "../src/ui.js";
import type { AgentSession, AgentUpdate, PermissionRequest } from "../src/acp.js";
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

// splitSummary derives the commit subject from the explain-gate answer.
// Live-verification finding: the explain prompt asks for plain prose but
// the agent routinely answers in a bolded, numbered structure anyway, and
// the old implementation let that markdown straight through, truncated mid-
// word, and duplicated the (mangled) subject as the body's first line. Each
// case here asserts the subject carries none of `*`, `#`, or a backtick, and
// that a capped subject was cut on a word boundary, not mid-word.
const splitSummaryCases: Array<{ name: string; input: string; wantSubject: string; wantBody: string }> = [
  {
    name: "bold prefix",
    input: "**What and why:** I added JSDoc comments to add() and multiply().",
    wantSubject: "What and why: I added JSDoc comments to add() and multiply()",
    wantBody: "",
  },
  {
    name: "numbered bold prefix",
    input: "1. **What and why:** I added helpful comments. 2. **What could break:** Nothing.",
    wantSubject: "What and why: I added helpful comments",
    wantBody: "2. What could break: Nothing.",
  },
  {
    name: "plain sentence",
    input: "Fixed a bug in the parser.",
    wantSubject: "Fixed a bug in the parser",
    wantBody: "",
  },
  {
    name: "no terminator",
    input: "I refactored the auth module to use async validators",
    wantSubject: "I refactored the auth module to use async validators",
    wantBody: "",
  },
  {
    name: "shorter than cap",
    input: "Fix typo.",
    wantSubject: "Fix typo",
    wantBody: "",
  },
  {
    name: "first sentence exceeds the cap",
    input:
      "This is a very long explanatory sentence that goes on and on describing many details about the change made here and does not stop for quite a while.",
    wantSubject: "This is a very long explanatory sentence that goes on and on...",
    wantBody: "",
  },
  {
    // Verbatim from the live run this bug was found in (see FIX 2 report):
    // `git log --oneline` showed
    //   b2b97c3 **What and why:** I added JSDoc comments above the `add()` and `multi...`
    name: "verbatim live-run string",
    input: "**What and why:** I added JSDoc comments above the `add()` and `multi...`",
    wantSubject: "What and why: I added JSDoc comments above the add() and multi...",
    wantBody: "",
  },
];

test("splitSummary derives a clean commit subject from the agent's markdown answer", () => {
  for (const { name, input, wantSubject, wantBody } of splitSummaryCases) {
    const { subject, body } = splitSummary(input);
    assert.equal(subject, wantSubject, `[${name}] subject`);
    assert.equal(body, wantBody, `[${name}] body`);
    assert.ok(!/[*#`]/.test(subject), `[${name}] markdown syntax survived into subject: ${JSON.stringify(subject)}`);
    assert.ok(subject.length <= 72, `[${name}] subject exceeds the cap: ${JSON.stringify(subject)}`);
  }
});

test("splitSummary caps a long subject on a word boundary, not mid-word", () => {
  const { subject } = splitSummary(splitSummaryCases[5]!.input);
  assert.ok(subject.endsWith("..."), `expected an ellipsis, got: ${JSON.stringify(subject)}`);
  const withoutEllipsis = subject.slice(0, -3);
  const nextWord = splitSummaryCases[5]!.input.slice(withoutEllipsis.length).trimStart();
  // A word-boundary cut means the character right after where we stopped is
  // whitespace (or the string simply ended) — never the middle of a word
  // that continues in the source.
  assert.ok(
    withoutEllipsis === "" || splitSummaryCases[5]!.input[withoutEllipsis.length] === " " || nextWord === "",
    `subject was cut mid-word: ${JSON.stringify(subject)}`,
  );
});

test("splitSummary treats empty and whitespace-only input the same, with no body", () => {
  for (const input of ["", "   \n  "]) {
    const { subject, body } = splitSummary(input);
    assert.equal(subject, "ctui: accept unexplained change");
    assert.equal(body, "");
  }
});

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
  // "worktree discarded on exit", not "nothing is kept": the agent can
  // still run `git push` or write outside the worktree during an explain
  // session, so an unqualified "nothing is kept" overstates the guarantee.
  assert.match(initial, /ctui\/why1 · explain · worktree discarded on exit/);

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

// C1/C2: accept() must refuse before ever touching the real repo when a
// patch's own path already has the user's own staged work, whether or not
// the two edits overlap — applying nothing and committing nothing. Pressing
// A (accept unexplained) isolates this precheck from the separate explain
// gate covered elsewhere.
test("accept refuses when a patch's path has the user's own staged work, applying and committing nothing (C1/C2)", async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "a.txt", "one\nagent line\n");

  // The user's own staged edit to the same file, sitting in the real repo —
  // the worktree never touches this.
  await write(repo, "a.txt", "one\nuser's own staged line\n");
  await git(repo, "add", "-A");
  const stagedBefore = await readFile(join(repo, "a.txt"), "utf8");
  const headBefore = await git(repo, "rev-parse", "HEAD");

  const bridge = new EventEmitter();
  const { stdin, lastFrame } = render(
    React.createElement(App, {
      branch: wt.branch,
      session: fakeSession(),
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
  stdin.write("A"); // accept unexplained
  await tick(80);

  assert.match(
    lastFrame() ?? "",
    /working tree has changes to a\.txt.*commit or stash/i,
    `expected a refusal naming a.txt:\n${lastFrame()}`,
  );

  const stagedAfter = await readFile(join(repo, "a.txt"), "utf8");
  assert.equal(
    stagedAfter,
    stagedBefore,
    "the user's staged file must be byte-identical afterward — no conflict markers, no agent content",
  );

  const status = await git(repo, "status", "--porcelain");
  assert.ok(status.includes("a.txt") && !status.includes("UU"), `expected a.txt still cleanly staged: ${status}`);

  const headAfter = await git(repo, "rev-parse", "HEAD");
  assert.equal(headAfter, headBefore, "nothing should have been committed");
});

// I5: the explain gate has two independent guards (waiting vs. genuinely
// empty). A prompt() that never resolves collapses both into
// summaryPending=true, summary="" — mutating either guard away still passes
// a test built only on that shape, because the other guard happens to catch
// it too. These three tests give each guard a scenario only it can catch.

test("a refuses while the summary is still streaming in, even though it isn't empty (I5, guard: summaryPending)", async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "a.txt", "one\nchanged\n");

  const gate: { resolve?: () => void } = {};
  const session: AgentSession = {
    sessionId: "fake",
    modes: null,
    prompt: async () => {
      bridge.emit("update", { kind: "agent_message_chunk", text: "partial thought" } as unknown as AgentUpdate);
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

  stdin.write("r");
  await tick(60);
  assert.match(lastFrame() ?? "", /partial thought/, "the streamed partial summary should already be visible");

  stdin.write(" ");
  await tick();
  stdin.write("a");
  await tick();
  assert.match(lastFrame() ?? "", /waiting for the agent's summary/i);

  const got = await readFile(join(repo, "a.txt"), "utf8");
  assert.equal(got, "one\n", "accept must not touch the real repo while summaryPending guard is refusing");

  gate.resolve?.();
  await tick();
});

test("a is still refused when the explain turn completes with a genuinely empty summary (I5, guard: empty summary)", async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "a.txt", "one\nchanged\n");

  const bridge = new EventEmitter();
  const { stdin, lastFrame } = render(
    React.createElement(App, {
      branch: wt.branch,
      session: fakeSession(), // resolves the explain prompt immediately, with no text at all
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
  await tick(60); // explain turn has already resolved: summaryPending is false, summary is ""

  stdin.write(" ");
  await tick();
  stdin.write("a");
  await tick();
  assert.match(lastFrame() ?? "", /no summary; press A to accept without one/);

  const got = await readFile(join(repo, "a.txt"), "utf8");
  assert.equal(got, "one\n", "accept must not touch the real repo when the summary guard is refusing");

  const status = await git(repo, "status", "--porcelain");
  assert.equal(status, "", "nothing should have been staged or committed");
});

test("a accepts once the explain turn completes with a real summary (I5, positive case)", async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "a.txt", "one\nchanged\n");

  const bridge = new EventEmitter();
  const session: AgentSession = {
    sessionId: "fake",
    modes: null,
    prompt: async () => {
      bridge.emit("update", { kind: "agent_message_chunk", text: "Fixed a bug in the parser." } as unknown as AgentUpdate);
      return "end_turn";
    },
    cancel: async () => {},
    setMode: async () => {},
    close: async () => {},
  };

  const { stdin } = render(
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

  stdin.write("r");
  await tick(60);
  stdin.write(" ");
  await tick();
  stdin.write("a");
  await tick(80);

  const got = await readFile(join(repo, "a.txt"), "utf8");
  assert.equal(got, "one\nchanged\n", "an explained accept with a real summary should land in the real repo");

  const msg = await git(repo, "log", "-1", "--format=%B");
  assert.match(msg, /Fixed a bug in the parser/, `commit should carry the real summary:\n${msg}`);
});

// I7: a failed openReview() (e.g. "nothing to review") must not leave a
// stray "r" sitting in the input box — the next "r" press must still be
// able to open a real review once there's something to show.
test('pressing r after "nothing to review" does not block the next review (I7)', async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1"); // clean worktree: wt.diff() is ""

  const bridge = new EventEmitter();
  const { stdin, lastFrame } = render(
    React.createElement(App, {
      branch: wt.branch,
      session: fakeSession(),
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
  assert.match(lastFrame() ?? "", /nothing to review/);
  assert.ok(!(lastFrame() ?? "").includes("> r"), `stray "r" leaked into the input box:\n${lastFrame()}`);

  // Now there's something to review — the next "r" must actually open it,
  // not just append to a stray "r" left over from the failed attempt.
  await write(wt.path, "a.txt", "one\nchanged\n");
  stdin.write("r");
  await tick(60);
  assert.match(lastFrame() ?? "", /\[space\] select/, "the second r press should have opened the review pane");
});

// I8: the file pane must show exactly what review.patch() (built from the
// diff captured when review opened) will apply — not a live read that can
// have changed since, because the explain turn is a normal prompt with tool
// access and the agent can keep editing the worktree while it answers.
test("file view shows the content captured when review opened, not a live read (I8)", async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "a.txt", "one\nchanged\n");

  const gate: { resolve?: () => void } = {};
  const session: AgentSession = {
    sessionId: "fake",
    modes: null,
    prompt: async () => {
      // Simulates the explain turn's own tool access mutating the worktree
      // further while the reviewer is looking at it.
      await write(wt.path, "a.txt", "one\nMUTATED-BY-AGENT\n");
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

  stdin.write("r");
  await tick(80); // review opens; snapshot captured; explain turn in flight and has already mutated the worktree
  stdin.write("\t"); // tab -> file view
  await tick();

  const frame = lastFrame() ?? "";
  assert.ok(frame.includes("changed"), `file view should show the diff-time content:\n${frame}`);
  assert.ok(
    !frame.includes("MUTATED-BY-AGENT"),
    `file view leaked a live read of content that changed after the diff was captured:\n${frame}`,
  );

  gate.resolve?.();
  await tick();
});

// I9: Ctrl+C while idle must not silently discard unaccepted work — only a
// clean worktree may exit without confirmation.
test("Ctrl+C while idle with unaccepted worktree changes asks for confirmation before exiting (I9)", async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "a.txt", "one\nchanged\n"); // dirty worktree, nothing accepted

  let exited = false;
  const bridge = new EventEmitter();
  const { stdin, lastFrame } = render(
    React.createElement(App, {
      branch: wt.branch,
      session: fakeSession(),
      bridge,
      worktree: wt,
      initialMode: "default",
      modeDegraded: false,
      explain: false,
      onExit: () => {
        exited = true;
      },
    }),
  );
  await tick();

  stdin.write("\x03"); // Ctrl+C
  await tick(60); // the dirty-worktree check is async

  assert.equal(exited, false, "must not exit immediately with unaccepted changes sitting in the worktree");
  assert.match(lastFrame() ?? "", /press Ctrl\+C again/i);

  stdin.write("\x03"); // second Ctrl+C confirms
  await tick();
  assert.equal(exited, true, "a second Ctrl+C should exit");
});

test("Ctrl+C while idle with a clean worktree exits immediately, no confirmation needed", async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1"); // nothing changed

  let exited = false;
  const bridge = new EventEmitter();
  const { stdin } = render(
    React.createElement(App, {
      branch: wt.branch,
      session: fakeSession(),
      bridge,
      worktree: wt,
      initialMode: "default",
      modeDegraded: false,
      explain: false,
      onExit: () => {
        exited = true;
      },
    }),
  );
  await tick();

  stdin.write("\x03");
  await tick(60);
  assert.equal(exited, true, "a clean worktree should not require confirmation to exit");
});

// I11: a broken blast radius (e.g. `git grep` genuinely failing) must
// render as a visible error, not an empty list indistinguishable from "no
// other references".
test("blast radius surfaces a real failure as an error, not silently \"nothing at risk\" (I11)", async () => {
  const diffWithSymbol = `diff --git a/svc.go b/svc.go
index 1111111..2222222 100644
--- a/svc.go
+++ b/svc.go
@@ -1,3 +1,3 @@ func Get(id string) error
 package p
-old
+new
`;
  // A worktree whose diff() is a real, canned diff with a detectable
  // changed symbol ("Get"), but whose `path` is not a real git repository —
  // blastRadius's own `git grep` call will fail with a genuine error
  // (not git grep's "no matches" exit 1), which must not be swallowed.
  const wt: Worktree = {
    repo: "/nonexistent/repo",
    path: "/nonexistent/repo/.ctui/wt/s1",
    branch: "ctui/s1",
    base: "0".repeat(40),
    diff: async () => diffWithSymbol,
  } as Worktree;

  const bridge = new EventEmitter();
  const { stdin, lastFrame } = render(
    React.createElement(App, {
      branch: wt.branch,
      session: fakeSession(),
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
  await tick(150); // let review open and the blastRadius() promise settle

  const frame = lastFrame() ?? "";
  assert.match(frame, /blast radius/i);
  assert.match(
    frame,
    /could not check/i,
    `a broken blast radius must render as an error, not blend in with "no other references":\n${frame}`,
  );
});

// I12: an in-flight accept() must be treated as busy the same way a running
// turn is, so Ctrl+C during one asks for confirmation instead of taking the
// immediate-exit branch (which would let index.ts's worktree teardown race
// applyPatch/commitAccepted while the UI is already unmounted).
test("Ctrl+C during an in-flight accept requires confirmation instead of exiting immediately (I12)", async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "a.txt", "one\nchanged\n");

  // Isolates this from I9's separate idle-dirty check, which would
  // otherwise also produce "don't exit" (for the right high-level reason,
  // but not the one this test is pinning) for most of accept()'s duration,
  // since the worktree's own diff is still non-empty until
  // advanceAfterAccept finishes near the very end of accept(). The real
  // diff is still used for openReview()'s own first call; only Ctrl+C's own
  // later check(s) are stubbed clean, so if I12's acceptingRef gate is
  // removed, the mutant genuinely falls through to "idle and clean" here.
  let diffCalls = 0;
  const realDiff = wt.diff.bind(wt);
  wt.diff = async () => (++diffCalls === 1 ? realDiff() : "");

  let exited = false;
  const bridge = new EventEmitter();
  const { stdin, lastFrame } = render(
    React.createElement(App, {
      branch: wt.branch,
      session: fakeSession(),
      bridge,
      worktree: wt,
      initialMode: "default",
      modeDegraded: false,
      explain: false,
      onExit: () => {
        exited = true;
      },
    }),
  );
  await tick();

  stdin.write("r");
  await tick(60);
  stdin.write(" ");
  await tick();
  stdin.write("A"); // starts accept() asynchronously
  stdin.write("\x03"); // Ctrl+C immediately, while accept() is still in flight
  await tick(150); // let everything settle

  assert.equal(exited, false, "Ctrl+C during an in-flight accept must not exit immediately");
  assert.match(lastFrame() ?? "", /press Ctrl\+C again/i);

  const got = await readFile(join(repo, "a.txt"), "utf8");
  assert.equal(got, "one\nchanged\n", "the in-flight accept should still have completed normally");
});

// Cheap fix: A means "don't wait for an explanation", not "discard the
// provenance already known" — it should use a summary that already arrived
// and always record the prompt that led here.
test("A uses the summary and prompt already known instead of discarding them (cheap fix)", async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "a.txt", "one\nchanged\n");

  const bridge = new EventEmitter();
  const session: AgentSession = {
    sessionId: "fake",
    modes: null,
    prompt: async () => {
      bridge.emit("update", { kind: "agent_message_chunk", text: "Renamed the helper." } as unknown as AgentUpdate);
      return "end_turn";
    },
    cancel: async () => {},
    setMode: async () => {},
    close: async () => {},
  };

  const { stdin } = render(
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

  stdin.write("fix the thing");
  await tick();
  stdin.write("\r"); // submit -> lastPrompt = "fix the thing"
  await tick(60);

  stdin.write("r");
  await tick(60); // explain turn fires and resolves, carrying a real summary
  stdin.write(" ");
  await tick();
  stdin.write("A"); // unexplained accept, but a summary and a prompt are both already known
  await tick(80);

  const msg = await git(repo, "log", "-1", "--format=%B");
  assert.match(msg, /Renamed the helper/, `A discarded the summary it already had:\n${msg}`);
  assert.doesNotMatch(msg, /ctui: accept unexplained change/);

  const promptTrailer = await git(repo, "log", "-1", "--format=%(trailers:key=Ctui-Prompt,valueonly)");
  assert.equal(promptTrailer.trim(), "fix the thing", "A discarded the prompt provenance it already had");
});

// Cheap fix: the review pane only shows the hunk under the cursor, so the
// aggregate selection must be visible somewhere before the irreversible
// accept key.
test("review footer shows the aggregate selection (cheap fix)", async (t) => {
  const repo = await newRepo(t);
  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "a.txt", "one\nchanged\n");
  await write(wt.path, "b.txt", "brand new\n");

  const bridge = new EventEmitter();
  const { stdin, lastFrame } = render(
    React.createElement(App, {
      branch: wt.branch,
      session: fakeSession(),
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

  assert.match(lastFrame() ?? "", /nothing selected/i);

  stdin.write(" "); // select the hunk under the cursor
  await tick();
  assert.match(lastFrame() ?? "", /1 hunk in 1 file selected/);

  stdin.write("j"); // move to the next file/hunk
  await tick();
  stdin.write(" "); // select it too
  await tick();
  assert.match(lastFrame() ?? "", /2 hunks in 2 files selected/);
});
