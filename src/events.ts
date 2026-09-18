import { createHash } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What other tools have to say, and the one thing srcy asks of them.
//
// srcy observes; it does not orchestrate. It never installs, invokes or polls
// another tool, and it works identically when none are installed. The whole
// integration contract is a line of JSON on a local socket, so a hook can be
// written in shell, Python, Rust or a CI step without importing a byte of
// srcy — and a tool that emits into a socket nobody is listening on carries
// on exactly as it would have.

export interface ExternalEvent {
  version: 1;
  // Who is speaking. The first event from a source establishes it; there is
  // nothing to register and nothing to configure.
  source: string;
  // `<source>.<category>.<action>` by convention, and deliberately not
  // enforced: srcy must accept an event type it has never heard of, because
  // the alternative is a list of tools srcy has been taught about.
  type: string;
  timestamp?: number;
  // The tree the sender's work was about. srcy never reinterprets the
  // result — it only says whether the tree has moved since.
  treeHash?: string;
  sessionId?: string;
  // The sender's own reading of its result. srcy repeats it and never
  // overrules it: a tool that called something `info` has not reported an
  // error, whatever srcy might make of the metadata.
  level?: "info" | "warning" | "error";
  summary?: string;
  metadata?: Record<string, unknown>;
}

// Bounded so a tool that decides to send its whole log cannot be the reason
// srcy stops answering.
export const MAX_EVENT_BYTES = 64 * 1024;

// A Unix socket path is capped by the kernel (108 bytes on Linux, 104 on
// macOS) — short enough that a repo a few directories deep overruns it. Both
// sides compute this the same way from the same repo path, so the fallback
// needs no discovery.
const MAX_SOCKET_PATH = 100;

export function socketPath(repo: string): string {
  const inRepo = join(repo, ".srcy", "srcy.sock");
  if (inRepo.length <= MAX_SOCKET_PATH) return inRepo;
  return join(tmpdir(), `srcy-${createHash("sha1").update(repo).digest("hex").slice(0, 12)}.sock`);
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// Only the envelope is validated: version, source, type. Everything a tool
// puts in `metadata` is its own business and is carried through untouched —
// validating it would mean srcy knowing what each tool means, which is the
// coupling this design exists to avoid.
export function parseEvent(line: string): ExternalEvent | null {
  if (line.length > MAX_EVENT_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  // An unknown version is refused rather than guessed at. The envelope is
  // versioned so that a later one can add capabilities; reading a version 2
  // event as though it were a version 1 is how that guarantee gets broken.
  if (o.version !== 1) return null;

  const source = text(o.source);
  const type = text(o.type);
  if (source === "" || type === "") return null;
  if (source.includes("\n") || type.includes("\n")) return null;

  const at = o.timestamp;
  const level = o.level;
  const meta = o.metadata;
  return {
    version: 1,
    source,
    type,
    ...(typeof at === "number" && Number.isFinite(at) && at > 0 ? { timestamp: at } : {}),
    ...(text(o.treeHash) === "" ? {} : { treeHash: text(o.treeHash) }),
    ...(text(o.sessionId) === "" ? {} : { sessionId: text(o.sessionId) }),
    ...(level === "info" || level === "warning" || level === "error" ? { level } : {}),
    ...(text(o.summary) === "" ? {} : { summary: text(o.summary) }),
    ...(meta !== null && typeof meta === "object" && !Array.isArray(meta)
      ? { metadata: meta as Record<string, unknown> }
      : {}),
  };
}

export interface Receiver {
  path: string;
  close: () => Promise<void>;
}

// Is something already answering on this path? A socket file outlives the
// process that made it, so the choice is between stealing a live receiver's
// address and never starting after a crash. Connecting settles it.
async function answering(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = createConnection(path);
    const done = (live: boolean): void => {
      c.destroy();
      resolve(live);
    };
    c.on("connect", () => done(true));
    c.on("error", () => done(false));
  });
}

// Start receiving, or return null when another receiver already has the
// address. Null is not an error: two rails on one repo is a thing that
// happens, and the second one simply does not listen.
//
// `onEvent` is called on the socket's thread of control, so it must only
// enqueue. Anything expensive done here is done while the sender waits.
export async function listen(repo: string, onEvent: (e: ExternalEvent) => void): Promise<Receiver | null> {
  const path = socketPath(repo);
  try {
    await mkdir(join(repo, ".srcy"), { recursive: true });
    if (await answering(path)) return null;
    await unlink(path).catch(() => {});

    const server = createServer((sock) => {
      let buf = "";
      const drain = (): void => {
        for (;;) {
          const i = buf.indexOf("\n");
          if (i < 0) break;
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim() === "") continue;
          const ev = parseEvent(line);
          // Malformed is discarded, never fatal. A tool with a bug in its
          // hook must not be able to take the session down.
          if (ev !== null) {
            try {
              onEvent(ev);
            } catch {
              // whatever the rail did with it is the rail's problem
            }
          }
        }
      };
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        drain();
        // Checked after draining, so the cap applies to one unterminated
        // event rather than to a legitimate burst of complete ones.
        if (buf.length > MAX_EVENT_BYTES) {
          buf = "";
          sock.destroy();
        }
      });
      // A sender that wrote one object and closed without a newline still
      // said something; NDJSON's newline is a separator, not a terminator.
      sock.on("end", () => {
        if (buf.trim() !== "") {
          buf += "\n";
          drain();
        }
      });
      sock.on("error", () => {});
    });
    server.on("error", () => {});

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    // The endpoint is local and this user's. There is no authentication
    // because there is no network: anyone who can write here can already
    // write the repository.
    await chmod(path, 0o600).catch(() => {});

    return {
      path,
      close: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await unlink(path).catch(() => {});
      },
    };
  } catch {
    // A repo srcy cannot write to, a platform without Unix sockets: the
    // panels work exactly as they did before this file existed.
    return null;
  }
}

// One event, one line, and never a reason for the sender to wait around. The
// answer is whether it was delivered — not whether srcy liked it.
export async function send(repo: string, event: ExternalEvent, timeoutMs = 2000): Promise<boolean> {
  const path = socketPath(repo);
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(ok);
    };
    const sock = createConnection(path);
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref();
    sock.on("connect", () => {
      sock.end(`${JSON.stringify(event)}\n`, () => done(true));
    });
    sock.on("error", () => done(false));
  });
}
