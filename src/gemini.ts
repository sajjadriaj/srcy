import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { emptyFold, remember, spoken, when, type Fold, type Source } from "./transcript.js";

// Reading gemini-cli's chat log.
//
// Unlike the other three, gemini does not append: the whole chat is one JSON
// document, rewritten after every message, under
// ~/.gemini/tmp/<sha256 of the project path>/chats/. So this reader parses
// the file rather than folding lines, and readSession re-reads it whole
// whenever it changes.
//
// Written from the format as gemini-cli records it, and checked against
// nothing better than a session with no turns in it — the only kind on the
// machine this was written on. The shapes below are the documented ones.

const ROOT = join(homedir(), ".gemini", "tmp");

export function projectHash(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex");
}

export async function findSession(cwd: string, root = ROOT): Promise<string | null> {
  const chats = join(root, projectHash(cwd), "chats");
  let names: string[];
  try {
    names = await readdir(chats);
  } catch {
    return null;
  }
  let newest: { path: string; at: number } | null = null;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(chats, name);
    try {
      const at = (await stat(path)).mtimeMs;
      if (newest === null || at > newest.at) newest = { path, at };
    } catch {
      continue;
    }
  }
  return newest?.path ?? null;
}

interface Message {
  type?: unknown;
  timestamp?: unknown;
  content?: unknown;
  model?: unknown;
  tokens?: Record<string, unknown>;
  toolCalls?: unknown;
}

interface Call {
  id?: unknown;
  name?: unknown;
  args?: unknown;
  status?: unknown;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// Every current gemini model ships a million-token window, and the log does
// not say otherwise.
const WINDOW = 1_048_576;

const READS = new Set(["read_file", "read_many_files", "list_directory", "glob", "search_file_content", "google_web_search", "web_fetch"]);

// A call gemini has finished with. Anything else is still running.
const DONE = new Set(["success", "error", "cancelled"]);

function targetOf(args: unknown): string {
  const o = args as Record<string, unknown> | undefined;
  for (const key of ["description", "command", "file_path", "path", "pattern", "url"]) {
    const v = o?.[key];
    if (typeof v === "string" && v !== "") return v;
  }
  return "";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => String((p as { text?: unknown }).text ?? "")).join("\n");
}

export function parse(text: string): Fold {
  const f = emptyFold();
  let doc: { messages?: unknown };
  try {
    doc = JSON.parse(text) as typeof doc;
  } catch {
    return f;
  }
  if (!Array.isArray(doc?.messages)) return f;
  for (const raw of doc.messages) {
    const m = raw as Message;
    const at = when(m.timestamp);
    if (at !== undefined && at > (f.at ?? 0)) f.at = at;
    if (m.type === "user") {
      const said = spoken(textOf(m.content));
      if (said !== "" && at !== undefined) f.turn = { at, text: said };
      continue;
    }
    if (m.type !== "gemini") continue;
    if (typeof m.model === "string" && m.model !== "") f.model = m.model;
    const t = m.tokens;
    if (t !== undefined) {
      f.output += num(t.output);
      // `input` is the whole prompt, cached content included.
      const used = num(t.input);
      if (used > 0) {
        f.last = { used, cached: num(t.cached) / used };
        if (used > (f.peak ?? 0)) f.peak = used;
      }
    }
    const calls = Array.isArray(m.toolCalls) ? (m.toolCalls as Call[]) : [];
    for (const c of calls) {
      if (typeof c.id !== "string") continue;
      const name = typeof c.name === "string" ? c.name : "?";
      if (name === "run_shell_command" && at !== undefined) {
        const cmd = (c.args as { command?: unknown } | undefined)?.command;
        if (typeof cmd === "string" && cmd !== "") remember(f.ran, cmd, at);
      }
      if (at !== undefined && !READS.has(name)) f.wrote = at;
      if (DONE.has(String(c.status))) f.open.delete(c.id);
      else f.open.set(c.id, { tool: name, target: targetOf(c.args), since: at });
    }
    // A reply with text and no calls is the model handing the turn back;
    // one with calls is the model on its way to the next one.
    const said = textOf(m.content).trim();
    if (calls.length === 0 && said !== "") {
      if (at !== undefined) f.ended = at;
      f.reply = said;
    }
  }
  if (f.model !== undefined && f.model.startsWith("gemini")) f.window = WINDOW;
  return f;
}

export const GEMINI: Source = { find: findSession, fold: () => {}, parse };
