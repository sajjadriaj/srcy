import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import type { AgentSession } from "../src/acp.js";
import { createWorktree, git } from "../src/git.js";
import { App } from "../src/ui.js";
import { newRepo, write } from "./helpers.js";

const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

// The gutter is the point of the whole file: rendering it in isolation
// proves the component, not that the review pane ever asks for it.
test("file view labels each run of lines with the prompt that produced it", async (t) => {
  const repo = await newRepo(t);
  await write(repo, "f.txt", "one\ntwo\nthree\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-qm", "add f\n\nCtui-Prompt: create the f file");

  const wt = await createWorktree(repo, "s1");
  await write(wt.path, "f.txt", "one\nTWO\nthree\n");

  const session: AgentSession = {
    sessionId: "fake",
    modes: null,
    prompt: async () => "end_turn",
    cancel: async () => {},
    setMode: async () => {},
    close: async () => {},
  };

  const { stdin, lastFrame } = render(
    React.createElement(App, {
      branch: wt.branch,
      session,
      bridge: new EventEmitter(),
      worktree: wt,
      initialMode: "default",
      modeDegraded: false,
      explain: false,
      onExit: () => {},
    }),
  );
  await tick();
  stdin.write("r");
  await tick(150);
  stdin.write("\t"); // patch view -> file view
  await tick(250);

  const frame = lastFrame() ?? "";
  assert.match(frame, /create the f file/, `no committed-prompt label in:\n${frame}`);
  assert.match(frame, /this session/, `no pending label in:\n${frame}`);
});
