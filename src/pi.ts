import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { remember, spoken, when, type Fold, type Source } from "./transcript.js";

// Reading pi's session log.
//
// pi writes one JSON object per line, every message wrapped as
// `{type: "message", message: {...}}`, and opens the file with a header that
// names the directory the session runs in — the same two things the Claude
// and codex readers lean on, in a third spelling. Sessions are filed under
// ~/.pi/agent/sessions/<directory-key>/, but the key is a lossy encoding of
// the path, so the header is what identifies a session, not the folder.
//
// What pi does not record is the model's context window. A session on a
// local model may have 32k where the inference below assumes 200k; that is
// what SRCY_CONTEXT_WINDOW is for.

const SESSIONS = join(homedir(), ".pi", "agent", "sessions");

interface Message {
  role?: unknown;
  content?: unknown;
  usage?: Record<string, unknown>;
  stopReason?: unknown;
  model?: unknown;
  toolCallId?: unknown;
}

interface Part {
  type?: unknown;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

const HEAD_BYTES = 64 * 1024;

async function firstLine(path: string): Promise<string | null> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(path, "r");
    const buf = Buffer.allocUnsafe(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    const text = buf.toString("utf8", 0, bytesRead);
    const nl = text.indexOf("\n");
    return nl === -1 ? null : text.slice(0, nl);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

// Newest first, exact directory first, then anything running below it.
// ponytail: a readdir of every session directory each poll. Cache on the
// newest mtime if a machine with thousands of sessions makes this show up.
export async function findSession(cwd: string, root = SESSIONS): Promise<string | null> {
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return null;
  }
  const dated: { path: string; at: number }[] = [];
  for (const name of dirs) {
    let files: string[];
    try {
      files = await readdir(join(root, name));
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const path = join(root, name, f);
      try {
        dated.push({ path, at: (await stat(path)).mtimeMs });
      } catch {
        continue;
      }
    }
  }
  dated.sort((a, b) => b.at - a.at);
  let below: string | null = null;
  for (const { path } of dated) {
    const head = await firstLine(path);
    if (head === null) continue;
    try {
      const at = (JSON.parse(head) as { cwd?: unknown }).cwd;
      if (at === cwd) return path;
      if (below === null && typeof at === "string" && at.startsWith(`${cwd}/`)) below = path;
    } catch {
      continue;
    }
  }
  return below;
}

// pi's read-only tools. Anything unrecognised is assumed to write, for the
// reason the other readers give: a baseline that quietly contains half the
// work is worse than one that says it could not be taken.
const READS = new Set(["read", "ls", "grep", "find", "glob", "list", "web_fetch", "web_search", "fetch", "view_image"]);

function targetOf(args: unknown): string {
  const o = args as Record<string, unknown> | undefined;
  for (const key of ["description", "command", "path", "file_path", "pattern", "url"]) {
    const v = o?.[key];
    if (typeof v === "string" && v !== "") return v;
  }
  return "";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => (p as Part).type === "text")
    .map((p) => String((p as Part).text ?? ""))
    .join("\n");
}

export function foldLine(f: Fold, line: string): void {
  if (!line.includes('"type":"message"') && !line.includes('"model_change"')) return;
  let rec: { type?: unknown; timestamp?: unknown; message?: Message; modelId?: unknown };
  try {
    rec = JSON.parse(line) as typeof rec;
  } catch {
    return; // a half-written last line is normal: the agent is still going
  }
  const at = when(rec.timestamp);
  if (at !== undefined && at > (f.at ?? 0)) f.at = at;

  if (rec.type === "model_change") {
    if (typeof rec.modelId === "string" && rec.modelId !== "") f.model = rec.modelId;
    return;
  }
  if (rec.type !== "message" || rec.message === undefined) return;
  const m = rec.message;

  if (m.role === "user") {
    const text = spoken(textOf(m.content));
    if (text !== "" && at !== undefined) f.turn = { at, text };
    return;
  }

  if (m.role === "toolResult") {
    if (typeof m.toolCallId === "string") f.open.delete(m.toolCallId);
    return;
  }

  if (m.role !== "assistant") return;
  if (typeof m.model === "string" && m.model !== "") f.model = m.model;
  const u = m.usage;
  if (u !== undefined) {
    f.output += num(u.output);
    // What the request held: the uncached input plus what came from cache,
    // the same sum the Claude reader makes of its three input counts.
    const used = num(u.input) + num(u.cacheRead) + num(u.cacheWrite);
    if (used > 0) {
      f.last = { used, cached: num(u.cacheRead) / used };
      if (used > (f.peak ?? 0)) f.peak = used;
    }
  }
  if (Array.isArray(m.content)) {
    for (const raw of m.content) {
      const p = raw as Part;
      if (p.type !== "toolCall" || typeof p.id !== "string") continue;
      const name = typeof p.name === "string" ? p.name : "?";
      if (name === "bash" && at !== undefined) {
        const cmd = (p.arguments as { command?: unknown } | undefined)?.command;
        if (typeof cmd === "string" && cmd !== "") remember(f.ran, cmd, at);
      }
      if (at !== undefined && !READS.has(name)) f.wrote = at;
      f.open.set(p.id, { tool: name, target: targetOf(p.arguments), since: at });
    }
  }
  // `toolUse` is a model about to call something; every other stop is the
  // model handing the turn back.
  if (typeof m.stopReason === "string" && m.stopReason !== "toolUse") {
    if (at !== undefined) f.ended = at;
    const text = textOf(m.content).trim();
    if (text !== "") f.reply = text;
  }
}

export const PI: Source = { find: findSession, fold: foldLine };
