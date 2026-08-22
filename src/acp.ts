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
  // "pending" | "in_progress" | "completed" | "failed". A tool that failed
  // renders differently from one that worked, so this is not cosmetic: an
  // agent thrashing through failing commands looks identical to one making
  // progress without it.
  toolStatus?: string;
  // Set when kind is "current_mode_update": the agent switched modes on its
  // own. The UI must reflect this rather than keep showing a stale mode.
  modeId?: string;
  // Set when kind is "usage_update": how full the agent's context window is
  // and what the session has cost so far. ACP marks this update UNSTABLE and
  // adapters may never send it, so everything downstream must treat its
  // absence as "unknown" and show nothing — never a zero.
  usage?: { used: number; size: number; cost?: { amount: number; currency: string } };
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
  // How long to wait for the adapter to answer initialize/newSession before
  // giving up. A dead or never-spawned adapter is caught by childClosed
  // (close/error events) long before this fires; this only covers one that
  // neither replies nor exits. Overridable so tests can exercise it without
  // a real multi-second wait.
  startupTimeoutMs?: number;
}

const DEFAULT_ARGV = ["npx", "-y", "@zed-industries/claude-code-acp"];
const DEFAULT_STARTUP_TIMEOUT_MS = 20_000;

// startupTimeout rejects after `ms` unless something else settles first.
// unref()'d so a pending one never keeps the process alive, and — since
// Promise.race attaches its own handler to every promise it's given,
// including the one that loses — this never produces an unhandled
// rejection either, so there's no need to cancel it explicitly.
function startupTimeout(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`claude-code-acp did not respond within ${ms}ms of starting`));
    }, ms);
    timer.unref();
  });
}

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
      if (u.status != null) out.toolStatus = u.status;
      if (u.locations && u.locations.length > 0) {
        out.toolPath = relativizePath(cwd, u.locations[0].path);
      }
      break;
    case "current_mode_update":
      out.modeId = u.currentModeId;
      break;
    case "usage_update":
      if (typeof u.used === "number" && typeof u.size === "number" && u.size > 0) {
        out.usage = { used: u.used, size: u.size };
        if (u.cost != null) out.usage.cost = { amount: u.cost.amount, currency: u.cost.currency };
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
  // dies mid-turn, this is what makes `prompt()` reject instead of hanging —
  // and, raced against initialize()/newSession() below, what makes startup
  // fail loudly instead of hanging forever when the adapter dies before ever
  // answering. `error` (e.g. spawn ENOENT: the binary doesn't exist) feeds
  // the same channel: Node's ChildProcess throws if an 'error' event has no
  // listener at all, so without this a missing binary crashes the whole
  // process instead of failing this session cleanly.
  const childClosed = new Promise<never>((_resolve, reject) => {
    child.once("close", (code, signal) => {
      reject(new Error(`claude-code-acp exited (code=${code} signal=${signal}): ${stderrTail.trim()}`));
    });
    child.once("error", (err) => {
      reject(new Error(`failed to launch claude-code-acp: ${err.message}`));
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

  // conn.closed resolves when the ndjson *stream* ends — our end of the
  // pipe — not when the process group exits. argv is commonly a wrapper
  // (npx) execing a shell execing the real agent; the wrapper's own hold on
  // that pipe can end well before the tree it spawned actually dies (it can
  // even close its stdout without dying at all). So conn.closed is never
  // trusted as proof of death here — the process group itself, polled
  // directly, is. process.kill(-pid, 0) throws ESRCH once nothing is left in
  // the group to signal; any other outcome (success, or a different errno
  // like EPERM) means something is still there. Win32 has no process-group
  // signal, so there we fall back to the immediate child's own "exit" —
  // the same platform limitation killTree already documents.
  let childExited = false;
  child.once("exit", () => {
    childExited = true;
  });

  function groupAlive(): boolean {
    if (process.platform === "win32") return !childExited;
    if (child.pid == null) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  // Polls groupAlive() until it's false or deadlineMs elapses. 50ms is short
  // enough that a process which dies promptly (the common case) doesn't add
  // noticeable latency to close().
  async function waitForGroupGone(deadlineMs: number): Promise<boolean> {
    const deadline = Date.now() + deadlineMs;
    while (groupAlive()) {
      if (Date.now() >= deadline) return false;
      await delay(50);
    }
    return true;
  }

  let closed = false;
  // Never hangs and never rejects: idempotent via `closed`, and bounded by
  // the grace period plus the post-SIGKILL confirmation wait below,
  // regardless of what the child (or a stubborn descendant that traps
  // SIGTERM) does.
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;

    killTree("SIGTERM");

    if (!(await waitForGroupGone(1000))) {
      killTree("SIGKILL");
      // SIGKILL cannot be ignored, so the group is coming down; confirm it's
      // actually gone (bounded) before resolving, rather than just assuming
      // the signal worked.
      await waitForGroupGone(2000);
    }
  }

  let sessionId: string;
  try {
    // Raced the same way prompt() is raced against childClosed, and for the
    // same underlying reason: the SDK never rejects a pending request on its
    // own. Without this, an adapter that exits (or never spawns, or never
    // answers) during startup leaves initialize()/newSession() pending
    // forever — a blank terminal and a leaked worktree/branch, with nothing
    // ever printed and the caller's own catch never reached.
    const initFlow = (async () => {
      await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      return conn.newSession({ cwd: opts.cwd, mcpServers: [] });
    })();

    const result = await Promise.race([
      initFlow,
      childClosed,
      startupTimeout(opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS),
    ]);
    sessionId = result.sessionId;
    modes = result.modes ?? null;
  } catch (err) {
    // Startup failed one way or another: nothing here is usable, so don't
    // leave the child (or, if it's still alive — the hung-adapter/timeout
    // case — its whole process group) running unattended.
    await close().catch(() => {});
    throw err;
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
