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
import { git, type Worktree } from "../src/git.js";
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

// The file behind the diff above, so opening it from the repo map shows
// real content with the changed line marked, not a read error.
const TOKEN_TS = `import { createHmac } from "node:crypto"
import { decode, encode } from "./jwt.js"
import { session } from "./session.js"

const TTL_MS = 15 * 60 * 1000
const SKEW_MS = 30_000

export function now(): number {
  return Date.now()
}

export function issue(userId: string): string {
  return encode({
    sub: userId,
    iat: now(),
    exp: now() + TTL_MS,
  })
}

export function renewable(t: string): boolean {
  const { exp } = decode(t)
  return exp + SKEW_MS > now()
}

function sign(payload: string): string {
  return createHmac("sha256", secret())
    .update(payload)
    .digest("base64url")
}

function secret(): string {
  const s = process.env.TOKEN_SECRET
  if (!s) throw new Error("TOKEN_SECRET is not set")
  return s
}

// Returns null for an expired token, the live session otherwise.
export function verify(t: string) {
  const exp = decode(t).exp

  if (exp <= now())
    return null
  return session
}
`;

// A repo whose check fails the way a real typecheck would.
const repo = await mkdtemp(join(tmpdir(), "ctui-preview-"));
await mkdir(join(repo, ".ctui"), { recursive: true });
await mkdir(join(repo, "src", "auth"), { recursive: true });
// A real commit behind the file, so the provenance gutter has something
// true to say: everything but the edited line traces to it.
await writeFile(join(repo, "src", "auth", "token.ts"), TOKEN_TS.replace("exp <= now()", "exp < now()"));
await git(repo, "init", "-q");
await git(repo, "config", "user.email", "preview@example.com");
await git(repo, "config", "user.name", "preview");
await git(repo, "add", "-A");
await git(repo, "commit", "-qm", "add token verification");
await writeFile(join(repo, "src", "auth", "token.ts"), TOKEN_TS);
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
const finished = lastFrame() ?? "";

// tab moves the keyboard into the repo map; j walks the cursor down to the
// file the checker is failing on.
stdin.write("\t");
await settle(80);
stdin.write("j");
await settle(80);
const focused = lastFrame() ?? "";

// Enter opens it, positioned on the line this session changed.
stdin.write("\r");
await settle(250);
const opened = lastFrame() ?? "";

process.stdout.write(
  [
    "--- mid-turn ---",
    midTurn,
    "",
    "--- turn finished ---",
    finished,
    "",
    "--- repo map focused (tab, then j) ---",
    focused,
    "",
    "--- enter on the failing file ---",
    opened,
    "",
  ].join("\n"),
);
process.exit(0);
