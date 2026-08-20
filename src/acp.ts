import { spawn } from "node:child_process";
import { relative, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type ContentBlock,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionModeState,
  type SessionNotification,
  type SessionUpdate,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";

// What the UI needs from a session/update notification, plus the raw payload.
export interface AgentUpdate {
  kind: SessionUpdate["sessionUpdate"];
  text?: string;
  // Set on tool_call/tool_call_update. toolCallId identifies the tool call
  // an update belongs to, so a client can merge updates into one entry
  // instead of rendering each as a separate line. toolTitle/toolKind are
  // only present when this particular update carries them (ACP updates are
  // patches: a field's absence means "unchanged", not "cleared").
  toolCallId?: string;
  toolTitle?: string;
  toolKind?: string;
  toolPath?: string;
  // Set when kind is "current_mode_update": the agent switched modes on its
  // own. The UI must reflect this rather than keep showing a stale mode.
  modeId?: string;
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
  // The session's mode state as of the last newSession/setMode/
  // current_mode_update, or null if this adapter doesn't report modes at
  // all. The caller (not this module) decides whether to pin a default.
  readonly modes: SessionModeState | null;
  prompt(text: string): Promise<string>;
  cancel(): Promise<void>;
  // Requests a mode change. Throws if the adapter rejects it (e.g. unknown
  // modeId). On success, `modes.currentModeId` reflects the new mode.
  setMode(modeId: string): Promise<void>;
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
      out.toolCallId = u.toolCallId;
      if (u.title != null) out.toolTitle = u.title;
      if (u.kind != null) out.toolKind = u.kind;
      if (u.locations && u.locations.length > 0) {
        out.toolPath = relativizePath(cwd, u.locations[0].path);
      }
      break;
    case "current_mode_update":
      out.modeId = u.currentModeId;
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

  const child = spawn(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    env,
    // Make child its own process group leader so close() can signal the
    // whole tree, not just this immediate process. argv is commonly
    // ["npx", "-y", pkg]; npx execs the real agent through a shell wrapper
    // that does not forward signals to it, so killing only `child` leaves
    // the actual agent process orphaned and running. POSIX-only — win32 has
    // no process-group signal (negative pid), so it falls back to killing
    // just this process there (see killTree).
    detached: process.platform !== "win32",
  });

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

  // Tracks the session's mode state; kept live so `session.modes` is always
  // current, whether it changed via our own setMode() or the agent's own
  // current_mode_update notification.
  let modes: SessionModeState | null = null;

  const client: Client = {
    async sessionUpdate(params) {
      const u = toUpdate(opts.cwd, params);
      if (u.kind === "current_mode_update" && u.modeId != null && modes != null) {
        modes = { ...modes, currentModeId: u.modeId };
      }
      opts.onUpdate(u);
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
  const { sessionId, modes: initialModes } = await conn.newSession({ cwd: opts.cwd, mcpServers: [] });
  modes = initialModes ?? null;

  // Signals `signal` to the whole process group `child` leads (see spawn's
  // detached above), not just `child` itself — that is what actually reaches
  // a grandchild like the real agent process npx execs into. ESRCH (nothing
  // left to signal) is success, not an error.
  function killTree(signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && child.pid != null) {
        process.kill(-child.pid, signal);
      } else {
        child.kill(signal);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
  }

  let closed = false;
  // Never hangs and never rejects: idempotent via `closed`, and bounded by
  // the grace period below regardless of what the child (or a stubborn
  // descendant that traps SIGTERM) does. conn.closed — not the child's own
  // "exit" — is the only trustworthy signal that nothing is left holding its
  // stdout open, since a wrapper process can exit while what it exec'd or
  // spawned keeps running; that is exactly the orphaned-grandchild bug this
  // replaces child.kill() + await conn.closed to fix.
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;

    killTree("SIGTERM");

    const result = await Promise.race([conn.closed.then(() => "closed" as const), delay(1000, "timeout" as const)]);

    if (result === "timeout") {
      killTree("SIGKILL");
      // SIGKILL cannot be ignored, so the group is coming down; give the OS
      // a moment to finish reaping it, then return regardless.
      await Promise.race([conn.closed, delay(1000)]);
    }
  }

  return {
    sessionId,
    get modes(): SessionModeState | null {
      return modes;
    },
    async setMode(modeId: string): Promise<void> {
      await conn.setSessionMode({ sessionId, modeId });
      // The response carries no state; a successful call means the agent is
      // now in this mode, so update optimistically rather than wait for a
      // current_mode_update that may not come.
      if (modes != null) modes = { ...modes, currentModeId: modeId };
    },
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
