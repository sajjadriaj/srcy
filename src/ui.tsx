import type { EventEmitter } from "node:events";
import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import type { AgentSession, AgentUpdate, PermissionRequest } from "./acp.js";

type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; label: string };

// The bridge is how index.ts (which owns the real AgentSession, created
// before this component ever mounts) hands live events to this component.
// It emits:
//   "update"     (u: AgentUpdate)
//   "permission" (req: PermissionRequest, respond: (optionId: string | null) => void)
export interface AppProps {
  branch: string;
  session: AgentSession;
  bridge: EventEmitter;
  // The mode ctui resolved at startup (after attempting to pin "default").
  initialMode: string;
  // True if we could not confirm the session is in "default" mode — the
  // approval gate may be degraded, so this must stay visible, not silent.
  modeDegraded: boolean;
  onExit: (result: { agentDied: boolean }) => void;
}

export function App({ branch, session, bridge, initialMode, modeDegraded, onExit }: AppProps): React.JSX.Element {
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

  useEffect(() => {
    function onUpdate(u: AgentUpdate): void {
      switch (u.kind) {
        case "agent_message_chunk":
          append({ kind: "agent", text: u.text ?? "" });
          break;
        case "agent_thought_chunk":
          append({ kind: "thought", text: u.text ?? "" });
          break;
        case "tool_call":
        case "tool_call_update": {
          // Prefer the (already relativized) toolPath over the raw title:
          // this adapter's titles embed absolute paths ("Write /long/abs/
          // path/note.txt"), which wraps uselessly in a narrow terminal.
          const label = u.toolPath ?? u.toolTitle;
          if (label) append({ kind: "tool", label });
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

    if (key.escape && running) {
      session.cancel().catch(() => {});
    }
  });

  async function submit(value: string): Promise<void> {
    const text = value.trim();
    if (!text || running || permission) return;
    setInput("");
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
  const inputEnabled = !running && !permission && !agentDied;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" borderStyle="round">
        <Text>
          {branch} · {modeWord} · {statusWord}
        </Text>
        {transcript.map((entry, i) => {
          if (entry.kind === "tool") {
            return (
              <Text key={i} dimColor>
                {`▸ ${entry.label}`}
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
      {confirmingExit && <Text color="yellow">Turn running — press Ctrl+C again to exit.</Text>}
      {permission && (
        <Text>
          {"  "}
          {permission.req.title} [y] allow [n] reject
        </Text>
      )}
      <Box>
        <Text>{"> "}</Text>
        <TextInput value={input} onChange={inputEnabled ? setInput : () => {}} onSubmit={submit} focus={inputEnabled} />
      </Box>
    </Box>
  );
}
