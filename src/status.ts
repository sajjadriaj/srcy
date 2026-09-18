import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentState } from "./agent.js";
import { parseEvent, send, type ExternalEvent } from "./events.js";
import { git, gitRaw } from "./git.js";
import {
  attention,
  checkDerived,
  type Attention,
  derivedGates,
  isFresh,
  loadGates,
  markFor,
  marksFor,
  runGate,
  verified,
  type Gate,
  type GateResult,
} from "./gates.js";
import { listPaths, loadTask, repoState } from "./repo.js";
import { captureTree } from "./scopes.js";
import {
  appendCheckpoint,
  appendEvent,
  type SrcyEvent,
  readCheckpoints,
  readEvents,
  readMission,
  readResults,
  writeMission,
  writeResults,
  type Mission,
} from "./state.js";

// srcy without the panes.
//
// The rail answers "can this state be trusted" to somebody looking at a
// terminal. The same question has to be answerable to a script, a git hook,
// or a person over ssh with no tmux — otherwise VERIFIED is a colour rather
// than a fact. These commands share the engine the rail uses and add nothing
// of their own: the same gates, the same marks, the same word.

// PASS, FAIL and STALE are the words, deliberately shouted: they are what a
// reader greps for, and this output is as likely to be piped as read.
function verdict(gate: Gate, r: GateResult | undefined, mark: string, marks: Map<string, string>): string {
  if (r === undefined) return gate.auto ? "not run" : "not run (manual)";
  const fresh = isFresh(gate, r, mark, marks);
  if (r.status === "pass") return fresh ? "PASS" : "STALE";
  if (r.status === "timeout") return fresh ? "TIMEOUT" : "TIMEOUT (stale)";
  return fresh ? "FAIL" : "FAIL (stale)";
}

function took(r: GateResult | undefined): string {
  return r === undefined || r.ms === 0 ? "" : `  ${(r.ms / 1000).toFixed(1)}s`;
}

const NAME = 12;

