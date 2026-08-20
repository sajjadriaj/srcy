import type { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { AgentSession, AgentUpdate, PermissionRequest } from "./acp.js";
import { changedLines, patchPaths, Review, type Hunk } from "./diff.js";
import { applyPatch, commitAccepted, type Worktree } from "./git.js";

type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; id: string; verb?: string; path?: string };

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

// splitSummary uses the agent's first sentence as the commit subject; the
// rest, if any, becomes the body.
//
// Live-verification finding: the explain prompt asks for plain prose but
// does not forbid a numbered list, and models routinely answer its three
// questions as one. A leading "1. " reads as a false sentence end to a
// naive first-period scan (subject becomes the single character "1"), so a
// leading list/bullet marker is skipped before searching for the real
// terminator. The body always keeps the marker — only the subject search is
// offset past it.
function splitSummary(raw: string): { subject: string; body: string } {
  const s = raw.trim();
  if (s === "") return { subject: "ctui: accept unexplained change", body: "" };
  const marker = /^(\d{1,2}[.)]|[-*])\s+/.exec(s);
  const from = marker ? marker[0].length : 0;
  let idx = -1;
  for (let i = from; i < s.length; i++) {
    if (s[i] === "." || s[i] === "\n") {
      idx = i;
      break;
    }
  }
  if (idx > from && idx < from + 72) {
    return { subject: s.slice(from, idx).trim(), body: s.slice(idx + 1).trim() };
  }
  if (s.length - from > 72) {
    return { subject: s.slice(from, from + 69) + "...", body: s };
  }
  return { subject: s.slice(from).trim(), body: "" };
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
}: {
  content: string;
  changed: Set<number>;
  centerLine: number;
}): React.JSX.Element {
  const lines = content.split("\n");
  const start = Math.max(1, centerLine - FILE_VIEW_WINDOW);
  const end = Math.min(lines.length, centerLine + FILE_VIEW_WINDOW);
  const rows: React.JSX.Element[] = [];
  for (let n = start; n <= end; n++) {
    const isChanged = changed.has(n);
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
function ReviewPane({
  branch,
  review,
  paneMode,
  summary,
  summaryPending,
  fileContent,
  fileError,
}: {
  branch: string;
  review: Review;
  paneMode: "patch" | "file";
  summary: string;
  summaryPending: boolean;
  fileContent: string | null;
  fileError: string | null;
}): React.JSX.Element {
  const file = review.files[review.fi];
  const hunk: Hunk | undefined = file?.hunks[review.hi];
  const selected = file ? review.selected(review.fi, review.hi) : false;
  const position = file ? (file.hunks.length > 0 ? `hunk ${review.hi + 1}/${file.hunks.length}` : "(no hunks)") : "";

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
            <FileWindow content={fileContent} changed={changedLines(file)} centerLine={hunk?.newStart ?? 1} />
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
  onExit: (result: { agentDied: boolean }) => void;
}

export function App({ branch, session, bridge, worktree, initialMode, modeDegraded, onExit }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [mode, setMode] = useState(initialMode);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [permission, setPermission] = useState<{ req: PermissionRequest; respond: (id: string | null) => void } | null>(
    null,
  );
  const [confirmingExit, setConfirmingExit] = useState(false);
  const [agentDied, setAgentDied] = useState(false);
  const [lastPrompt, setLastPrompt] = useState("");

  // Review state. `review` is a mutable class instance (toggle/next/prev
  // mutate it in place, per diff.ts); reviewVersion is bumped after every
  // mutation purely to force a re-render, since React does not see a
  // mutation to an object it already holds a reference to.
  const [viewMode, setViewMode] = useState<"chat" | "review">("chat");
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [reviewVersion, setReviewVersion] = useState(0);
  const [paneMode, setPaneMode] = useState<"patch" | "file">("patch");
  const [summary, setSummary] = useState("");
  const [summaryPending, setSummaryPending] = useState(false);
  const [reviewMessage, setReviewMessage] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  // True only while the explain-gate prompt itself is in flight, so
  // onUpdate can route its streamed answer into the summary instead of the
  // transcript. A plain ref: it must be current inside the bridge listener
  // closure without forcing that effect to re-subscribe on every chunk.
  const explainInFlightRef = useRef(false);
  const reviewOpeningRef = useRef(false);
  const acceptingRef = useRef(false);

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
  function upsertTool(id: string, patch: { verb?: string; path?: string }): void {
    setTranscript((prev) => {
      const idx = prev.findIndex((e) => e.kind === "tool" && e.id === id);
      if (idx === -1) {
        return [...prev, { kind: "tool", id, ...patch }];
      }
      const merged = { ...prev[idx], ...patch };
      return [...prev.slice(0, idx), merged, ...prev.slice(idx + 1)];
    });
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
            const patch: { verb?: string; path?: string } = {};
            if (verb !== undefined) patch.verb = verb;
            if (u.toolPath !== undefined) patch.path = u.toolPath;
            upsertTool(u.toolCallId, patch);
          }
          break;
        }
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

  // Loads the current file's content from the worktree whenever file view
  // is active and the cursor (or the review itself) moves. Reads from
  // worktree.path — the agent's own checkout — not the real repo, so file
  // view shows the change exactly as it stands before acceptance.
  useEffect(() => {
    if (!review || paneMode !== "file") return;
    const file = review.files[review.fi];
    if (!file) return;
    if (file.binary) {
      setFileContent(null);
      setFileError("(binary or metadata-only change)");
      return;
    }
    let cancelled = false;
    readFile(join(worktree.path, file.path), "utf8")
      .then((content) => {
        if (cancelled) return;
        setFileContent(content);
        setFileError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setFileContent(null);
        const message = err instanceof Error ? err.message : String(err);
        setFileError(`(could not read file: ${message})`);
      });
    return () => {
      cancelled = true;
    };
  }, [review, reviewVersion, paneMode, worktree.path]);

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
      setReview(new Review(raw));
      setReviewVersion(0);
      setPaneMode("patch");
      setSummary("");
      setSummaryPending(true);
      setReviewMessage(null);
      setFileContent(null);
      setFileError(null);
      setViewMode("review");
      void sendExplainPrompt();
    } finally {
      reviewOpeningRef.current = false;
    }
  }

  function closeReview(): void {
    setViewMode("chat");
    setReview(null);
    setReviewMessage(null);
    setFileContent(null);
    setFileError(null);
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
      try {
        await applyPatch(worktree.repo, patch);
      } catch (err) {
        // Nothing was applied — git's own guarantee. Show its error and let
        // the worktree and repo sit exactly as they were.
        const message = err instanceof Error ? err.message : String(err);
        setReviewMessage(`apply failed, nothing changed: ${message}`);
        return;
      }

      const paths = patchPaths(review.files, (fi, hi) => review.selected(fi, hi));
      const { subject, body } = splitSummary(unexplained ? "" : summary);
      const promptTrailer = unexplained ? "<none>" : lastPrompt;
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

  useInput((char, key) => {
    if (key.ctrl && char === "c") {
      if (confirmingExit || !running) {
        onExit({ agentDied });
        exit();
      } else {
        setConfirmingExit(true);
      }
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
      void openReview();
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
    }
  }

  const statusWord = agentDied ? "agent exited" : running ? "running" : "idle";
  const modeWord = modeDegraded ? `${mode} mode (gate degraded)` : `${mode} mode`;
  const inputEnabled = !running && !permission && !agentDied && viewMode === "chat";

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
          fileError={fileError}
        />
      ) : (
        <Box flexDirection="column" borderStyle="round">
          <Text>
            {branch} · {modeWord} · {statusWord}
          </Text>
          {transcript.map((entry, i) => {
            if (entry.kind === "tool") {
              const line = [entry.verb, entry.path].filter(Boolean).join("  ");
              return (
                <Text key={i} dimColor>
                  {`▸ ${line}`}
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
        </Box>
      )}
      {confirmingExit && <Text color="yellow">Turn running — press Ctrl+C again to exit.</Text>}
      {permission && (
        <Text>
          {"  "}
          {permission.req.title} [y] allow [n] reject
        </Text>
      )}
      {viewMode === "review" ? (
        <>
          {reviewMessage && <Text color="red">{reviewMessage}</Text>}
          <Text dimColor>
            {"  [space] select  [j/k] move  [tab] file view  [a] accept  [A] accept unexplained  [q] back"}
          </Text>
        </>
      ) : (
        <>
          {notice && <Text color="yellow">{notice}</Text>}
          <Box>
            <Text>{"> "}</Text>
            <TextInput value={input} onChange={inputEnabled ? setInput : () => {}} onSubmit={submit} focus={inputEnabled} />
          </Box>
        </>
      )}
    </Box>
  );
}
