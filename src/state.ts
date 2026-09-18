import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GateResult } from "./gates.js";

// Verdicts that outlive the process that measured them.
//
// A gate's verdict carries the tree it was measured against, which is what
// makes it safe to write down: read back after a restart it is either still
// about this tree or it says "code moved since", and both are better answers
// than "not run yet" on a repo nothing has touched since the last run.
//
// This is also the only channel between `srcy verify` in one terminal and the
// rail in another. Last writer wins — ponytail: two writers is two people
// asking the same question, and the second answer is the newer one.

const FILE = "state.json";

// What the project is trying to do, as more than a line of text.
//
// The text itself lives in .srcy/task.md, which is committed, human-edited
// and outlives every session. What cannot live there is when it started and
// whether it is finished — those are facts about this working copy, so they
// live here beside the verdicts rather than in a third store.
export interface Mission {
  goal: string;
  startedAt: number;
  status: "active" | "completed" | "abandoned";
}

export interface Saved {
  at: number;
  results: GateResult[];
  mission?: Mission;
}

function path(repo: string): string {
  return join(repo, ".srcy", FILE);
}

async function read(repo: string): Promise<Saved | null> {
  try {
    return JSON.parse(await readFile(path(repo), "utf8")) as Saved;
  } catch {
    return null;
  }
}

export async function readMission(repo: string): Promise<Mission | undefined> {
  const m = (await read(repo))?.mission;
  if (m === undefined || typeof m.goal !== "string") return undefined;
  const status = m.status === "completed" || m.status === "abandoned" ? m.status : "active";
  return { goal: m.goal, startedAt: Number(m.startedAt) || 0, status };
}

export async function writeMission(repo: string, mission: Mission | undefined): Promise<void> {
  const current = await read(repo);
  await save(repo, { at: Date.now(), results: current?.results ?? [], mission });
}

export async function readResults(repo: string): Promise<GateResult[]> {
  const saved = await read(repo);
  // Hand-edited, half-written, or from a future version: an unreadable
  // verdict file must degrade to "nothing has run", never to a made-up pass.
  if (!Array.isArray(saved?.results)) return [];
  return saved.results.filter(
    (r) => typeof r?.name === "string" && typeof r?.status === "string" && typeof r?.mark === "string",
  );
}

export async function writeResults(repo: string, results: GateResult[]): Promise<void> {
  // The mission is carried across rather than re-read for each write: a gate
  // finishing must never be the thing that forgets what the session is for.
  await save(repo, { at: Date.now(), results, mission: await readMission(repo) });
}

async function save(repo: string, next: Saved): Promise<void> {
  const file = path(repo);
  try {
    await mkdir(join(repo, ".srcy"), { recursive: true });
    // Written whole and renamed into place: a reader on a timer is one
    // half-written file away from parsing nothing.
    await writeFile(`${file}.tmp`, JSON.stringify(next));
    await rename(`${file}.tmp`, file);
  } catch {
    // A repo srcy cannot write to still gets a working rail; it just starts
    // every session with nothing run.
  }
}

// ---------------------------------------------------------------------------
// What happened, in order
//
// The verdict file says what is true now. It cannot say how the tree got
// here — which gate went red first, whether the fix came before or after the
// test was written, how long the agent sat on one step. That is a different
// question and it wants an append-only answer.
//
// Only transitions are recorded, never polls: a line per tree observation
// would be a megabyte an hour describing nothing.

export interface SrcyEvent {
  at: number;
  type: string;
  detail?: string;
  // Set only on an event another tool sent. They land in this same log
  // rather than a history of their own: an event is an event, and a second
  // permanent store for the ones srcy did not generate would have to be kept
  // in step with this one forever.
  source?: string;
  level?: "info" | "warning" | "error";
  summary?: string;
  treeHash?: string;
  sessionId?: string;
  // When it arrived, kept beside the sender's own `at`. A tool that batches
  // its hooks, or a machine whose clock disagrees, is visible in the gap
  // rather than silently rewritten.
  receivedAt?: number;
  metadata?: Record<string, unknown>;
}

// ponytail: trimmed at a fixed size rather than rotated. A second file to
// keep a first file small is the shape of a problem nobody has yet.
const MAX_LOG_BYTES = 1_000_000;
const KEEP_LINES = 2000;

function logPath(repo: string): string {
  return join(repo, ".srcy", "events.jsonl");
}

export async function appendEvent(repo: string, type: string, detail?: string): Promise<void> {
  await appendRecord(repo, { at: Date.now(), type, ...(detail === undefined ? {} : { detail }) });
}

export async function appendRecord(repo: string, event: SrcyEvent): Promise<void> {
  const file = logPath(repo);
  try {
    await mkdir(join(repo, ".srcy"), { recursive: true });
    const size = await stat(file).then((s) => s.size).catch(() => 0);
    if (size > MAX_LOG_BYTES) {
      const kept = (await readFile(file, "utf8")).split("\n").filter((l) => l !== "").slice(-KEEP_LINES);
      await writeFile(file, `${kept.join("\n")}\n`);
    }
    await appendFile(file, `${JSON.stringify(event)}\n`);
  } catch {
    // The timeline is a convenience. Losing a line of it must never be the
    // reason a gate does not run.
  }
}

export async function readEvents(repo: string, limit = 40): Promise<SrcyEvent[]> {
  try {
    const lines = (await readFile(logPath(repo), "utf8")).split("\n").filter((l) => l !== "");
    const out: SrcyEvent[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        const e = JSON.parse(line) as SrcyEvent;
        if (typeof e?.type === "string") out.push(e);
      } catch {
        continue; // a half-written last line is normal
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Checkpoints
//
// A tree srcy has seen and what was true of it, kept without committing
// anything. `captureTree` already writes a real git tree object through a
// throwaway index, so a checkpoint is that hash plus the verdicts that stood
// at the time — which makes `checkpoint diff` an ordinary `git diff`.

export interface Checkpoint {
  n: number;
  at: number;
  tree: string;
  verification: { name: string; status: string }[];
}

function checkpointPath(repo: string): string {
  return join(repo, ".srcy", "checkpoints.jsonl");
}

export async function readCheckpoints(repo: string): Promise<Checkpoint[]> {
  try {
    const lines = (await readFile(checkpointPath(repo), "utf8")).split("\n").filter((l) => l !== "");
    const out: Checkpoint[] = [];
    for (const line of lines) {
      try {
        const c = JSON.parse(line) as Checkpoint;
        if (typeof c?.tree === "string" && typeof c?.n === "number") out.push(c);
      } catch {
        continue;
      }
    }
    return out;
  } catch {
    return [];
  }
}

export async function appendCheckpoint(repo: string, tree: string, results: GateResult[]): Promise<Checkpoint> {
  const previous = await readCheckpoints(repo);
  const c: Checkpoint = {
    n: (previous[previous.length - 1]?.n ?? 0) + 1,
    at: Date.now(),
    tree,
    verification: results.map((r) => ({ name: r.name, status: r.status })),
  };
  try {
    await mkdir(join(repo, ".srcy"), { recursive: true });
    await appendFile(checkpointPath(repo), `${JSON.stringify(c)}\n`);
  } catch {
    // Same bargain as the timeline: worth having, never worth failing over.
  }
  return c;
}
