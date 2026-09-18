import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
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
  // Whether VERIFIED is a claim about this gate. A required gate that has
  // not freshly passed means the tree is not verified; an optional one is
  // information. Required by default: a config that quietly narrowed what
  // green means would be worse than no config.
  required: boolean;
  // The paths this gate's verdict depends on. Empty means the whole tree,
  // which is what every gate meant before this existed. A typecheck that
  // reads only TypeScript is not invalidated by editing the README, and
  // saying it was is the same lie in the other direction as a stale pass.
  watch: string[];
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
// A file the project builds from other files, and the files it is built
// from. Not a gate: there is no command to run and nothing to wait for, only
// two timestamps to compare. But it is the same kind of claim -- something
// the project says should be true of the tree -- so it lands in the same
// place, with the same staleness language.
//
// `from` entries are paths or directory prefixes rather than globs. A glob
// engine is a lot of code to avoid writing `src` where you meant `src/**`,
// and the difference has never been the thing anyone got wrong.
export interface Derived {
  from: string[];
  to: string;
}

export function parseDerived(raw: unknown): { derived: Derived[]; error?: string } {
  const list = (raw as { derived?: unknown } | null)?.derived;
  if (list === undefined) return { derived: [] };
  if (!Array.isArray(list)) return { derived: [], error: "derived must be a list" };
  const out: Derived[] = [];
  for (const item of list) {
    const o = item as { from?: unknown; to?: unknown } | null;
    const to = typeof o?.to === "string" ? o.to.trim() : "";
    if (to === "") return { derived: [], error: "every derived entry needs a `to` path" };
    const from = o?.from;
    if (!Array.isArray(from) || from.length === 0 || !from.every((f) => typeof f === "string" && f !== "")) {
      return { derived: [], error: `${to}: from must be a non-empty list of paths` };
    }
    out.push({ to, from: from as string[] });
  }
  return { derived: out };
}

// Is each derived file newer than everything it is built from?
//
// A missing one has never been built, which is a different thing to say than
// "out of date" and is said differently. `paths` is the repo's file list,
// already read for the tree, so this costs a stat per candidate rather than a
// walk.
export async function checkDerived(cwd: string, list: Derived[], paths: string[], mark: string): Promise<GateResult[]> {
  const out: GateResult[] = [];
  for (const d of list) {
    const name = d.to.split("/").pop() ?? d.to;
    let built: number;
    try {
      built = (await stat(join(cwd, d.to))).mtimeMs;
    } catch {
      out.push({ name, status: "fail", problems: [], tail: "never built", ms: 0, mark });
      continue;
    }
    let newest = { path: "", at: 0 };
    for (const p of paths) {
      if (p === d.to) continue;
      if (!d.from.some((f) => p === f || p.startsWith(`${f}/`))) continue;
      try {
        const at = (await stat(join(cwd, p))).mtimeMs;
        if (at > newest.at) newest = { path: p, at };
      } catch {
        continue; // deleted between the listing and the stat
      }
    }
    out.push(
      newest.at > built
        ? // Basename: the rail is a narrow column, and the whole path clips —
          // which loses more than the directory does.
          { name, status: "fail", problems: [], tail: `older than ${newest.path.split("/").pop() ?? newest.path}`, ms: 0, mark }
        : { name, status: "pass", problems: [], tail: "", ms: 0, mark },
    );
  }
  return out;
}

// Derived files are shown as gates because they are the same claim, but they
// are never queued: there is no command, and `runGate` would spawn nothing.
// Not required: VERIFIED is a claim about the commands a project declared as
// verification, and a derived file is a timestamp comparison rather than one
// of them. A stale artifact still earns its row and its ATTENTION line — it
// just does not decide whether the tree is trusted.
export function derivedGates(list: Derived[]): Gate[] {
  return list.map((d) => ({
    name: d.to.split("/").pop() ?? d.to,
    command: [],
    auto: false,
    timeoutMs: 0,
    required: false,
    watch: [],
  }));
}

