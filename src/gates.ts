import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkCommand, parseProblems, runCommand, tailOf, type Problem } from "./checks.js";

// What srcy has actually verified, as more than one question.
//
// One CHECKS line answered "does the tree still build" and nothing else. The
// things a reader wants before believing a turn is done — does it typecheck,
// do the tests pass, does the linter agree — have different costs, and a
// pane that runs all of them on every quiet second is a pane people turn
// off. So gates are declared, each one auto or manual, and each one keeps
// its own verdict and the tree that verdict describes.

// Deliberately more states than pass/fail. "Not run" reading like "passing"
// is the failure that would make the whole pane worse than nothing, and a
// gate that ran out of time has not failed — nothing was proved either way.
export type Status = "not_run" | "running" | "pass" | "fail" | "timeout";

export interface Gate {
  name: string;
  command: string[];
  // Automatic gates run themselves once the tree stops moving. Expensive
  // ones are opted out and wait for `r`.
  auto: boolean;
  timeoutMs: number;
}

export interface GateResult {
  name: string;
  status: Status;
  problems: Problem[];
  tail: string;
  ms: number;
  // The tree fingerprint this verdict was measured against. When it stops
  // matching the current one the verdict is stale, which is said out loud
  // rather than shown as a current pass or a current failure.
  mark: string;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
// A gate is something a person is waiting on between turns, not a CI job.
const MAX_TIMEOUT_MS = 600_000;

// parseConfig reads the `gates` list out of .srcy/config.json.
//
// One bad gate invalidates the list rather than being skipped: a config that
// silently drops the gate you thought was running is the same lie as a pane
// that reports a pass it never measured. The error is shown, and srcy falls
// back to the command it can detect on its own.
export function parseConfig(raw: unknown): { gates: Gate[]; error?: string } {
  const list = (raw as { gates?: unknown } | null)?.gates;
  if (list === undefined) return { gates: [] };
  if (!Array.isArray(list)) return { gates: [], error: "gates must be a list" };

  const gates: Gate[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const o = item as { name?: unknown; command?: unknown; auto?: unknown; timeoutMs?: unknown } | null;
    const name = typeof o?.name === "string" ? o.name.trim() : "";
    if (name === "" || name.includes("\n")) return { gates: [], error: "every gate needs a one-line name" };
    if (seen.has(name)) return { gates: [], error: `two gates are named ${name}` };
    seen.add(name);

    const command = o?.command;
    // A shell string is refused rather than split: quoting, globs and pipes
    // would all have to work, and srcy runs the argv directly. A project
    // that needs a shell line has .srcy/check, which is one.
    if (typeof command === "string") {
      return { gates: [], error: `${name}: command is a list of words, not a shell line` };
    }
    if (!Array.isArray(command) || command.length === 0 || !command.every((w) => typeof w === "string" && w !== "")) {
      return { gates: [], error: `${name}: command must be a non-empty list of words` };
    }

    const t = o?.timeoutMs;
    if (t !== undefined && (typeof t !== "number" || !Number.isFinite(t) || t <= 0)) {
      return { gates: [], error: `${name}: timeoutMs must be a positive number of milliseconds` };
    }
    gates.push({
      name,
      command: command as string[],
      // Automatic by default. The rail's whole job is telling you the tree
      // is broken before you ask, and a config that quietly turned that off
      // for every gate would be a downgrade from having no config at all.
      auto: o?.auto !== false,
      timeoutMs: Math.min(typeof t === "number" ? t : DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
    });
  }
  return { gates };
}

// What srcy can detect without being told, kept exactly as it was: an
// executable .srcy/check, or the one npm script that is nearly always a fast
// correctness check. A project that had this working before configuring
// nothing keeps it.
async function detected(repo: string): Promise<Gate[]> {
  const argv = await checkCommand(repo);
  if (argv === null) return [];
  return [
    {
      name: argv[0] === "npm" ? (argv[2] ?? "check") : "check",
      command: argv,
      auto: true,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    },
  ];
}

export async function loadGates(repo: string): Promise<{ gates: Gate[]; error?: string }> {
  let text: string;
  try {
    text = await readFile(join(repo, ".srcy", "config.json"), "utf8");
  } catch {
    return { gates: await detected(repo) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { gates: await detected(repo), error: ".srcy/config.json is not valid JSON" };
  }
  const parsed = parseConfig(raw);
  if (parsed.error !== undefined) return { gates: await detected(repo), error: parsed.error };
  if (parsed.gates.length > 0) return parsed;
  return { gates: await detected(repo) };
}

export async function runGate(repo: string, gate: Gate, mark: string): Promise<GateResult> {
  const started = Date.now();
  const out = await runCommand(gate.command, repo, gate.timeoutMs);
  // Exit status is the verdict, not whatever the tool chose to print: a
  // linter that prints "error:" in its help text still passed.
  const status: Status = out.timedOut ? "timeout" : out.code === 0 ? "pass" : "fail";
  return {
    name: gate.name,
    status,
    problems: status === "pass" ? [] : parseProblems(out.text, repo),
    tail: tailOf(out.text),
    ms: Date.now() - started,
    mark,
  };
}

export interface Summary {
  passing: number;
  total: number;
  // Failing, timed out, or stale — everything that is not a fresh pass and
  // is not merely waiting to be run.
  attention: number;
}

// The headline. The numerator counts fresh passes only: a pass measured
// against a tree that has since moved is not evidence about this one.
export function summarise(gates: Gate[], results: GateResult[], mark: string): Summary {
  const by = new Map(results.map((r) => [r.name, r]));
  let passing = 0;
  let attention = 0;
  for (const g of gates) {
    const r = by.get(g.name);
    if (r === undefined) continue;
    const fresh = r.mark === mark;
    if (fresh && r.status === "pass") passing++;
    else if (r.status === "fail" || r.status === "timeout") attention++;
    else if (!fresh && r.status === "pass") attention++;
  }
  return { passing, total: gates.length, attention };
}

// Every failing location across the gates. The rail and the dock both list
// problems, and neither should have to know which gate found one — the
// reader's question is "what is broken".
//
// Staleness is not filtered here. A verdict measured against a tree that has
// moved is still the best evidence there is, and the pane says "code moved
// since" beside it: dropping the rows instead would make a stale failure
// look like a fix.
export function problemsOf(results: GateResult[]): Problem[] {
  const out: Problem[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.status !== "fail" && r.status !== "timeout") continue;
    for (const p of r.problems) {
      const key = `${p.path}:${p.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}
