import type { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { AgentSession, AgentUpdate, PermissionRequest } from "./acp.js";
import { blastRadius, type Symbol as BlastSymbol } from "./blast.js";
import { runChecks, type CheckResult } from "./checks.js";
import {
  ChecksPane,
  densityBar,
  dur,
  SLOW_MS,
  UsageBar,
  type Usage,
  LiveDiff,
  mapEntries,
  outline,
  Outline,
  PlanBar,
  planFrom,
  FilePicker,
  RepoMap,
  type PlanEntry,
} from "./cockpit.js";
import { changedLines, patchPaths, Review, splitDiff, type FileDiff, type Hunk } from "./diff.js";
import { filterFiles, listFiles } from "./files.js";
import { lineOrigins, type LineOrigin } from "./provenance.js";
import { applyPatch, commitAccepted, dirtyPaths, type Worktree } from "./git.js";

// How many transcript entries the cockpit's centre column keeps on screen.
// ponytail: a fixed window, not real scrollback — the terminal's own
// scrollback still holds everything Ink has painted. Give the pane its own
// scroll keys if reading back more than this becomes routine.
const TRANSCRIPT_WINDOW = 14;

// Width of the review pane's minimap, in characters.
const DENSITY_WIDTH = 24;

type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; id: string; verb?: string; path?: string; at: number; end?: number; status?: string };

