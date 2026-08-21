// `npm run preview` — paints one cockpit frame from canned session updates
// and prints it. Layout work needs to be looked at, and looking at it
// otherwise means starting a real agent and waiting for it to write
// something. Fixture data only: no agent, no worktree, no git.
import { EventEmitter } from "node:events";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/ui.js";
import type { AgentSession } from "../src/acp.js";
import type { Worktree } from "../src/git.js";

const DIFF = [
  "diff --git a/src/auth/token.ts b/src/auth/token.ts",
  "index 1111111..2222222 100644",
  "--- a/src/auth/token.ts",
  "+++ b/src/auth/token.ts",
  "@@ -38,6 +38,6 @@ export function verify(t: string) {",
  " export function verify(t: string) {",
  "   const exp = decode(t).exp",
  " ",
  "-  if (exp < now())",
  "+  if (exp <= now())",
  "     return null",
  "   return session",
  "diff --git a/src/auth/session.ts b/src/auth/session.ts",
  "index 3333333..4444444 100644",
  "--- a/src/auth/session.ts",
  "+++ b/src/auth/session.ts",
  "@@ -12,3 +12,15 @@ export class Session {",
  " export class Session {",
  "+  private renewals = 0",
  "+  renew() { this.renewals++ }",
  " }",
  "",
].join("\n");

const bridge = new EventEmitter();
const session = {
  sessionId: "s1",
  prompt: async () => "",
  cancel: async () => {},
  close: async () => {},
} as AgentSession;
const worktree = { path: "/tmp/wt", repo: "/repo", diff: async () => DIFF } as unknown as Worktree;

const { lastFrame } = render(
  <App
    branch="ctui/auth"
    session={session}
    bridge={bridge}
    worktree={worktree}
    initialMode="default"
    modeDegraded={false}
    explain={false}
    onExit={() => {}}
  />,
);

const up = (u: Record<string, unknown>) => bridge.emit("update", { raw: u, ...u });

up({ kind: "user" });
bridge.emit("update", { kind: "agent_message_chunk", text: "", raw: {} });

// A turn: plan, reads, thinking, writes.
up({
  kind: "plan",
  entries: [
    { content: "find the expiry comparison", status: "completed" },
    { content: "fix the off-by-one", status: "in_progress" },
    { content: "add a regression test", status: "pending" },
  ],
});
up({ kind: "tool_call", toolCallId: "1", toolKind: "read", toolTitle: "Read", toolPath: "src/auth/session.ts" });
up({ kind: "tool_call", toolCallId: "2", toolKind: "read", toolTitle: "Read", toolPath: "src/auth/token.ts" });
bridge.emit("update", {
  kind: "agent_thought_chunk",
  text: "expiry check is exclusive; a token expiring this exact ms is still accepted",
  raw: {},
});
bridge.emit("update", {
  kind: "agent_message_chunk",
  text: "Off-by-one in verify(): `<` lets a token that expired this millisecond through. Changing to `<=`.",
  raw: {},
});
up({ kind: "tool_call", toolCallId: "3", toolKind: "edit", toolTitle: "Write", toolPath: "src/auth/token.ts" });
up({ kind: "tool_call", toolCallId: "4", toolKind: "edit", toolTitle: "Write", toolPath: "src/auth/session.ts" });
up({ kind: "tool_call", toolCallId: "3", toolKind: "edit", toolTitle: "Write", toolPath: "src/auth/token.ts" });

await new Promise((r) => setTimeout(r, 300));
process.stdout.write((lastFrame() ?? "") + "\n");
process.exit(0);
