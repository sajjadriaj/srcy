// `npm run preview` — paints one cockpit frame and prints it. Layout work
// needs to be looked at, and looking at it otherwise means starting a real
// agent and waiting for it to write something.
//
// It drives the real App through its real code path: canned session updates
// arrive on the bridge, then a prompt is typed and submitted, which is what
// triggers the end-of-turn diff refresh and check run. Only the agent and
// the worktree are fakes — the layout, the panes and the wiring are the
// ones that ship.
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import type { AgentSession } from "../src/acp.js";
import type { Worktree } from "../src/git.js";
import { App } from "../src/ui.js";

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

// A repo whose check fails the way a real typecheck would.
const repo = await mkdtemp(join(tmpdir(), "ctui-preview-"));
await mkdir(join(repo, ".ctui"), { recursive: true });
const check = join(repo, ".ctui", "check");
await writeFile(check, '#!/bin/sh\necho "src/auth/token.ts(41,5): error TS2532: Object is possibly undefined."\nexit 1\n');
await chmod(check, 0o755);

const bridge = new EventEmitter();
const session = {
  sessionId: "s1",
  prompt: async () => "",
  cancel: async () => {},
  close: async () => {},
} as AgentSession;
const worktree = {
  path: repo,
  repo,
  diff: async () => DIFF,
} as unknown as Worktree;

const { lastFrame, stdin } = render(
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

const up = (u: Record<string, unknown>): boolean => bridge.emit("update", { raw: u, ...u });
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
up({
  kind: "agent_thought_chunk",
  text: "expiry check is exclusive; a token expiring this exact ms is still accepted",
});
up({
  kind: "agent_message_chunk",
  text: "Off-by-one in verify(): `<` lets a token that expired this millisecond through. Changing to `<=`.",
});
up({ kind: "tool_call", toolCallId: "3", toolKind: "edit", toolTitle: "Write", toolPath: "src/auth/token.ts" });
up({ kind: "tool_call", toolCallId: "4", toolKind: "edit", toolTitle: "Write", toolPath: "src/auth/session.ts" });

// Submitting is what ends a turn, and the end of a turn is what refreshes
// the map and runs the checks — so the frame below is the one a real
// session paints, not a hand-assembled approximation of it.
await settle(50);
// Typing and submitting are separate writes: delivered as one chunk, the
// carriage return is just another character in the inserted text and the
// prompt is never submitted at all.
stdin.write("fix the token expiry off-by-one");
await settle(50);
stdin.write("\r");
await settle(800);

process.stdout.write((lastFrame() ?? "") + "\n");
process.exit(0);
