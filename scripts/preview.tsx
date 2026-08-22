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
const TURN_MS = 2600;
const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const session = {
  sessionId: "s1",
  // A turn that actually takes time, so the preview can paint the cockpit
  // while the agent is still working — the state it spends most of its life in.
  prompt: async () => {
    await settle(TURN_MS);
    return "";
  },
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

await settle(50);
stdin.write("fix the token expiry off-by-one");
await settle(50);
stdin.write("\r");

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
up({ kind: "tool_call_update", toolCallId: "1", toolStatus: "completed" });
up({ kind: "tool_call_update", toolCallId: "2", toolStatus: "completed" });
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
up({ kind: "tool_call_update", toolCallId: "3", toolStatus: "completed" });
up({ kind: "tool_call_update", toolCallId: "4", toolStatus: "completed" });
up({ kind: "usage_update", usage: { used: 104_800, size: 200_000, cost: { amount: 0.41, currency: "USD" } } });

// A command that fails, and one that is still going when we paint: the two
// states the transcript has to tell apart at a glance.
up({ kind: "tool_call", toolCallId: "5", toolKind: "execute", toolTitle: "Bash", toolPath: "npm test" });
await settle(1400);
up({ kind: "tool_call_update", toolCallId: "5", toolStatus: "failed" });
up({ kind: "tool_call", toolCallId: "6", toolKind: "execute", toolTitle: "Bash", toolPath: "npm run typecheck" });

await settle(900);
const midTurn = lastFrame() ?? "";

await settle(TURN_MS);
process.stdout.write("--- mid-turn ---\n" + midTurn + "\n\n--- turn finished ---\n" + (lastFrame() ?? "") + "\n");
process.exit(0);
