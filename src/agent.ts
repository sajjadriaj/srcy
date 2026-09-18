import { stat } from "node:fs/promises";
import { CODEX } from "./codex.js";
import { CLAUDE, readSession, type Source } from "./transcript.js";

// Which agent, if any, is working here.
//
// srcy never talks to an agent — it reads the transcript the agent writes for
// itself — so an adapter is two functions and a name, and everything else in
// srcy works with no adapter at all. This module exists so that "which one is
// it" is answered by looking at the repo rather than by being told, which is
// what a `srcy status` over ssh has to do.

export const ADAPTERS: Source[] = [CLAUDE, CODEX];

// The normalised shape, deliberately thin. Anything richer would be a
// promise srcy cannot keep for the next agent that comes along.
export interface AgentState {
  agent: string;
  // `working` is a tool call in flight. `waiting` is the agent having
  // stopped, which is a different thing to know and the one that means the
  // ball is with you.
  status: "working" | "waiting";
  activity?: string;
  since?: number;
}

// The adapter whose session file was written most recently, or null when no
// agent has written one here. Newest wins for the same reason it does inside
// each adapter: it is the session being typed into.
export async function detectSource(cwd: string): Promise<Source | null> {
  let best: { source: Source; at: number } | null = null;
  for (const source of ADAPTERS) {
    const path = await source.find(cwd).catch(() => null);
    if (path === null) continue;
    const at = await stat(path).then((s) => s.mtimeMs).catch(() => 0);
    if (best === null || at > best.at) best = { source, at };
  }
  return best?.source ?? null;
}

export async function agentState(cwd: string): Promise<AgentState | null> {
  const source = await detectSource(cwd);
  if (source === null) return null;
  const session = await readSession(cwd, source).catch(() => null);
  if (session === null) return null;
  const a = session.activity;
  return {
    agent: source.name,
    status: a === null ? "waiting" : "working",
    ...(a === null ? {} : { activity: `${a.tool}${a.target === "" ? "" : ` ${a.target}`}` }),
    ...(a?.since === undefined ? (session.at === undefined ? {} : { since: session.at }) : { since: a.since }),
  };
}