// Everything srcy knows about the tree, as text. Pure so it can be tested
// without a terminal, and so `srcy status` is one call plus a write.
// How long, in the words anyone actually reads. Coarse past a minute: nobody
// reads the seconds of a two-hour mission.
export function since(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function report(
  task: string,
  branch: string,
  files: { added: number; removed: number }[],
  gates: Gate[],
  results: GateResult[],
  mark: string,
  // One entry per changed file, as RepoState carries them. Passed in rather
  // than recomputed so a gate that watches only part of the tree is judged
  // stale here by exactly the rule the rail uses.
  stamps: [string, string][] = [],
  configError?: string,
  mission?: Mission,
  agent?: { agent: string; status: string; activity?: string; since?: number } | null,
  now = Date.now(),
  // What other tools have said, already reduced to one row per source. They
  // are passed in rather than read here so that this stays a pure function
  // of what it is given — and so that a repo with no integrations pays
  // nothing at all for the feature.
  outside: Attention[] = [],
  sources: string[] = [],
): string {
  const marks = marksFor(gates, mark, stamps);
  const out: string[] = [];
  out.push("Mission");
  // The text and the state come from two places on purpose: the words are in
  // .srcy/task.md, which is committed and outlives the working copy, and
  // "started, and not finished yet" is a fact about this copy alone.
  const goal = task !== "" ? task : (mission?.goal ?? "");
  const state =
    mission === undefined ? "" : `  ${mission.status}${mission.startedAt > 0 ? ` ${since(now - mission.startedAt)}` : ""}`;
  out.push(`  ${goal === "" ? '(none — srcy mission start "…")' : `${goal}${state}`}`);
  if (agent !== undefined && agent !== null) {
    out.push("Agent");
    const doing = agent.activity === undefined ? "" : `  ${agent.activity}`;
    const age = agent.since === undefined ? "" : `  ${since(now - agent.since)}`;
    out.push(`  ${agent.agent}  ${agent.status}${doing}${age}`);
  }
  out.push("Repository");
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const churn = files.length === 0 ? "clean" : `${files.length} file${files.length === 1 ? "" : "s"}  +${added} -${removed}`;
  out.push(`  ${branch}  ${churn}`);
  out.push("Verification");
  if (configError !== undefined) out.push(`  ${configError}`);
  if (gates.length === 0) {
    out.push("  none configured — add .srcy/config.json or an executable .srcy/check");
  } else {
    const by = new Map(results.map((r) => [r.name, r]));
    for (const g of gates) {
      const r = by.get(g.name);
      const flag = g.required ? "" : "  (optional)";
      out.push(`  ${g.name.padEnd(NAME)}${verdict(g, r, mark, marks)}${took(r)}${flag}`);
    }
  }
  if (sources.length > 0) {
    // Nothing is registered and nothing is configured: a source exists
    // because it spoke. It stops existing when its events age out of the log.
    out.push("Sources");
    out.push(`  ${sources.join("  ")}`);
  }
  // srcy's own findings first, then everybody else's, each still worded by
  // whoever found it.
  const items = [...attention(gates, results, mark, marks), ...outside];
  out.push("Attention");
  if (items.length === 0) out.push("  nothing");
  for (const a of items) out.push(`  ${a.severity === "error" ? "✗" : "!"} ${a.gate.padEnd(NAME - 2)}${a.detail}`);
  out.push("State");
  // The whole product in one word, and it is a claim about required gates
  // against this exact tree — nothing softer.
  out.push(`  ${verified(gates, results, mark, marks) ? "VERIFIED" : "UNVERIFIED"}`);
  return out.join("\n");
}

// The gates plus the derived-artifact checks, which are the same claim and
// are cheap enough to re-measure every time they are asked about.
async function readAll(repo: string, mark: string): Promise<{ gates: Gate[]; results: GateResult[]; error?: string }> {
  const loaded = await loadGates(repo);
  const built = derivedGates(loaded.derived);
  const derived = built.length === 0 ? [] : await checkDerived(repo, loaded.derived, await listPaths(repo), mark);
  return { gates: [...loaded.gates, ...built], results: [...(await readResults(repo)), ...derived], error: loaded.error };
}

export async function status(repo: string): Promise<number> {
  const state = await repoState(repo);
  const branch = await git(repo, "rev-parse", "--abbrev-ref", "HEAD").catch(() => "(detached)");
  const { gates, results, error } = await readAll(repo, state.mark);
  const events = await readEvents(repo, 200);
  const outside = events.filter((e) => e.source !== undefined);
  // Only captured when somebody actually named a tree, so a repo with no
  // integrations never pays for the comparison.
  const treeNow = outside.some((e) => e.treeHash !== undefined) ? await captureTree(repo) : null;
  console.log(
    report(
      await loadTask(repo),
      branch,
      state.files,
      gates,
      results,
      state.mark,
      state.stamps,
      error,
      await readMission(repo),
      // Optional by construction: a repo where no agent has written a
      // transcript still gets every other line of this.
      await agentState(repo).catch(() => null),
      Date.now(),
      sourceAttention(events, treeNow),
      [...new Set(outside.map((e) => e.source!))],
    ),
  );
  return verified(gates, results, state.mark, marksFor(gates, state.mark, state.stamps)) ? 0 : 1;
}

// Run the project's gates now, against the tree that is there now.
//
// Exit status is the VERIFIED claim, which is the point of having it: a hook
// or a script can ask srcy the same question the rail answers in colour.
export async function verify(repo: string, only?: string): Promise<number> {
  const state = await repoState(repo);
  const loaded = await loadGates(repo);
  if (loaded.error !== undefined) console.error(`srcy: ${loaded.error}`);

  const runnable = loaded.gates.filter((g) => g.command.length > 0);
  const chosen = only === undefined ? runnable : runnable.filter((g) => g.name === only);
  if (only !== undefined && chosen.length === 0) {
    console.error(`srcy: no gate named ${only}${runnable.length === 0 ? "" : ` — try ${runnable.map((g) => g.name).join(", ")}`}`);
    return 2;
  }
  if (chosen.length === 0) {
    console.error("srcy: nothing to verify — add .srcy/config.json or an executable .srcy/check");
    return 1;
  }

  const saved = await readResults(repo);
  const results = new Map(saved.map((r) => [r.name, r]));
  for (const gate of chosen) {
    // To stderr so that a caller piping the verdicts is not reading progress
    // notes as results.
    process.stderr.write(`${gate.name}…\n`);
    await appendEvent(repo, "gate.start", gate.name);
    const r = await runGate(repo, gate, markFor(state.mark, state.stamps, gate.watch));
    results.set(r.name, r);
    await appendEvent(repo, `gate.${r.status}`, `${gate.name}  ${Math.round(r.ms / 1000)}s`);
    const marks = marksFor([gate], state.mark, state.stamps);
    console.log(`${gate.name.padEnd(NAME)}${verdict(gate, r, state.mark, marks)}${took(r)}`);
    for (const p of r.problems.slice(0, 5)) console.log(`  ${p.path}:${p.line}  ${p.message}`);
  }
  const all = [...results.values()];
  await writeResults(repo, all);

  // One gate was asked about, so one gate decides the answer. Asking about
  // `unit` and being told the repo is unverified because nobody ran the
  // linter is an answer to a question nobody asked.
  if (only !== undefined) {
    const r = results.get(only);
    return r !== undefined && r.status === "pass" ? 0 : 1;
  }
  const marks = marksFor(loaded.gates, state.mark, state.stamps);
  const ok = verified(loaded.gates, all, state.mark, marks);
  console.log(ok ? "VERIFIED" : "UNVERIFIED");
  return ok ? 0 : 1;
}

// What srcy resolved, before it runs anything. The config errors were only
// ever visible inside the rail, which is the wrong place for "why is my gate
// not running" — that question gets asked by someone who has not got the rail
// open yet.
export async function doctor(repo: string): Promise<number> {
  const loaded = await loadGates(repo);
  const out: string[] = [`repo     ${repo}`];
  if (loaded.error !== undefined) out.push(`config   ${loaded.error}`);
  out.push(`task     ${(await loadTask(repo)) || "(none — write .srcy/task.md)"}`);
  if (loaded.gates.length === 0) {
    out.push("gates    none — add .srcy/config.json or an executable .srcy/check");
  }
  for (const g of loaded.gates) {
    const how = `${g.auto ? "auto" : "manual"} ${g.required ? "required" : "optional"} ${Math.round(g.timeoutMs / 1000)}s`;
    out.push(`gate     ${g.name.padEnd(NAME)}${how}  ${g.command.join(" ")}`);
    out.push(`         ${" ".repeat(NAME)}watches ${g.watch.length === 0 ? "the whole tree" : g.watch.join(", ")}`);
  }
  for (const d of loaded.derived) out.push(`derived  ${d.to} ← ${d.from.join(", ")}`);
  console.log(out.join("\n"));
  return loaded.error === undefined ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Mission

// The goal in two halves, written to the two places each half belongs. The
// text goes to .srcy/task.md, which the rail already reads and which a
// project can commit; the clock and the status go to the runtime state.
export async function mission(repo: string, verb?: string, rest: string[] = []): Promise<number> {
  const current = await readMission(repo);
  const task = await loadTask(repo);

  if (verb === undefined) {
    const goal = task !== "" ? task : (current?.goal ?? "");
    if (goal === "") {
      console.log('no mission — srcy mission start "what you are trying to do"');
      return 1;
    }
    const age = current === undefined || current.startedAt === 0 ? "" : `  ${since(Date.now() - current.startedAt)}`;
    console.log(`${goal}\n${current?.status ?? "active"}${age}`);
    return 0;
  }

  if (verb === "start") {
    const goal = rest.join(" ").trim();
    if (goal === "") {
      console.error('srcy: srcy mission start "what you are trying to do"');
      return 2;
    }
    await mkdir(join(repo, ".srcy"), { recursive: true });
    // The file is the durable half, and it is written as markdown because
    // that is what the rail already reads and what a human will edit next.
    await writeFile(join(repo, ".srcy", "task.md"), `# ${goal}\n`);
    await writeMission(repo, { goal, startedAt: Date.now(), status: "active" });
    await appendEvent(repo, "mission.start", goal);
    console.log(`mission: ${goal}`);
    return 0;
  }

  if (verb === "complete" || verb === "abandon") {
    const goal = current?.goal ?? task;
    if (goal === "") {
      console.error("srcy: no mission to finish");
      return 1;
    }
    const status = verb === "complete" ? "complete" : "abandon";
    // Completing does not erase task.md. The words are the record of what
    // this working copy was for, and deleting them on the way out is how a
    // reader loses the answer to "what was I doing".
    await writeMission(repo, {
      goal,
      startedAt: current?.startedAt ?? 0,
      status: verb === "complete" ? "completed" : "abandoned",
    });
    await appendEvent(repo, `mission.${status}`, goal);
    console.log(`${verb === "complete" ? "completed" : "abandoned"}: ${goal}`);
    return 0;
  }

  console.error(`srcy: no mission verb ${verb} — try start, complete, abandon`);
  return 2;
}

// ---------------------------------------------------------------------------
// Checkpoints

// A tree srcy has seen, and what was true of it, without committing
// anything. The tree object is real and written through a throwaway index,
// so comparing two checkpoints is an ordinary `git diff` and nothing here
// has to store a copy of the files.
export async function checkpoint(repo: string, verb?: string, rest: string[] = []): Promise<number> {
  if (verb === undefined) {
    const tree = await captureTree(repo);
    if (tree === null) {
      console.error("srcy: could not capture the tree — a locked index, or a repo mid-rebase");
      return 1;
    }
    const c = await appendCheckpoint(repo, tree, await readResults(repo));
    await appendEvent(repo, "checkpoint", `#${c.n} ${tree.slice(0, 8)}`);
    console.log(`checkpoint #${c.n}`);
    console.log(`tree: ${tree.slice(0, 12)}`);
    for (const v of c.verification) console.log(`  ${v.name.padEnd(NAME)}${v.status}`);
    return 0;
  }

  if (verb === "list") {
    const all = await readCheckpoints(repo);
    if (all.length === 0) {
      console.log("no checkpoints — srcy checkpoint");
      return 1;
    }
    for (const c of all) {
      const passed = c.verification.filter((v) => v.status === "pass").length;
      const when = new Date(c.at).toTimeString().slice(0, 5);
      console.log(`#${String(c.n).padEnd(3)} ${when}  ${c.tree.slice(0, 8)}  ${passed}/${c.verification.length}`);
    }
    return 0;
  }

  if (verb === "diff") {
    const all = await readCheckpoints(repo);
    const find = (n: string): string | undefined => all.find((c) => String(c.n) === n.replace(/^#/, ""))?.tree;
    const [a, b] = rest;
    if (a === undefined) {
      console.error("srcy: srcy checkpoint diff <n> [<n>]");
      return 2;
    }
    const from = find(a);
    if (from === undefined) {
      console.error(`srcy: no checkpoint ${a}`);
      return 2;
    }
    // One argument means "against what is here now", which is the comparison
    // anyone actually wants from a checkpoint they set an hour ago.
    const to = b === undefined ? await captureTree(repo) : find(b);
    if (to === undefined || to === null) {
      console.error(`srcy: no checkpoint ${b ?? "for the current tree"}`);
      return 2;
    }
    const out = await gitRaw(repo, "diff", from, to).catch(() => "");
    if (out.trim() === "") {
      console.log("no difference");
      return 0;
    }
    process.stdout.write(out);
    return 0;
  }

  console.error(`srcy: no checkpoint verb ${verb} — try list, diff`);
  return 2;
}

// ---------------------------------------------------------------------------
// Timeline

// How the tree got here, which the verdict file cannot say. Only transitions
// are recorded, never polls — a line per observation would be a megabyte an
// hour describing nothing.
export async function timeline(repo: string, limit = 40): Promise<number> {
  const events = await readEvents(repo, limit);
  if (events.length === 0) {
    console.log("nothing recorded yet");
    return 1;
  }
  // One capture, for the whole listing: an external tool names the tree its
  // work was about, and whether that tree is still the one here is the only
  // thing srcy says about somebody else's result.
  const now = events.some((e) => e.treeHash !== undefined) ? await captureTree(repo) : null;
  for (const e of events) console.log(line(e, now));
  return 0;
}

// srcy's own events and other tools' events, in one column. The source stands
// where the event type stands for srcy's own, because "who said this" is the
// first question about a line srcy did not write.
export function line(e: SrcyEvent, treeNow: string | null): string {
  const when = new Date(e.at).toTimeString().slice(0, 8);
  if (e.source === undefined) return `${when}  ${e.type.padEnd(16)}${e.detail ?? ""}`.trimEnd();
  // Padded to the same width whether or not there is a marker, so the source
  // column starts in one place and the eye can run down it.
  const mark = e.level === "error" ? " ✗ " : e.level === "warning" ? " ! " : "   ";
  // The type is the fallback, not a second column: a tool that wrote a
  // summary has already said this better than its own event name does.
  const said = e.summary ?? e.type;
  const moved = e.treeHash !== undefined && treeNow !== null && e.treeHash !== treeNow ? "  · earlier tree" : "";
  return `${when}${mark}${e.source.padEnd(14)}${said}${moved}`.trimEnd();
}

// What other tools are currently saying is wrong.
//
// One row per source: its newest event that carried a level at all. A tool
// that reported an error and then reported something fine has said the
// second thing more recently, and srcy repeats whichever came last rather
// than deciding for itself that the error still stands.
//
// srcy never promotes or demotes a level. A result the sender called `info`
// is information, whatever its metadata might suggest to a reader who knew
// what that tool meant — and srcy is the one reader that must not know.
export function sourceAttention(events: SrcyEvent[], treeNow: string | null): Attention[] {
  const newest = new Map<string, SrcyEvent>();
  for (const e of events) {
    if (e.source === undefined || e.level === undefined) continue;
    newest.set(e.source, e);
  }
  const out: Attention[] = [];
  for (const [source, e] of newest) {
    if (e.level !== "warning" && e.level !== "error") continue;
    const moved = e.treeHash !== undefined && treeNow !== null && e.treeHash !== treeNow ? " (earlier tree)" : "";
    out.push({ severity: e.level === "error" ? "error" : "warning", gate: source, detail: `${e.summary ?? e.type}${moved}` });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ingestion

// One event from another tool, read off flags or off stdin.
//
// The contract is deliberately one command with no library behind it: a hook
// in shell, Python, Rust or a CI step can do this, and a tool that has never
// heard of srcy stays a tool that has never heard of srcy.
export async function emit(repo: string, argv: string[]): Promise<number> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i < 0 ? undefined : argv[i + 1];
  };
  // Failing closed is the wrong default here. A tool that breaks because the
  // thing watching it is not running is a tool that has been coupled to it,
  // which is the one outcome this whole path exists to prevent.
  const strict = argv.includes("--strict");
  const fail = (msg: string): number => {
    if (strict) console.error(`srcy: ${msg}`);
    return strict ? 1 : 0;
  };

  let event: ExternalEvent | null;
  if (argv.includes("--stdin")) {
    const raw = await readStdin();
    // Several lines is several events, because that is what a tool piping its
    // output looks like. One bad line among good ones loses only itself.
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) return fail("nothing on stdin");
    let sent = 0;
    let bad = 0;
    for (const line of lines) {
      const one = parseEvent(line);
      if (one === null) {
        bad++;
        continue;
      }
      if (await send(repo, stamped(one))) sent++;
    }
    if (bad > 0 && strict) console.error(`srcy: ${bad} malformed event${bad === 1 ? "" : "s"}`);
    if (sent === 0) return fail("no srcy is listening");
    return bad > 0 && strict ? 1 : 0;
  }

  const source = flag("source") ?? "";
  const type = flag("type") ?? "";
  if (source === "" || type === "") {
    // A usage error is the sender's own mistake rather than srcy's absence,
    // so it is worth saying out loud either way.
    console.error('srcy: srcy emit --source <name> --type <name>  (or --stdin)');
    return 2;
  }
  const metadata = flag("metadata");
  event = parseEvent(
    JSON.stringify({
      version: 1,
      source,
      type,
      level: flag("level"),
      summary: flag("summary"),
      treeHash: flag("tree"),
      sessionId: flag("session") ?? process.env.SRCY_SESSION_ID,
      metadata: metadata === undefined ? undefined : safeJson(metadata),
    }),
  );
  if (event === null) return fail("the event envelope is not valid");
  return (await send(repo, stamped(event))) ? 0 : fail("no srcy is listening");
}

// The sender's own timestamp is preserved when it set one; srcy fills in the
// receive time when it did not, and keeps both when it did.
function stamped(e: ExternalEvent): ExternalEvent {
  return e.timestamp === undefined ? { ...e, timestamp: Date.now() } : e;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // Not JSON is not a reason to drop the event: it is one string the tool
    // wanted carried, and carrying it is all srcy was ever going to do.
    return { value: raw };
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
