import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/ui.js";
import type { AgentSession, PermissionRequest } from "../src/acp.js";

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
      initialMode: "default",
      modeDegraded: false,
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
      initialMode: "default",
      modeDegraded: false,
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