export function parseConfig(raw: unknown): { gates: Gate[]; error?: string } {
  const list = (raw as { gates?: unknown } | null)?.gates;
  if (list === undefined) return { gates: [] };
  if (!Array.isArray(list)) return { gates: [], error: "gates must be a list" };

  const gates: Gate[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const o = item as {
      name?: unknown;
      command?: unknown;
      auto?: unknown;
      timeoutMs?: unknown;
      required?: unknown;
      watch?: unknown;
    } | null;
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

    const watch = o?.watch;
    // Refused rather than ignored, for the reason a mistyped gate name is:
    // a watch list srcy silently dropped is a gate that looks scoped and
    // re-runs on every edit, or worse, one that looks scoped and never goes
    // stale at all.
    if (watch !== undefined && (!Array.isArray(watch) || !watch.every((w) => typeof w === "string" && w !== ""))) {
      return { gates: [], error: `${name}: watch must be a list of paths` };
    }

    gates.push({
      name,
      command: command as string[],
      required: o?.required !== false,
      watch: (watch as string[] | undefined) ?? [],
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
      required: true,
      watch: [],
    },
  ];
}

export async function loadGates(repo: string): Promise<{ gates: Gate[]; derived: Derived[]; error?: string }> {
  let text: string;
  try {
    text = await readFile(join(repo, ".srcy", "config.json"), "utf8");
  } catch {
    return { gates: await detected(repo), derived: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { gates: await detected(repo), derived: [], error: ".srcy/config.json is not valid JSON" };
  }
  const parsed = parseConfig(raw);
  const built = parseDerived(raw);
  const error = parsed.error ?? built.error;
  if (error !== undefined) return { gates: await detected(repo), derived: [], error };
  const gates = parsed.gates.length > 0 ? parsed.gates : await detected(repo);
  return { gates, derived: built.derived };
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
    // Stamped with the gate name: the dock and the CLI both list problems
    // from several gates at once, and "what is broken" is a poorer answer
    // than "what is broken, and which check noticed".
    problems: status === "pass" ? [] : parseProblems(out.text, repo, gate.name),
    tail: tailOf(out.text),
    ms: Date.now() - started,
    mark,
  };
}

// ---------------------------------------------------------------------------
// Selective staleness
//
// One fingerprint for the whole tree makes every verdict stale the moment
// anything moves, which trains the reader to ignore the word. A gate that
// declares what it reads gets a fingerprint of exactly that, so editing a
// README leaves the typecheck's pass standing — and editing a `.ts` file
// still invalidates it, which is the half that must never break.

// Three shapes, not a glob engine: a directory prefix (`src`, or `src/**`),
// an extension across the tree (`**/*.ts`), or an exact path. Anything else
// matches nothing, which is visible immediately — the gate never goes stale.
// A project whose watch list needs more than this leaves it out and gets the
// whole tree, which is what it had before.
export function watched(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  return patterns.some((raw) => {
    if (raw.startsWith("**/*")) return path.endsWith(raw.slice(4));
    const p = raw.replace(/\/\*\*$/, "").replace(/^\.\//, "").replace(/\/$/, "");
    if (p === "" || p === ".") return true;
    return path === p || path.startsWith(`${p}/`);
  });
}

// The fingerprint a gate's verdict is measured against: the whole tree's,
// or a hash of only the changed files it watches.
//
// `stamps` is one entry per changed file, sorted, as RepoState carries it.
// A gate whose watched files are all unchanged hashes an empty list, which
// is a constant — so its verdict stays fresh across every edit elsewhere,
// which is the entire point.
export function markFor(mark: string, stamps: [string, string][], watch: string[]): string {
  if (watch.length === 0) return mark;
  const h = createHash("sha1");
  for (const [path, stamp] of stamps) {
    if (!watched(path, watch)) continue;
    h.update(path).update(" ").update(stamp).update("");
  }
  return h.digest("hex");
}

// Every gate's own fingerprint, computed once per frame. Passed around as a
// map rather than recomputed at each comparison because the rail asks the
// same question from four places.
export type Marks = Map<string, string>;

export function marksFor(gates: Gate[], mark: string, stamps: [string, string][]): Marks {
  return new Map(gates.map((g) => [g.name, markFor(mark, stamps, g.watch)]));
}

// What a gate's verdict should be compared against. The plain tree mark is
// the fallback so every existing caller keeps working unchanged: a gate with
// no watch list is measured against the whole tree either way.
export function markOf(gate: Gate, mark: string, marks?: Marks): string {
  return marks?.get(gate.name) ?? mark;
}

export function isFresh(gate: Gate, result: GateResult | undefined, mark: string, marks?: Marks): boolean {
  return result !== undefined && result.mark === markOf(gate, mark, marks);
}

// ---------------------------------------------------------------------------
// Trust

// VERIFIED, and nothing subjective in it: every required gate has passed,
// and each of those passes was measured against the tree that is there now.
//
// A project with no required gate is never verified. Vacuous truth is the
// one answer this must not give — "green" on a repo that verifies nothing is
// exactly the lie the rest of this file exists to prevent.
export function verified(gates: Gate[], results: GateResult[], mark: string, marks?: Marks): boolean {
  const required = gates.filter((g) => g.required);
  if (required.length === 0) return false;
  const by = new Map(results.map((r) => [r.name, r]));
  return required.every((g) => {
    const r = by.get(g.name);
    return r !== undefined && r.status === "pass" && isFresh(g, r, mark, marks);
  });
}

// One line per thing that is not a fresh pass, worst first. The rail already
// lists failing locations; this is the same question asked where there is no
// rail — `srcy status`, and anything reading its output.
export interface Attention {
  severity: "error" | "warning";
  gate: string;
  detail: string;
}

export function attention(gates: Gate[], results: GateResult[], mark: string, marks?: Marks): Attention[] {
  const by = new Map(results.map((r) => [r.name, r]));
  const out: Attention[] = [];
  for (const g of gates) {
    const r = by.get(g.name);
    if (r === undefined) continue; // not run is not a finding, it is an absence
    if (r.status === "fail" || r.status === "timeout") {
      const where = r.problems[0];
      const detail =
        r.status === "timeout"
          ? `timed out after ${Math.round(r.ms / 1000)}s`
          : where !== undefined
            ? `${where.path}:${where.line}  ${where.message}`
            : (r.tail.split("\n").find((l) => l.trim() !== "") ?? "failing");
      // A stale failure is still a failure — it is the best evidence there
      // is — and saying so beats dropping the row, which would read as a fix.
      out.push({ severity: "error", gate: g.name, detail: isFresh(g, r, mark, marks) ? detail : `${detail} (stale)` });
      continue;
    }
    if (r.status === "pass" && !isFresh(g, r, mark, marks)) {
      out.push({ severity: "warning", gate: g.name, detail: "code moved since it ran" });
    }
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
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
export function summarise(gates: Gate[], results: GateResult[], mark: string, marks?: Marks): Summary {
  const by = new Map(results.map((r) => [r.name, r]));
  let passing = 0;
  let attention = 0;
  for (const g of gates) {
    const r = by.get(g.name);
    if (r === undefined) continue;
    const fresh = isFresh(g, r, mark, marks);
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
  // Errors before warnings across every gate, stable inside each. The rail
  // has room for three rows; a lint run's warnings must not be the three.
  return out
    .map((p, i) => [p, i] as const)
    .sort(([a, i], [b, j]) => (a.severity === b.severity ? i - j : a.severity === "error" ? -1 : 1))
    .map(([p]) => p);
}
