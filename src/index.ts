import { EventEmitter } from "node:events";
import React from "react";
import { render } from "ink";
import { git, createWorktree } from "./git.js";
import { startSession, type AgentSession, type AgentUpdate, type PermissionRequest } from "./acp.js";
import { App } from "./ui.js";

function parseArgs(argv: string[]): { name: string } {
  let name = "s1";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name") {
      const value = argv[i + 1];
      if (value === undefined) {
        console.error("ctui: --name requires a value");
        process.exit(1);
      }
      name = value;
      i++;
    }
  }
  return { name };
}

// Attempts to pin the session to "default" mode, per the invariant that
// nothing the agent writes should land unreviewed regardless of the user's
// ambient adapter config. If we can't confirm "default", the caller must
// show the actual mode prominently rather than silently trust it.
async function resolveMode(session: AgentSession): Promise<{ mode: string; degraded: boolean }> {
  const modes = session.modes;
  if (!modes) return { mode: "unknown", degraded: true };
  if (modes.currentModeId === "default") return { mode: "default", degraded: false };
  const hasDefault = modes.availableModes.some((m) => m.id === "default");
  if (!hasDefault) return { mode: modes.currentModeId, degraded: true };
  try {
    await session.setMode("default");
    return { mode: "default", degraded: false };
  } catch {
    return { mode: modes.currentModeId, degraded: true };
  }
}

async function main(): Promise<void> {
  const { name } = parseArgs(process.argv.slice(2));

  let repo: string;
  try {
    repo = await git(process.cwd(), "rev-parse", "--show-toplevel");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`ctui must be run inside a git repository. (${detail})`);
    process.exit(1);
  }

  const worktree = await createWorktree(repo, name);

  const bridge = new EventEmitter();
  let session: AgentSession;
  try {
    session = await startSession({
      cwd: worktree.path,
      onUpdate: (u: AgentUpdate) => bridge.emit("update", u),
      onPermission: (req: PermissionRequest) =>
        new Promise<string | null>((resolve) => bridge.emit("permission", req, resolve)),
    });
  } catch (err) {
    // Nothing ran, so there is no work to preserve.
    await worktree.destroy().catch(() => {});
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`ctui: failed to start agent session: ${detail}`);
    process.exit(1);
  }

  const { mode: initialMode, degraded: modeDegraded } = await resolveMode(session);

  let agentDied = false;
  const instance = render(
    React.createElement(App, {
      branch: worktree.branch,
      session,
      bridge,
      initialMode,
      modeDegraded,
      onExit: (result: { agentDied: boolean }) => {
        agentDied = result.agentDied;
      },
    }),
    // Ink's default Ctrl+C handling exits immediately and unconditionally,
    // bypassing App's own confirm-before-exit-while-running logic. Disabling
    // it hands every Ctrl+C to App's useInput handler instead.
    { exitOnCtrlC: false },
  );

  await instance.waitUntilExit();
  await session.close().catch(() => {});

  if (agentDied) {
    console.error(`Agent process exited unexpectedly. Worktree kept at ${worktree.path}`);
    return;
  }
  await worktree.destroy();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
