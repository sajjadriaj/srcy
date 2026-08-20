import { spawn } from "node:child_process";
import { relative, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type ContentBlock,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";

// What the UI needs from a session/update notification, plus the raw payload.
export interface AgentUpdate {
  kind: SessionUpdate["sessionUpdate"];
  text?: string;
  toolTitle?: string;
  toolPath?: string;
  raw: SessionUpdate;
}

// What the UI needs to render a permission prompt. `title` is sanitized and
// never blank. Match `options` on `kind` (PermissionOptionKind) — ids and
// array order are adapter-specific and unstable.
export interface PermissionRequest {
  title: string;
  options: PermissionOption[];
  toolCall: ToolCallUpdate;
}

export interface AgentSession {
  readonly sessionId: string;
  prompt(text: string): Promise<string>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface SessionOptions {
  cwd: string;
  onUpdate(u: AgentUpdate): void;
  onPermission(req: PermissionRequest): Promise<string | null>;
  argv?: string[];
}

const DEFAULT_ARGV = ["npx", "-y", "@zed-industries/claude-code-acp"];

// C0/C1 control characters. The agent controls every string here, and an
// ANSI escape in a permission dialog is an obvious attack.
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

// Strip control chars; a whitespace-only result counts as absent.
function clean(s: string | null | undefined): string | null {
  if (s == null) return null;
  const stripped = s.replace(CONTROL_CHARS, "").trim();
  return stripped === "" ? null : stripped;
}

// Never blank: title, then kind, then the tool call id, then an explicit
// marker so a bad payload is visible instead of read as an empty prompt.
function permissionTitle(toolCall: ToolCallUpdate): string {
  return (
    clean(toolCall.title) ??
    clean(toolCall.kind ?? null) ??
    clean(toolCall.toolCallId) ??
    "UNIDENTIFIED tool call"
  );
}

// Blast radius compares against repo-relative `git grep -l` output, so
// relativize against cwd. A location outside cwd stays absolute rather than
// emit a leading "../" that could never match; ".." is checked as a whole
// path segment since "..foo" is a real filename, not an escape.
function relativizePath(cwd: string, absPath: string): string {
  const rel = relative(cwd, absPath);
  return rel === ".." || rel.startsWith(".." + sep) ? absPath : rel;
}

function textOf(content: ContentBlock): string | undefined {
  return content.type === "text" ? content.text : undefined;
}

function toUpdate(cwd: string, n: SessionNotification): AgentUpdate {
  const u = n.update;
  const out: AgentUpdate = { kind: u.sessionUpdate, raw: u };
  switch (u.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
      out.text = textOf(u.content);
      break;
    case "tool_call":
    case "tool_call_update":
      if (u.title != null) out.toolTitle = u.title;
      if (u.locations && u.locations.length > 0) {
        out.toolPath = relativizePath(cwd, u.locations[0].path);
      }
      break;
  }
  return out;
}

// Launches claude-code-acp and speaks ACP over its stdio via the SDK. We
// implement only the two Client methods the SDK requires; everything else
// (the read loop, the write queue, request/response correlation) is its job.
export async function startSession(opts: SessionOptions): Promise<AgentSession> {
  const argv = opts.argv ?? DEFAULT_ARGV;

  // claude-code-acp refuses to start under these: "Claude Code cannot be
  // launched inside another Claude Code session."
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_SSE_PORT;

  const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env });

  // Drain stderr unconditionally so a chatty child never blocks on a full
  // pipe; keep a short tail to enrich the error if it exits before replying.
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4096);
  });

  // The SDK never rejects a pending request when the stream ends — it just
  // hangs (see Connection#sendRequest/#receive in dist/acp.js). If the child
  // dies mid-turn, this is what makes `prompt()` reject instead of hanging.
  const childClosed = new Promise<never>((_resolve, reject) => {
    child.once("close", (code, signal) => {
      reject(new Error(`claude-code-acp exited (code=${code} signal=${signal}): ${stderrTail.trim()}`));
    });
  });
  childClosed.catch(() => {}); // don't warn if nothing ever awaits this

  const client: Client = {
    async sessionUpdate(params) {
      opts.onUpdate(toUpdate(opts.cwd, params));
    },
    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      const optionId = await opts.onPermission({
        title: permissionTitle(params.toolCall),
        options: params.options,
        toolCall: params.toolCall,
      });
      return {
        outcome: optionId === null ? { outcome: "cancelled" } : { outcome: "selected", optionId },
      };
    },
  };

  const conn = new ClientSideConnection(
    () => client,
    ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
  );

  await conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  const { sessionId } = await conn.newSession({ cwd: opts.cwd, mcpServers: [] });

  let closed = false;
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    child.kill();
    await conn.closed;
  }

  return {
    sessionId,
    async prompt(text: string): Promise<string> {
      const { stopReason } = await Promise.race([
        conn.prompt({ sessionId, prompt: [{ type: "text", text }] }),
        childClosed,
      ]);
      return stopReason;
    },
    async cancel(): Promise<void> {
      await conn.cancel({ sessionId });
    },
    close,
  };
}
