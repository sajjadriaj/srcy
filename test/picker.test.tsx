import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import type { AgentSession } from "../src/acp.js";
import { filterFiles, listFiles } from "../src/files.js";
import { git } from "../src/git.js";
import type { Worktree } from "../src/git.js";
import { App } from "../src/ui.js";
import { newRepo, write } from "./helpers.js";

test("filterFiles matches terms in any order, anywhere in the path", () => {
  const files = ["src/auth/token.ts", "src/api/routes.ts", "test/auth/token.test.ts"];
  assert.deepEqual(filterFiles(files, "auth tok"), ["src/auth/token.ts", "test/auth/token.test.ts"]);
  assert.deepEqual(filterFiles(files, "tok auth"), ["src/auth/token.ts", "test/auth/token.test.ts"]);
  assert.deepEqual(filterFiles(files, "zzz"), []);
});

test("filterFiles puts a basename match ahead of a directory match", () => {
  // Someone typing "token" wants token.ts, not every file under a
  // directory that happens to contain the word.
  const files = ["src/token/helpers.ts", "src/token/index.ts", "src/auth/token.ts"];
  assert.equal(filterFiles(files, "token")[0], "src/auth/token.ts");
});

test("filterFiles with no query lists the head of the tree, capped", () => {
  const files = Array.from({ length: 50 }, (_, i) => `f${i}.ts`);
  assert.equal(filterFiles(files, "").length, 10);
  assert.equal(filterFiles(files, "  ").length, 10);
});

test("listFiles includes a file the agent just created but never staged", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "brand-new.ts", "export const x = 1\n");
  const files = await listFiles(repo);
  // Untracked until something stages it — and a picker that cannot open
  // the file the agent just wrote is the case that matters most.
  assert.ok(files.includes("brand-new.ts"), `expected brand-new.ts in ${JSON.stringify(files)}`);
  assert.ok(files.includes("a.txt"));
});

test("listFiles honours .gitignore and lists each path once", async (t) => {
  const repo = await newRepo(t);
  await write(repo, ".gitignore", "secret.txt\n");
  await write(repo, "secret.txt", "nope\n");
  await write(repo, "kept.ts", "yes\n");
  await git(repo, "add", "kept.ts");
  const files = await listFiles(repo);
  assert.ok(!files.includes("secret.txt"));
  // Staged *and* on disk: git lists it under both --cached and --others.
  assert.equal(files.filter((f) => f === "kept.ts").length, 1);
});

function renderApp(worktree: Worktree): ReturnType<typeof render> {
  const session = {
    sessionId: "s1",
    prompt: async () => "",
    cancel: async () => {},
    close: async () => {},
  } as AgentSession;
  return render(
    <App
      branch="ctui/s1"
      session={session}
      bridge={new EventEmitter()}
      worktree={worktree}
      initialMode="default"
      modeDegraded={false}
      explain={false}
      onExit={() => {}}
    />,
  );
}

const settle = (ms = 120): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("ctrl-P opens the picker without leaking the keystroke into the query", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "widget.ts", "export const widget = 1\n");
  const worktree = { path: repo, repo, diff: async () => "" } as unknown as Worktree;

  const { stdin, lastFrame } = renderApp(worktree);
  await settle();
  stdin.write("\x10"); // ctrl-P
  await settle();

  const frame = lastFrame() ?? "";
  assert.match(frame, /OPEN {2}\d+ files/);
  // The keystroke that opened the picker must not also land in the query
  // box that the same keystroke mounted — the exact bug "r" caused on the
  // review pane.
  assert.match(frame, /open ▸\s*$/m);
  assert.match(frame, /widget\.ts/);
});

test("typing filters, enter opens the file, escape backs out one level at a time", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "widget.ts", "line one\nline two\nline three\n");
  const worktree = { path: repo, repo, diff: async () => "" } as unknown as Worktree;

  const { stdin, lastFrame } = renderApp(worktree);
  await settle();
  stdin.write("\x10");
  await settle();
  stdin.write("widget");
  await settle();
  assert.match(lastFrame() ?? "", /widget\.ts/);
  assert.doesNotMatch(lastFrame() ?? "", /a\.txt/);

  stdin.write("\r");
  await settle();
  assert.match(lastFrame() ?? "", /line two/);

  // Escape from the file returns to the list, not to the session.
  stdin.write("\x1b");
  await settle();
  assert.match(lastFrame() ?? "", /OPEN {2}\d+ files/);
  assert.doesNotMatch(lastFrame() ?? "", /line two/);

  // Escape again returns to the session.
  stdin.write("\x1b");
  await settle();
  assert.doesNotMatch(lastFrame() ?? "", /OPEN {2}\d+ files/);
});

test("a query that matches nothing says so instead of rendering an empty box", async (t) => {
  const repo = await newRepo(t);
  const worktree = { path: repo, repo, diff: async () => "" } as unknown as Worktree;

  const { stdin, lastFrame } = renderApp(worktree);
  await settle();
  stdin.write("\x10");
  await settle();
  stdin.write("zzzznope");
  await settle();
  assert.match(lastFrame() ?? "", /no match/);
});