// "edit" -> "Edit", "switch_mode" -> "Switch Mode".
function titleCase(kind: string): string {
  return kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Titles from the live adapter can embed an absolute path with no separator
// other than a space ("Write /long/abs/path/note.txt"), so the "leading
// words" of a title are whatever comes before the first path-looking token.
// A title with no such token (e.g. "Reading file") is returned whole.
function leadingWords(title: string): string {
  const words = title.split(/\s+/);
  const pathIdx = words.findIndex((w) => w.includes("/"));
  const lead = pathIdx === -1 ? words : words.slice(0, pathIdx);
  return lead.join(" ") || title;
}

// The verb for a tool line: the tool call's `kind` (a short enum — never a
// path) when present, else the leading words of its title. Undefined when
// this particular update carries neither, so an in-place merge doesn't blank
// out a verb a prior update already established.
function toolVerb(toolKind: string | undefined, toolTitle: string | undefined): string | undefined {
  if (toolKind) return titleCase(toolKind);
  if (toolTitle) return leadingWords(toolTitle);
  return undefined;
}

// The explain gate: sent as a normal prompt when review opens, before the
// accept key does anything. This is mechanism #1 of the review gate — the
// other two are the file view (read the result, not just the patch) and
// provenance trailers on the accepting commit.
const EXPLAIN_PROMPT = `Before I review this change, answer in plain prose, briefly:
1. What did you change, and why?
2. What could break because of it?
3. What did you NOT test or verify?
Do not summarize the diff line by line. If something is a placeholder or a
fallback that silently degrades, say so explicitly.`;

const SUBJECT_CAP = 72;

// Strips markdown syntax that would otherwise leak into a commit subject.
// The explain prompt asks for plain prose but does not forbid — and models
// routinely reply with — a bolded, numbered structure (see EXPLAIN_PROMPT
// above); a raw "*", "#" or backtick surviving into `git log --oneline` is a
// standing advertisement that a machine wrote the message. Removing the
// characters outright (rather than trying to balance **/`` pairs) is enough:
// there's nothing for stray delimiters to misparse once they're just gone.
function stripMarkdown(s: string): string {
  return s.replace(/[`*#]/g, "");
}

// Cuts `s` to at most `max` characters on a word boundary, never mid-word,
// appending `suffix` only once a cut actually happened.
// ponytail: a single token longer than the cap (no space to back up to)
// still gets cut mid-word — not a shape either caller below produces in
// practice, and not worth a hyphenation heuristic until it is.
function cutAtWordBoundary(s: string, max: number, suffix: string): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - suffix.length);
  const lastSpace = cut.lastIndexOf(" ");
  const wordSafe = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return wordSafe.trimEnd() + suffix;
}

// Caps `s` at SUBJECT_CAP characters on a word boundary, trimming to an
// ellipsis when it had to cut anything. Used only by splitSummary's
// summary-derived subject (see below) — the primary, prompt-derived subject
// never gets an ellipsis; see subjectFromPrompt.
function capSubject(s: string): string {
  return cutAtWordBoundary(s, SUBJECT_CAP, "...");
}

// The user's own prompt, collapsed to one line and capped at SUBJECT_CAP on
// a word boundary — no ellipsis, since a trimmed subject reads fine in
// `git log --oneline` and a trailing "..." there does not. This is the
// primary source for the accepted commit's subject (see commitMessage
// below): it's one line already, it's what a human would have written, and
// it describes intent rather than however the agent chose to phrase its
// explain-gate answer this particular turn.
function subjectFromPrompt(prompt: string): string {
  return cutAtWordBoundary(prompt.trim().replace(/\s+/g, " "), SUBJECT_CAP, "");
}

// splitSummary uses the agent's first sentence as the commit subject; the
// rest, if any, becomes the body.
//
// Live-verification finding: the explain prompt asks for plain prose but
// does not forbid a numbered list, and models routinely answer its three
// questions as one, in markdown. A leading "1. " reads as a false sentence
// end to a naive first-period scan (subject becomes the single character
// "1"), so a leading list/bullet marker is stripped before searching for the
// real terminator; body/subject are then complementary slices of the same
// cleaned text (subject = the head up to the terminator, body = the tail
// after it) so they can never duplicate each other, even when the subject
// itself gets truncated by capSubject.
export function splitSummary(raw: string): { subject: string; body: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { subject: "ctui: accept unexplained change", body: "" };

  const marker = /^(\d{1,2}[.)]|[-*])\s+/.exec(trimmed);
  const afterMarker = marker ? trimmed.slice(marker[0].length) : trimmed;
  const cleaned = stripMarkdown(afterMarker).replace(/[ \t]+/g, " ").trim();

  // First sentence ends at a "." or a newline — but a run of 2+ dots is an
  // ellipsis, not a terminator (a truncated "multi..." shouldn't read as a
  // one-word sentence), so those are skipped over rather than split on.
  let end = -1;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "\n") {
      end = i;
      break;
    }
    if (cleaned[i] === ".") {
      let j = i;
      while (cleaned[j] === ".") j++;
      if (j - i === 1) {
        end = i;
        break;
      }
      i = j - 1;
    }
  }
  const firstSentence = (end === -1 ? cleaned : cleaned.slice(0, end)).trim();
  const body = end === -1 ? "" : cleaned.slice(end + 1).trim();

  return { subject: capSubject(firstSentence), body };
}

// commitMessage picks the accepted commit's subject and body. The user's
// prompt (subjectFromPrompt) is the primary subject source, with the full,
// untouched agent summary as the body — the detail belongs there, not
// squeezed into one line. Falls back to the summary-derived subject/body
// (splitSummary) only when there's no prompt: the "A" unexplained-accept
// path, or an empty prompt.
export function commitMessage(prompt: string, summary: string): { subject: string; body: string } {
  const subject = prompt.trim() === "" ? "" : subjectFromPrompt(prompt);
  return subject === "" ? splitSummary(summary) : { subject, body: summary.trim() };
}

// sessionNameOf recovers the short session name ("s1") from a worktree
// branch ("ctui/s1"), for the Ctui-Session trailer.
function sessionNameOf(branch: string): string {
  return branch.startsWith("ctui/") ? branch.slice("ctui/".length) : branch;
}

// How many lines of context the file view shows above and below the current
// hunk. A fixed, small window — the point is to not blow up the terminal on
// a long file, not to reproduce it in full.
const FILE_VIEW_WINDOW = 10;

// FileWindow renders a slice of the worktree file around centerLine (the
// current hunk's first new-side line), marking every line changedLines
// reports as touched. This is mechanism #2 of the gate: the reader sees the
// function the edit sits in, not just the edited lines a diff shows.
function FileWindow({
  content,
  changed,
  centerLine,
  origins,
}: {
  content: string;
  changed: Set<number>;
  centerLine: number;
  // Which prompt produced each line. Absent while it is still loading, or
  // for a file opened outside review.
  origins?: Map<number, LineOrigin>;
}): React.JSX.Element {
  const lines = content.split("\n");
  // A file ending in a newline splits to a trailing "" that is the
  // terminator, not a line of the file. Rendering it invents a numbered
  // empty line past the end that the editor does not have and the gutter
  // then has to attribute to somebody.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const start = Math.max(1, centerLine - FILE_VIEW_WINDOW);
  const end = Math.min(lines.length, centerLine + FILE_VIEW_WINDOW);
  const rows: React.JSX.Element[] = [];
  // Provenance is announced when it changes, not repeated on every line: a
  // label against all twenty lines is a column of noise, while a rule at
  // each boundary is the shape of the answer — this run came from here,
  // that run came from there.
  let lastLabel: string | null = null;
  for (let n = start; n <= end; n++) {
    const origin = origins?.get(n);
    if (origin && origin.label !== lastLabel) {
      lastLabel = origin.label;
      const dateAndSha = origin.sha === "" ? "" : `${origin.date}  ${origin.sha.slice(0, 8)}  `;
      rows.push(
        <Text key={`o${n}`} dimColor={origin.sha !== ""} color={origin.sha === "" ? "cyan" : undefined}>
          {`      ── ${dateAndSha}${origin.label}`}
        </Text>,
      );
    }
    // With provenance loaded, "this line is new" is something we know
    // exactly — a line with no counterpart in the committed file. Without
    // it, fall back to the hunk's span, which marks the changed region but
    // includes the context lines around it.
    const isChanged = origin ? origin.sha === "" : changed.has(n);
    rows.push(
      <Text key={n} color={isChanged ? "green" : undefined}>
        {`${isChanged ? "+" : " "} ${String(n).padStart(5)}  ${lines[n - 1] ?? ""}`}
      </Text>,
    );
  }
  return <Box flexDirection="column">{rows}</Box>;
}

// ReviewPane is the second rendering mode for the review pane: the current
// hunk in its patch context, or (via tab) the whole file with changed lines
// marked. A hunkless section — a pure rename or a mode-only change — has
// nothing to show as a patch, so patch view says so explicitly instead of
// rendering nothing.
// blastLine renders one "blast radius" row: `name()  N references · agent
// read M`. Highlighted (color) when the agent changed the symbol without
// reading any of its references — the 3am page, shown before you accept it.
// Said as "references", not "callers": this comes from `git grep`, which
// finds textual matches, not verified call sites.
function blastLine(s: BlastSymbol): React.JSX.Element {
  const unread = s.callers.length > 0 && s.readCount === 0;
  const refWord = s.callers.length === 1 ? "reference" : "references";
  return (
    <Text key={s.name} color={unread ? "red" : undefined}>
      {`  ${(s.name + "()").padEnd(20)}${s.callers.length} ${refWord} · agent read ${s.readCount}`}
    </Text>
  );
}

// selectionLabel is the review footer's aggregate: "3 hunks in 2 files
// selected". The pane below only shows the hunk under the cursor, so this
// is the one place the user can see the whole of what an irreversible
// accept is about to act on without walking the list themselves.
function selectionLabel(review: Review): string {
  const { units, files } = review.selectionSummary();
  if (units === 0) return "nothing selected yet";
  return `${units} hunk${units === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"} selected`;
}

function ReviewPane({
  branch,
  review,
  paneMode,
  summary,
  summaryPending,
  fileContent,
  origins,
  fileError,
  blast,
  blastError,
}: {
  branch: string;
  review: Review;
  paneMode: "patch" | "file";
  summary: string;
  summaryPending: boolean;
  fileContent: string | null;
  origins: Map<number, LineOrigin> | null;
  fileError: string | null;
  blast: BlastSymbol[];
  blastError: string | null;
}): React.JSX.Element {
  const file = review.files[review.fi];
  const hunk: Hunk | undefined = file?.hunks[review.hi];
  const selected = file ? review.selected(review.fi, review.hi) : false;
  const position = file ? (file.hunks.length > 0 ? `hunk ${review.hi + 1}/${file.hunks.length}` : "(no hunks)") : "";
  // What changed by function, and where in the file it landed. The bar
  // needs the file's own length, which is only known once its snapshot has
  // loaded — until then the outline renders without one rather than
  // guessing a length and drawing a wrong picture.
  const entries = file ? outline(file) : [];
  const bar =
    file && fileContent !== null
      ? densityBar(changedLines(file), fileContent.split("\n").length, DENSITY_WIDTH)
      : "";

  return (
    <Box flexDirection="column" borderStyle="round">
      <Text>
        {branch} · review{paneMode === "file" ? " · file view" : ""}
      </Text>
      <Box flexDirection="column" marginBottom={1}>
        {summary !== "" && <Text>{summary}</Text>}
        {summaryPending && (
          <Text dimColor>{summary === "" ? "(waiting for the agent's explanation...)" : "(receiving...)"}</Text>
        )}
        {!summaryPending && summary === "" && <Text dimColor>(no summary — press A to accept without one)</Text>}
      </Box>
      {(blast.length > 0 || blastError) && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>blast radius</Text>
          {blastError ? (
            // A broken blast radius must never render as an empty list —
            // that's indistinguishable from "no other references", and a
            // safety display must not fail toward reassurance.
            <Text color="red">{`  could not check: ${blastError}`}</Text>
          ) : (
            blast.map(blastLine)
          )}
        </Box>
      )}
      <Outline entries={entries} bar={bar} />
      <Text dimColor>{"─".repeat(50)}</Text>
      {!file ? (
        <Text dimColor>nothing to review</Text>
      ) : (
        <Box flexDirection="column">
          <Text>
            {file.path}   {position}
          </Text>
          {paneMode === "patch" ? (
            file.hunks.length === 0 ? (
              <Text>{`[${selected ? "x" : " "}] (binary or metadata-only change)`}</Text>
            ) : (
              <Box flexDirection="column">
                <Text>{`[${selected ? "x" : " "}] ${hunk!.header.replace(/\n$/, "")}`}</Text>
                {(hunk!.body.endsWith("\n") ? hunk!.body.slice(0, -1) : hunk!.body).split("\n").map((line, i) => (
                  <Text key={i} color={line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : undefined}>
                    {"    " + line}
                  </Text>
                ))}
              </Box>
            )
          ) : fileError ? (
            <Text dimColor>{fileError}</Text>
          ) : fileContent === null ? (
            <Text dimColor>(loading...)</Text>
          ) : (
            <FileWindow
              content={fileContent}
              changed={changedLines(file)}
              centerLine={hunk?.newStart ?? 1}
              origins={origins ?? undefined}
            />
          )}
        </Box>
      )}
    </Box>
  );
}

// The bridge is how index.ts (which owns the real AgentSession, created
// before this component ever mounts) hands live events to this component.
// It emits:
//   "update"     (u: AgentUpdate)
//   "permission" (req: PermissionRequest, respond: (optionId: string | null) => void)
export interface AppProps {
  branch: string;
  session: AgentSession;
  bridge: EventEmitter;
  // The isolated worktree this session is working in. Review reads its diff
  // and its files; accept applies patches and commits into worktree.repo,
  // the user's real repository — never into the worktree itself.
  worktree: Worktree;
  // The mode ctui resolved at startup (after attempting to pin "default").
  initialMode: string;
  // True if we could not confirm the session is in "default" mode — the
  // approval gate may be degraded, so this must stay visible, not silent.
  modeDegraded: boolean;
  // Read-only: understanding, not writing. No review pane, "r" is refused,
  // and the worktree is destroyed on exit without applying anything.
  // ponytail: "read-only" here is discard-on-close, not an enforced
  // read-only filesystem. Real enforcement means containers or mount
  // tricks. Revisit if an explain session ever needs to be trusted
  // against a dirty tree.
  explain: boolean;
  onExit: (result: { agentDied: boolean }) => void;
}

export function App({
  branch,
  session,
  bridge,
  worktree,
  initialMode,
  modeDegraded,
  explain,
  onExit,
}: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [mode, setMode] = useState(initialMode);
  const [running, setRunning] = useState(false);
  // The turn clock. `now` only advances while a turn is in flight, so when
  // one ends every duration on screen freezes at its last reading instead
  // of a stopped agent appearing to still be working.
  const [turnStart, setTurnStart] = useState(0);
  const [now, setNow] = useState(0);
  // What the agent says it has spent. Null until an adapter sends a usage
  // update — and many never will, so null must render as nothing.
  const [usage, setUsage] = useState<Usage | null>(null);
  const [input, setInput] = useState("");
  const [permission, setPermission] = useState<{ req: PermissionRequest; respond: (id: string | null) => void } | null>(
    null,
  );
  const [confirmingExit, setConfirmingExit] = useState(false);
  // Why the confirm-before-exit prompt is up, so its message can be honest
  // about what's actually at risk: a turn (or accept) still running, or —
  // I9 — unaccepted work already sitting in the worktree while idle.
  const [confirmReason, setConfirmReason] = useState<"busy" | "dirty">("busy");
  const [agentDied, setAgentDied] = useState(false);
  const [lastPrompt, setLastPrompt] = useState("");

  // Cockpit state: what the session has changed so far (the repo map and
  // the live diff pane both read this), which file the agent touched most
  // recently, and the agent's own plan. All of it is display-only — accept
  // still works from the diff review() captures for itself, so a stale or
  // failed refresh here can never change what gets applied.
  const [diffFiles, setDiffFiles] = useState<FileDiff[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanEntry[]>([]);
  // Drops a refresh that arrives while one is already running rather than
  // queueing it: refreshes are triggered per write, and the guaranteed
  // refresh at end of turn (see submit) makes the final state correct
  // regardless of how many mid-turn ones were skipped.
  const refreshingRef = useRef(false);
  // Whether the project's own checker passed on what the agent wrote.
  // `null` after a run means "no check is configured", which the pane must
  // render differently from "checked and clean" — see ChecksPane.
  const [checks, setChecks] = useState<CheckResult | null | undefined>(undefined);
  const [checksRunning, setChecksRunning] = useState(false);

  // Which pane owns the keyboard. The repo map is the only pane with
  // anything to activate, so this is a toggle rather than a cycle — the
  // transcript has no scrollback to move through and the plan has nothing
  // to open. ponytail: make it a cycle when either of those gains one.
  const [mapFocus, setMapFocus] = useState(false);
  // The cursor is remembered by path, not index: the agent writes files
  // mid-turn, and a new one sorting above the selection would otherwise
  // slide the cursor onto a different file under the reader's hands.
  const [mapPath, setMapPath] = useState<string | null>(null);
  // Where the file view was entered from, so escape backs out to the place
  // the reader came from instead of dropping them in an empty picker.
  const [openFrom, setOpenFrom] = useState<"picker" | "map">("picker");

  // ctrl-P: open any file in the tree, not just the ones the agent touched.
  // `openPath` non-null means a file is being read; otherwise the picker
  // itself is up. Both live under viewMode "open".
  const [allFiles, setAllFiles] = useState<string[]>([]);
  const [openQuery, setOpenQuery] = useState("");
  const [openIndex, setOpenIndex] = useState(0);
  const [openPath, setOpenPath] = useState<string | null>(null);
  // The new-side lines this session changed in the open file, so a file
  // reached from the repo map arrives with its changes already marked.
  const [openChanged, setOpenChanged] = useState<Set<number>>(new Set());
  const [openContent, setOpenContent] = useState<string | null>(null);
  const [openLine, setOpenLine] = useState(1);
  // Which prompt produced each line of the file currently in file view.
  // Loaded per file, not per line: see provenance.lineOrigins.
  const [origins, setOrigins] = useState<Map<number, LineOrigin> | null>(null);

  // Review state. `review` is a mutable class instance (toggle/next/prev
  // mutate it in place, per diff.ts); reviewVersion is bumped after every
  // mutation purely to force a re-render, since React does not see a
  // mutation to an object it already holds a reference to.
  const [viewMode, setViewMode] = useState<"chat" | "review" | "open">("chat");
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [reviewVersion, setReviewVersion] = useState(0);
  const [paneMode, setPaneMode] = useState<"patch" | "file">("patch");
  const [summary, setSummary] = useState("");
  const [summaryPending, setSummaryPending] = useState(false);
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [blast, setBlast] = useState<BlastSymbol[]>([]);
  // I11: a broken blast radius must render as a visible error, not blend in
  // with "nothing at risk" the way an empty `blast` array does.
  const [blastError, setBlastError] = useState<string | null>(null);
  // Every path the agent has opened with a "read" tool call, across the
  // whole session (not just the turn that produced the current diff) — a
  // plain ref because it accumulates from the bridge listener without
  // needing a re-render of its own.
  const readPathsRef = useRef<Set<string>>(new Set());
  // True only while the explain-gate prompt itself is in flight, so
  // onUpdate can route its streamed answer into the summary instead of the
  // transcript. A plain ref: it must be current inside the bridge listener
  // closure without forcing that effect to re-subscribe on every chunk.
  const explainInFlightRef = useRef(false);
  const reviewOpeningRef = useRef(false);
  const acceptingRef = useRef(false);
  // I8: every non-binary file's content, captured once at the moment the
  // diff itself was captured (openReview), not read live whenever the file
  // pane happens to render. The explain turn is a normal prompt with tool
  // access, so the agent can keep editing the worktree while answering it —
  // a live read would then show content review.patch() (built from that
  // same original diff) will never actually apply. A plain ref: it's write-
  // once per review and read only inside an effect keyed off reviewVersion.
  const fileSnapshotRef = useRef<Map<string, string>>(new Map());

  // One second is the right resolution for "is this stuck": fast enough to
  // read as motion, slow enough that the terminal isn't repainting for the
  // sake of it. The interval exists only while a turn does.
  useEffect(() => {
    if (!running) return;
    const start = Date.now();
    setTurnStart(start);
    setNow(start);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  function append(entry: TranscriptEntry): void {
    setTranscript((prev) => {
      const last = prev[prev.length - 1];
      // Merge consecutive chunks of the same streamed kind into one line;
      // tool lines and user prompts each always start a new line.
      if (last && (entry.kind === "agent" || entry.kind === "thought") && last.kind === entry.kind) {
        const merged: TranscriptEntry = { kind: entry.kind, text: last.text + entry.text };
        return [...prev.slice(0, -1), merged];
      }
      return [...prev, entry];
    });
  }

  // tool_call and a later tool_call_update sharing a toolCallId are one
  // operation; update the existing line in place instead of adding another.
  // ACP updates are patches — verb/path stay undefined here when this
  // particular update didn't carry them, so a prior known value survives.
  function upsertTool(id: string, patch: { verb?: string; path?: string; status?: string }): void {
    const t = Date.now();
    // A terminal status stops this line's clock. Anything else leaves it
    // running, so a tool the agent never reports finishing keeps ticking
    // rather than silently reading as instant.
    const stop = patch.status === "completed" || patch.status === "failed" ? { end: t } : {};
    setTranscript((prev) => {
      const idx = prev.findIndex((e) => e.kind === "tool" && e.id === id);
      if (idx === -1) {
        return [...prev, { kind: "tool", id, at: t, ...patch, ...stop }];
      }
      const merged = { ...prev[idx], ...patch, ...stop };
      return [...prev.slice(0, idx), merged, ...prev.slice(idx + 1)];
    });
  }

  // Re-reads the worktree diff so the repo map and the live diff pane show
  // what the agent has written so far. Closes over nothing that changes
  // across renders (worktree is a fixed prop; setters and refs are stable),
  // so the copy the bridge listener captured on first render stays correct.
  // A failure only leaves the display briefly stale — never fatal, and
  // never able to affect what accept applies.
  async function refreshWorkspace(): Promise<void> {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      setDiffFiles(splitDiff(await worktree.diff()));
    } catch {
      // display-only; see above
    } finally {
      refreshingRef.current = false;
    }
  }

  useEffect(() => {
    function onUpdate(u: AgentUpdate): void {
      // The explain-gate prompt (see EXPLAIN_PROMPT) is a normal turn, so
      // its answer streams through here like any other. It is deliberately
      // kept OUT of the transcript: it is a machine-directed prompt, not
      // conversation, and the answer already renders in the review pane —
      // showing it twice would just be noise. current_mode_update is real
      // session state, not conversation content, so it still goes through.
      if (explainInFlightRef.current && u.kind !== "current_mode_update") {
        if (u.kind === "agent_message_chunk") {
          const chunk = u.text ?? "";
          setSummary((prev) => prev + chunk);
        }
        return;
      }
      switch (u.kind) {
        case "agent_message_chunk":
          append({ kind: "agent", text: u.text ?? "" });
          break;
        case "agent_thought_chunk":
          append({ kind: "thought", text: u.text ?? "" });
          break;
        case "tool_call":
        case "tool_call_update": {
          if (u.toolCallId) {
            const verb = toolVerb(u.toolKind, u.toolTitle);
            const patch: { verb?: string; path?: string; status?: string } = {};
            if (verb !== undefined) patch.verb = verb;
            if (u.toolPath !== undefined) patch.path = u.toolPath;
            if (u.toolStatus !== undefined) patch.status = u.toolStatus;
            upsertTool(u.toolCallId, patch);
          }
          // Blast radius asks "did the agent read this file", not "did it
          // touch it" — only a "read" tool kind counts, so an edit to a
          // caller (which also carries a location) doesn't count as reading it.
          if (u.toolKind === "read" && u.toolPath !== undefined) {
            readPathsRef.current.add(u.toolPath);
          }
          // A tool that can change the tree moves the live diff pane to
          // that file and re-reads the diff. Listing the writing kinds
          // (rather than excluding "read") keeps a new or unknown ACP kind
          // from silently pointing the pane at a file nothing wrote.
          if (u.toolKind === "edit" || u.toolKind === "delete" || u.toolKind === "move") {
            if (u.toolPath !== undefined) setActivePath(u.toolPath);
            void refreshWorkspace();
          }
          break;
        }
        case "plan":
          setPlan(planFrom(u.raw));
          break;
        case "usage_update":
          if (u.usage) setUsage(u.usage);
          break;
        case "current_mode_update":
          if (u.modeId != null) setMode(u.modeId);
          break;
        default:
          break; // unknown/uninteresting kinds are ignored, never fatal
      }
    }
    function onPermission(req: PermissionRequest, respond: (id: string | null) => void): void {
      setPermission({ req, respond });
    }
    bridge.on("update", onUpdate);
    bridge.on("permission", onPermission);
    return () => {
      bridge.off("update", onUpdate);
      bridge.off("permission", onPermission);
    };
  }, [bridge]);

  // The provenance gutter: which prompt produced each line of the file the
  // reviewer is reading. Runs off the same snapshot the file view renders,
  // so the labels line up with the lines actually on screen. Keyed on the
  // content itself rather than on the path, because the snapshot is what
  // the line numbers belong to.
  useEffect(() => {
    if (paneMode !== "file" || fileContent === null) {
      setOrigins(null);
      return;
    }
    const path = review?.files[review.fi]?.path;
    if (path === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const map = await lineOrigins(worktree.repo, path, fileContent.split("\n").length, review?.files[review.fi]);
        if (!cancelled) setOrigins(map);
      } catch {
        // No gutter is fine; a crashed review pane is not.
        if (!cancelled) setOrigins(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paneMode, fileContent, reviewVersion, review, worktree]);

  // Shows the current file's content whenever file view is active and the
  // cursor (or the review itself) moves — from the snapshot captured at
  // openReview() (see fileSnapshotRef), not a live read. A live read here
  // raced review.patch(), which replays the diff captured back then: the
  // explain turn is a normal prompt with tool access, so the agent can keep
  // editing while the reviewer looks, and a live read would show content
  // that was never what's about to be applied (I8).
  useEffect(() => {
    if (!review || paneMode !== "file") return;
    const file = review.files[review.fi];
    if (!file) return;
    if (file.binary) {
      setFileContent(null);
      setFileError("(binary or metadata-only change)");
      return;
    }
    const content = fileSnapshotRef.current.get(file.path);
    if (content === undefined) {
      setFileContent(null);
      setFileError("(could not read this file when the review opened)");
      return;
    }
    setFileContent(content);
    setFileError(null);
  }, [review, reviewVersion, paneMode]);

  // In an explain session "r" is refused rather than opening review, but the
  // same keystroke still reaches TextInput (it's still focused, same quirk
  // closeReview() below works around), leaving a stray "r" sitting in the
  // input. There is no review-close cycle here to piggyback the cleanup on,
  // so clear it in an effect: that runs strictly after the keystroke's own
  // render commits, so it can't race TextInput's own append the way clearing
  // it synchronously inside the key handler would.
  useEffect(() => {
    if (explain && notice === "explain session — nothing to accept") {
      setInput("");
    }
  }, [explain, notice]);

  // mutateReview applies a mutation to the review's own class methods
  // (toggle/next/prev) and bumps reviewVersion to force the re-render React
  // would otherwise skip, since the object reference never changes.
  function mutateReview(fn: (r: Review) => void): void {
    if (!review) return;
    fn(review);
    setReviewVersion((v) => v + 1);
  }

  // sendExplainPrompt fires the explain gate as a normal turn (see
  // EXPLAIN_PROMPT). Its streamed answer is collected by onUpdate above,
  // keyed off explainInFlightRef rather than off any transcript state.
  async function sendExplainPrompt(): Promise<void> {
    explainInFlightRef.current = true;
    setRunning(true);
    try {
      await session.prompt(EXPLAIN_PROMPT);
    } catch (err) {
      // Same failure mode as a normal turn dying mid-flight: loud, not
      // silent. The review itself still opens — an agent that died can no
      // longer explain itself, but whatever it already changed is real and
      // still reviewable/acceptable via A.
      setAgentDied(true);
      const message = err instanceof Error ? err.message : String(err);
      append({ kind: "agent", text: `[agent process exited: ${message}]` });
    } finally {
      explainInFlightRef.current = false;
      setRunning(false);
      setSummaryPending(false);
    }
  }

  // openReview reads the worktree's current diff and, if there is anything
  // to review, opens the review pane and fires the explain gate. Guarded by
  // reviewOpeningRef so a mashed "r" cannot fire two concurrent diffs/turns.
  async function openReview(): Promise<void> {
    if (reviewOpeningRef.current) return;
    reviewOpeningRef.current = true;
    try {
      let raw: string;
      try {
        raw = await worktree.diff();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setNotice(`review: ${message}`);
        return;
      }
      if (raw.trim() === "") {
        setNotice("nothing to review");
        return;
      }
      const rev = new Review(raw);

      // I8: snapshot every non-binary file's content now, at the moment the
      // diff itself was captured — before the explain turn below gives the
      // agent another chance to keep editing the worktree.
      const snapshot = new Map<string, string>();
      await Promise.all(
        rev.files
          .filter((f) => !f.binary)
          .map(async (f) => {
            try {
              snapshot.set(f.path, await readFile(join(worktree.path, f.path), "utf8"));
            } catch {
              // Left unset; the file-view effect reports "could not read"
              // for it, the same as a live read failing used to.
            }
          }),
      );
      fileSnapshotRef.current = snapshot;

      setReview(rev);
      setReviewVersion(0);
      setPaneMode("patch");
      setSummary("");
      setSummaryPending(true);
      setReviewMessage(null);
      setFileContent(null);
      setFileError(null);
      setBlast([]);
      setBlastError(null);
      setViewMode("review");
      void sendExplainPrompt();
      blastRadius(worktree.path, rev.files, readPathsRef.current)
        .then((result) => {
          setBlast(result);
          setBlastError(null);
        })
        .catch((err) => {
          // I11: a broken blast radius must show up as an error, not
          // silently render as an empty (= "nothing at risk") list.
          setBlast([]);
          setBlastError(err instanceof Error ? err.message : String(err));
        });
    } finally {
      reviewOpeningRef.current = false;
      // I7: the early returns above (diff failed, or "nothing to review")
      // skip past closeReview()'s own setInput("") below, leaving whatever
      // stray "r" TextInput's own onChange queued for this same keystroke
      // (see closeReview()'s comment) sitting in the input box — the next
      // "r" then just types another character instead of retrying review.
      // Cleared here, unconditionally, once for every exit path (including
      // success) instead of patched into each return; every path reaches
      // this only after the `await worktree.diff()` above, so — like
      // closeReview()'s effect-based cleanup for the explain-session case —
      // this can't race TextInput's own synchronous append the keystroke
      // handler itself would.
      setInput("");
    }
  }

  function closeReview(): void {
    setViewMode("chat");
    setReview(null);
    setReviewMessage(null);
    setFileContent(null);
    setFileError(null);
    setBlast([]);
    setBlastError(null);
    // The "r" keystroke that opened review is delivered to TextInput too
    // (it stays focused for that same event), which inserts a stray "r"
    // into the input; TextInput is unmounted for the whole review, so this
    // is the first safe point to wipe it back out.
    setInput("");
  }

  // accept is mechanism #1's payoff: apply the selected hunks to the real
  // repo and commit them with provenance. unexplained is true only for the
  // A key — the escape hatch that keeps the gate from being a wall.
  async function accept(unexplained: boolean): Promise<void> {
    if (!review || acceptingRef.current) return;
    if (!review.anySelected()) {
      setReviewMessage("select at least one hunk first");
      return;
    }
    if (!unexplained && summaryPending) {
      setReviewMessage("waiting for the agent's summary — press A to accept without one");
      return;
    }
    if (!unexplained && summary.trim() === "") {
      setReviewMessage("no summary; press A to accept without one");
      return;
    }

    acceptingRef.current = true;
    try {
      const patch = review.patch();
      const paths = patchPaths(review.files, (fi, hi) => review.selected(fi, hi));

      // C1/C2: refuse before ever calling applyPatch, rather than try to
      // clean up after it. `git apply --3way --index` is not atomic: on a
      // path the user already has pending work in, it can write conflict
      // markers into their file and replace their staged content with a
      // rejected merge before exiting non-zero — and even when it succeeds
      // cleanly, `git commit -- <paths>` commits the whole current content
      // of those paths, sweeping the user's own unrelated staged edit in
      // under the agent's provenance trailers. Checking first is a smaller,
      // safer change than making either failure mode survivable afterward.
      try {
        const dirty = await dirtyPaths(worktree.repo, paths);
        if (dirty.length > 0) {
          setReviewMessage(`your working tree has changes to ${dirty.join(", ")} — commit or stash them first`);
          return;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setReviewMessage(`could not check your working tree before applying: ${message}`);
        return;
      }

      try {
        await applyPatch(worktree.repo, patch);
      } catch (err) {
        // applyPatch itself now reports exactly what landed rather than
        // ever claiming an unqualified "nothing changed" — see its comment.
        const message = err instanceof Error ? err.message : String(err);
        setReviewMessage(`apply failed: ${message}`);
        return;
      }

      // A ("accept unexplained") means "don't wait for an explanation", not
      // "discard whatever provenance is already known" — use the summary
      // when there is one (e.g. it started streaming before A was pressed)
      // and always record the prompt that led here, falling back to "<none>"
      // only when there truly isn't one.
      const { subject, body } = commitMessage(lastPrompt, summary);
      const promptTrailer = lastPrompt !== "" ? lastPrompt : "<none>";
      try {
        await commitAccepted(worktree.repo, paths, subject, body, sessionNameOf(worktree.branch), promptTrailer);
      } catch (err) {
        // The patch landed but the commit did not: the changes are real and
        // now sit uncommitted in the working tree. Silent provenance loss
        // is exactly what this tool exists to prevent, so this must be loud.
        const message = err instanceof Error ? err.message : String(err);
        setReviewMessage(`applied but NOT committed (${message}) — changes are uncommitted in your working tree`);
        return;
      }

      // Only now — apply and commit both succeeded — move base forward so
      // these hunks stop showing up the next time review opens. A failure
      // here doesn't undo the accept; it only means the next diff may
      // resurface what was just accepted, so it's surfaced, not silent.
      try {
        await worktree.advanceAfterAccept(patch);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        append({ kind: "agent", text: `[warning: accepted, but could not advance the review base: ${message}]` });
      }

      append({ kind: "agent", text: `[accepted: ${subject}]` });
      closeReview();
    } finally {
      acceptingRef.current = false;
    }
  }

  // The repo map's rows, computed once per render: the key handler steers
  // the same list the pane draws, and two derivations of it would drift.
  const mapRows = mapEntries(diffFiles, readPathsRef.current, checks?.problems ?? []);
  const mapIndex = Math.max(0, mapRows.findIndex((e) => e.path === mapPath));

  function moveMap(delta: number): void {
    const entry = mapRows[Math.min(mapRows.length - 1, Math.max(0, mapIndex + delta))];
    if (entry) setMapPath(entry.path);
  }

  // Enter on a row: the file itself, with this session's changes marked and
  // the view already sitting on the first of them — the reason to open the
  // file is what changed in it. A row you can watch turn red but cannot
  // open is a picture, not an instrument.
  async function openFromMap(path: string): Promise<void> {
    const file = diffFiles.find((f) => f.path === path);
    const changed = file ? changedLines(file) : new Set<number>();
    setOpenFrom("map");
    setOpenChanged(changed);
    setMapFocus(false);
    setViewMode("open");
    await openFile(path);
    if (changed.size > 0) setOpenLine(Math.min(...changed));
  }

  useInput((char, key) => {
    if (key.ctrl && char === "c") {
      if (confirmingExit) {
        onExit({ agentDied });
        exit();
        return;
      }
      // I12: an in-flight accept() must be treated as busy the same way a
      // running turn is — it isn't gated by `running`, so without this,
      // Ctrl+C here takes the immediate-exit branch and index.ts's
      // worktree.destroy() can run concurrently with applyPatch/
      // commitAccepted/advanceAfterAccept, with the UI already unmounted so
      // neither a success nor a failure message can ever display.
      if (running || acceptingRef.current) {
        setConfirmReason("busy");
        setConfirmingExit(true);
        return;
      }
      // I9: idle, and no accept in flight — still don't exit silently if
      // there's unaccepted work sitting in the worktree. Quitting right
      // after `q`-ing out of review must not discard it with no prompt.
      void (async () => {
        let dirty = false;
        try {
          dirty = (await worktree.diff()).trim() !== "";
        } catch {
          // Can't tell — err toward confirming, not toward silently
          // discarding whatever might be there.
          dirty = true;
        }
        if (dirty) {
          setConfirmReason("dirty");
          setConfirmingExit(true);
        } else {
          onExit({ agentDied });
          exit();
        }
      })();
      return;
    }
    if (confirmingExit) setConfirmingExit(false);

    if (permission) {
      // Match on option.kind, never id or array position: live adapters use
      // ids like allow/reject/allow_always, so position-matching would
      // silently pick "Always Allow" on a plain "y".
      if (char === "y" || char === "Y") {
        const chosen = permission.req.options.find((o) => o.kind === "allow_once");
        permission.respond(chosen?.optionId ?? null);
        setPermission(null);
      } else if (char === "n" || char === "N") {
        const chosen = permission.req.options.find((o) => o.kind === "reject_once");
        permission.respond(chosen?.optionId ?? null);
        setPermission(null);
      }
      return;
    }

    if (viewMode === "open") {
      if (key.escape) {
        // Escape backs out one level at a time — out of the file to the
        // list, out of the list to the session — rather than dropping the
        // reader all the way back on a mistyped query.
        if (openPath !== null && openFrom === "picker") closeOpenFile();
        else closePicker();
        return;
      }
      if (openPath !== null) {
        // Reading a file: j/k and the arrows scroll it.
        if (char === "j" || key.downArrow) setOpenLine((n) => n + 1);
        else if (char === "k" || key.upArrow) setOpenLine((n) => Math.max(1, n - 1));
        else if (char === "d" || key.pageDown) setOpenLine((n) => n + FILE_VIEW_WINDOW);
        else if (char === "u" || key.pageUp) setOpenLine((n) => Math.max(1, n - FILE_VIEW_WINDOW));
        return;
      }
      const matches = filterFiles(allFiles, openQuery);
      if (key.return) {
        const chosen = matches[openIndex];
        if (chosen !== undefined) void openFile(chosen);
        return;
      }
      // The arrows move the selection; the query box owns every other
      // printable key, so j/k cannot be used here — they are text.
      if (key.downArrow) setOpenIndex((i) => Math.min(matches.length - 1, i + 1));
      else if (key.upArrow) setOpenIndex((i) => Math.max(0, i - 1));
      return;
    }

    if (viewMode === "chat" && mapFocus) {
      if (key.tab) {
        setMapFocus(false);
        return;
      }
      if (char === "j" || key.downArrow) {
        moveMap(1);
        return;
      }
      if (char === "k" || key.upArrow) {
        moveMap(-1);
        return;
      }
      if (key.return) {
        const entry = mapRows[mapIndex];
        if (entry) void openFromMap(entry.path);
        return;
      }
      // Escape stays the interrupt everywhere. It must not quietly become
      // "unfocus" just because the cursor happens to be in a pane — the key
      // that stops a runaway agent cannot depend on where focus is.
      if (key.escape && running) session.cancel().catch(() => {});
      return;
    }

    if (viewMode === "chat" && key.tab) {
      // An empty map has nothing to steer, so focus stays in the prompt
      // rather than moving somewhere with no cursor and no keys.
      if (mapRows.length > 0) {
        setMapFocus(true);
        if (mapPath === null) setMapPath(mapRows[0]!.path);
      }
      return;
    }

    if (viewMode === "chat" && key.ctrl && char === "p") {
      void openPicker();
      return;
    }

    if (viewMode === "review") {
      if (char === "q") {
        closeReview();
        return;
      }
      if (char === " ") {
        mutateReview((r) => r.toggle());
        return;
      }
      if (char === "j") {
        mutateReview((r) => r.next());
        return;
      }
      if (char === "k") {
        mutateReview((r) => r.prev());
        return;
      }
      if (key.tab) {
        setPaneMode((m) => (m === "patch" ? "file" : "patch"));
        return;
      }
      if (char === "a") {
        void accept(false);
        return;
      }
      if (char === "A") {
        void accept(true);
        return;
      }
      if (key.escape && running) {
        session.cancel().catch(() => {});
      }
      return;
    }

    if (notice) setNotice(null);

    // Single-key review trigger, active only when the input line is empty:
    // "r" must stay a normal character while the user is composing a
    // message (e.g. "read the file"), and only opens review when there is
    // nothing being typed for it to interrupt.
    if (char === "r" && input === "" && !running) {
      if (explain) {
        setNotice("explain session — nothing to accept");
      } else {
        void openReview();
      }
      return;
    }

    if (key.escape && running) {
      session.cancel().catch(() => {});
    }
  });

  async function submit(value: string): Promise<void> {
    const text = value.trim();
    if (!text || running || permission) return;
    setInput("");
    setLastPrompt(text);
    append({ kind: "user", text });
    setRunning(true);
    try {
      await session.prompt(text);
    } catch (err) {
      setAgentDied(true);
      const message = err instanceof Error ? err.message : String(err);
      append({ kind: "agent", text: `[agent process exited: ${message}]` });
    } finally {
      setRunning(false);
      // The refresh that makes the map correct: mid-turn refreshes are
      // dropped whenever one is already in flight, so this is the one that
      // is guaranteed to run against the finished state. Also covers an
      // agent that writes through a tool kind we don't recognise.
      void refreshWorkspace();
      // Checks run once the agent has stopped, never per write: a build
      // halfway through a turn reports failures the agent was already on
      // its way to fixing, which trains the reader to ignore the pane.
      void runProjectChecks();
    }
  }

  // ctrl-P. The list is re-read every time rather than cached: the agent
  // creates files mid-session, and a picker that cannot open the file the
  // agent just wrote is the one case that matters most.
  async function openPicker(): Promise<void> {
    setOpenFrom("picker");
    setOpenChanged(new Set());
    setOpenQuery("");
    setOpenIndex(0);
    setOpenPath(null);
    setOpenContent(null);
    setViewMode("open");
    try {
      setAllFiles(await listFiles(worktree.path));
    } catch {
      setAllFiles([]);
    }
  }

  function closePicker(): void {
    setOpenPath(null);
    setOpenContent(null);
    setViewMode("chat");
  }

  async function openFile(path: string): Promise<void> {
    setOpenPath(path);
    setOpenLine(1);
    setOrigins(null);
    try {
      const content = await readFile(join(worktree.path, path), "utf8");
      setOpenContent(content);
      // The gutter, on any file opened here — not only inside review. It is
      // also what makes the change marks exact: without provenance the view
      // can only mark the hunk's whole span, so a one-line fix inside a
      // six-line hunk reads as six lines changed.
      try {
        const file = diffFiles.find((f) => f.path === path);
        setOrigins(await lineOrigins(worktree.repo, path, content.split("\n").length, file));
      } catch {
        // No provenance is a coarser view, not a broken one.
      }
    } catch (err) {
      // A directory, a broken symlink, a binary the reader would not want
      // painted into their terminal anyway — say which and stay open.
      setOpenContent(`(cannot read ${path}: ${err instanceof Error ? err.message : String(err)})`);
    }
  }

  function closeOpenFile(): void {
    setOpenPath(null);
    setOpenContent(null);
  }

  // Runs the project's own checker against the worktree. Like the diff
  // refresh this is display-only and must never throw into a render: a
  // checker that cannot run is reported by runChecks itself, and anything
  // beyond that leaves the previous result standing rather than blanking
  // the pane.
  async function runProjectChecks(): Promise<void> {
    setChecksRunning(true);
    try {
      setChecks(await runChecks(worktree.path, worktree.repo));
    } catch {
      // display-only; see above
    } finally {
      setChecksRunning(false);
    }
  }

  // How long the agent has been on this turn, in the header, because the
  // one question a watcher actually has is whether it is still moving.
  const statusWord = agentDied
    ? "agent exited"
    : running
      ? `running ${dur(now - turnStart)}`
      : "idle";
  const modeWord = modeDegraded ? `${mode} mode (gate degraded)` : `${mode} mode`;
  // "worktree discarded on exit", not "nothing is kept"/unqualified: the
  // guarantee is only that the worktree goes away — the agent can still run
  // `git push`, or write outside the worktree, during either kind of
  // session. A wrong claim about what's contained is the same defect class
  // as everything else fixed this pass.
  const statusLine = explain
    ? `${branch} · explain · worktree discarded on exit`
    : `${branch} · ${modeWord} · ${statusWord} · worktree discarded on exit`;
  const inputEnabled = !running && !permission && !agentDied && viewMode === "chat" && !mapFocus;
  // The file the live diff pane shows: the one the agent touched most
  // recently, falling back to whatever changed last so the pane still says
  // something useful when a write arrived without a path.
  const activeFile = diffFiles.find((f) => f.path === activePath) ?? diffFiles[diffFiles.length - 1];

  const openMatches = filterFiles(allFiles, openQuery);

  if (viewMode === "open") {
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round">
          <Text>{statusLine}</Text>
          {openPath !== null ? (
            <Box flexDirection="column">
              <Text dimColor>{openPath}</Text>
              {openContent === null ? (
                <Text dimColor>(loading...)</Text>
              ) : (
                <FileWindow
                  content={openContent}
                  changed={openChanged}
                  centerLine={openLine}
                  origins={origins ?? undefined}
                />
              )}
            </Box>
          ) : (
            <FilePicker query={openQuery} matches={openMatches} index={openIndex} total={allFiles.length} />
          )}
        </Box>
        {openPath !== null ? (
          <Text dimColor>
            {`  [j/k] scroll  [u/d] page  [esc] ${openFrom === "map" ? "back to the session" : "back to the list"}`}
          </Text>
        ) : (
          <Box>
            <Text>{"open ▸ "}</Text>
            <TextInput
              value={openQuery}
              onChange={(v) => {
                setOpenQuery(v);
                // Any edit invalidates the old position: leaving the index
                // where it was would select whatever row happens to land
                // there next, which is not what the reader pointed at.
                setOpenIndex(0);
              }}
              onSubmit={() => {}}
              focus
            />
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {viewMode === "review" && review ? (
        <ReviewPane
          branch={branch}
          review={review}
          paneMode={paneMode}
          summary={summary}
          summaryPending={summaryPending}
          fileContent={fileContent}
          origins={origins}
          fileError={fileError}
          blast={blast}
          blastError={blastError}
        />
      ) : (
        <Box flexDirection="column" borderStyle="round">
          <Text>{statusLine}</Text>
          <Box>
            {/* The border is always drawn, only its colour changes, so
                taking focus never shifts the rows beside it by a line. */}
            <Box
              width={30}
              flexShrink={0}
              flexDirection="column"
              borderStyle="round"
              borderColor={mapFocus ? "cyan" : undefined}
              borderDimColor={!mapFocus}
            >
              <RepoMap entries={mapRows} cursor={mapFocus ? mapIndex : -1} />
            </Box>
            <Box flexDirection="column" flexGrow={1} paddingLeft={1}>
              {/* The transcript is windowed to its tail so it can't push the
                  live diff pane off the bottom of the terminal — an
                  unbounded transcript column would grow without limit and
                  take the pane with it. */}
              {transcript.slice(-TRANSCRIPT_WINDOW).map((entry, i) => {
                if (entry.kind === "tool") {
                  const line = [entry.verb, entry.path].filter(Boolean).join("  ");
                  // A tool still running is measured against the ticking
                  // clock; a finished one against the moment it finished.
                  const ms = (entry.end ?? now) - entry.at;
                  // Sub-second work gets no number — every Read the agent
                  // does would otherwise carry one, and none of them matter.
                  const failed = entry.status === "failed";
                  // The one line on screen that is still happening gets its
                  // own marker and its clock always visible. Without that it
                  // is indistinguishable from the finished lines above it,
                  // which is exactly the moment a reader wants to know
                  // whether the agent is working or wedged.
                  const inFlight = entry.end === undefined && running;
                  const took = inFlight || ms >= 1000 ? `  ${dur(ms)}` : "";
                  return (
                    <Text
                      key={i}
                      color={failed ? "red" : inFlight ? "cyan" : undefined}
                      dimColor={!failed && !inFlight && ms < SLOW_MS}
                    >
                      {`${failed ? "✖" : inFlight ? "⟳" : "▸"} ${line}${took}`}
                    </Text>
                  );
                }
                if (entry.kind === "thought") {
                  return (
                    <Text key={i} dimColor>
                      {entry.text}
                    </Text>
                  );
                }
                if (entry.kind === "user") {
                  return <Text key={i}>{`> ${entry.text}`}</Text>;
                }
                return <Text key={i}>{entry.text}</Text>;
              })}
              <Box marginTop={1}>
                <LiveDiff file={activeFile} />
              </Box>
            </Box>
          </Box>
          <UsageBar usage={usage} />
          <ChecksPane result={checks} running={checksRunning} />
          <PlanBar entries={plan} />
        </Box>
      )}
      {confirmingExit && (
        <Text color="yellow">
          {confirmReason === "busy"
            ? "Turn running — press Ctrl+C again to exit."
            : "Unaccepted changes in the worktree — press Ctrl+C again to discard them and exit."}
        </Text>
      )}
      {permission && (
        <Text>
          {"  "}
          {permission.req.title} [y] allow [n] reject
        </Text>
      )}
      {viewMode === "review" ? (
        <>
          {reviewMessage && <Text color="red">{reviewMessage}</Text>}
          {/* The accept key is never blocked on a failing check — the
              human decides — but it must never be pressed in ignorance of
              one either, so the count sits directly above the key that
              lands the code. */}
          {checks && !checks.ok && (
            <Text color="red">
              {`  ✖ ${checks.command} is failing${
                checks.problems.length > 0 ? ` (${checks.problems.length} location${checks.problems.length === 1 ? "" : "s"})` : ""
              } — accepting lands it anyway`}
            </Text>
          )}
          {review && <Text dimColor>{selectionLabel(review)}</Text>}
          <Text dimColor>
            {"  [space] select  [j/k] move  [tab] file view  [a] accept  [A] accept unexplained  [q] back"}
          </Text>
        </>
      ) : (
        <>
          {notice && <Text color="yellow">{notice}</Text>}
          <Text dimColor>
            {mapFocus
              ? "  [j/k] move  [⏎] open the file  [tab] back to the prompt"
              : "  [tab] repo map  [r] review  [ctrl-p] open any file"}
          </Text>
          <Box>
            <Text>{"> "}</Text>
            <TextInput value={input} onChange={inputEnabled ? setInput : () => {}} onSubmit={submit} focus={inputEnabled} />
          </Box>
        </>
      )}
    </Box>
  );
}
