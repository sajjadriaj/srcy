// Fake ACP agent for acp.test.ts, built on the SDK's own AgentSideConnection
// rather than a hand-written JSON fixture — the type-safe way to keep the
// fake honest to the real wire shape. Speaks over its own stdio; startSession
// spawns it in place of the real claude-code-acp binary.
//
// Usage: tsx fake-agent.ts <scenario> [toolCallOverridesJSON] [optionsJSON]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type AuthenticateResponse,
  type CancelNotification,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PermissionOption,
  type PromptRequest,
  type PromptResponse,
} from "@agentclientprotocol/sdk";

const scenario = process.argv[2] ?? "updates";
const defaultOptions: PermissionOption[] = [
  { optionId: "allow_always", kind: "allow_always", name: "Always Allow" },
  { optionId: "allow", kind: "allow_once", name: "Allow" },
  { optionId: "reject", kind: "reject_once", name: "Reject" },
];

// For acp.test.ts's process-tree-kill test. Ignoring SIGTERM ourselves too
// (not just the grandchild) proves close() escalates to SIGKILL rather than
// returning early just because *this* process happened to exit quickly —
// the real bug was a wrapper (npx) exiting while what it spawned kept
// running, so a real fix must not depend on the immediate child dying.
// For acp.test.ts's C4 coverage: an adapter that crashes before it ever
// answers initialize, simulating claude-code-acp dying during startup
// rather than mid-turn.
if (scenario === "exit-immediately") {
  process.exit(3);
}

if (scenario === "stubborn-child") {
  const grandchild = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1 << 30);"],
    { stdio: "ignore" },
  );
  const pidFile = process.argv[3];
  if (pidFile && grandchild.pid != null) {
    writeFileSync(pidFile, String(grandchild.pid));
  }
  // Mirrors the real npx wrapper: its write end of the stdout pipe closes —
  // ending our ndjson stream, so conn.closed resolves — well before the
  // process tree it spawned actually exits. This process itself still
  // ignores SIGTERM and keeps running (like the grandchild above), so the
  // only thing that proves close() escalated to SIGKILL is the grandchild
  // actually dying, not conn.closed resolving early.
  process.on("SIGTERM", () => {
    process.stdout.end();
  });
}

function makeAgent(conn: AgentSideConnection): Agent {
  let cwd = "";
  return {
    async initialize(): Promise<InitializeResponse> {
      // For acp.test.ts's C4 coverage: an adapter that hangs during startup
      // rather than answering or exiting — pins startSession's startup
      // timeout rather than its childClosed race. Writes its own pid first
      // so the test can confirm the timeout path actually kills it instead
      // of leaving it running.
      if (scenario === "hang-init") {
        const pidFile = process.argv[3];
        if (pidFile) writeFileSync(pidFile, String(process.pid));
        return new Promise(() => {}); // never resolves
      }
      return { protocolVersion: PROTOCOL_VERSION };
    },
    async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
      cwd = params.cwd;
      return { sessionId: "fake-session" };
    },
    async authenticate(): Promise<AuthenticateResponse> {
      return {};
    },
    async cancel(_params: CancelNotification): Promise<void> {},
    async prompt(params: PromptRequest): Promise<PromptResponse> {
      const { sessionId } = params;

      if (scenario === "exit-mid-turn") {
        process.exit(1);
      }

      if (scenario === "env-check") {
        const seen = {
          claudecode: process.env.CLAUDECODE ?? null,
          ssePort: process.env.CLAUDE_CODE_SSE_PORT ?? null,
        };
        await conn.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(seen) } },
        });
        return { stopReason: "end_turn" };
      }

      if (scenario === "permission") {
        const overrides = process.argv[3] ? JSON.parse(process.argv[3]) : {};
        const options: PermissionOption[] = process.argv[4] ? JSON.parse(process.argv[4]) : defaultOptions;
        const { outcome } = await conn.requestPermission({
          sessionId,
          toolCall: { toolCallId: "tc-1", title: "Edit file", ...overrides },
          options,
        });
        const text = outcome.outcome === "selected" ? `SELECTED:${outcome.optionId}` : "CANCELLED";
        await conn.sessionUpdate({
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        });
        return { stopReason: "end_turn" };
      }

      // "updates" (default): a couple of message chunks, then a tool call
      // whose location is inside cwd and one whose location is outside it.
      await conn.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
      });
      await conn.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } },
      });
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-in",
          title: "Reading file",
          kind: "read",
          locations: [{ path: join(cwd, "inside.txt") }],
        },
      });
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tc-out",
          title: "Reading outside file",
          kind: "read",
          status: "failed",
          locations: [{ path: join(dirname(cwd), "outside.txt") }],
        },
      });
      await conn.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: "usage_update",
          used: 1234,
          size: 200000,
          cost: { amount: 0.5, currency: "USD" },
        },
      });
      return { stopReason: "end_turn" };
    },
  };
}

new AgentSideConnection(makeAgent, ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
