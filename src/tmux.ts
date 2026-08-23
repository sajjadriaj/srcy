import { spawn, spawnSync } from "node:child_process";

// ctui runs its own tmux server, on its own socket.
//
// Two reasons, and the second is why it is not optional. Agents want terminal
// features their host has to turn on — Claude Code asks for focus-events, pi
// asks for extended-keys so shift+enter reaches it — and both of those are
// server-wide in tmux. Setting them on a shared server would reach into every
// other session the reader has open and stay changed after ctui exits.
// On our own socket they are ours to set.
//
// The reader's ~/.tmux.conf still loads, so their prefix and keybinds are
// unchanged. The cost is that ctui sessions do not appear in a bare
// `tmux ls` — that is `tmux -L ctui ls`.
export const SOCKET = "ctui";

// The literal `tmux` a shell inside a pane must type to reach this server:
// the teardown line sequenced onto the agent's command runs there, not here.
export const TMUX = `tmux -L ${SOCKET}`;

// ctui does not run the agent. tmux does.
//
// The agent in the big pane is the real `claude` / `codex` / `opencode`
// binary, attached to a real pty, with a real terminal under it: its slash
// commands, its keybinds, its scrollback, its mouse selection and its
// alt-screen all work because nothing here is emulating any of them. The
// panes around it are ctui processes that watch the repo.
//
// tmux is doing the part that would otherwise be a terminal emulator, a pty
// layer and a resize protocol living in this repo, and doing it better than
// a reimplementation would.

// Single-quote for /bin/sh, which is what tmux hands shell-command to.
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function cmdline(argv: string[]): string {
  return argv.map(shq).join(" ");
}

// Rail wide enough for `src/auth/session.ts` plus its counts, without eating
// an 80-column terminal alive. The clamp is the whole point: a percentage
// alone is unreadable when narrow and wasteful when wide.
export function railWidth(cols: number): number {
  return Math.max(30, Math.min(44, Math.floor(cols * 0.3)));
}

// The dock shows a hunk, so it needs the hunk plus its title row. Below
// eight rows it shows a hunk's middle and no context, which is worse than
// showing nothing.
export function dockHeight(rows: number): number {
  return Math.max(8, Math.min(16, Math.floor(rows * 0.28)));
}

export interface Layout {
  session: string;
  repo: string;
  agent: string[];
  panel: (which: string) => string[];
  // How to re-invoke ctui for the window-resized hook, as argv.
  resize: string[];
  cols: number;
  rows: number;
}

// plan returns the tmux commands, in order, as argv arrays. Split out from
// running them so the layout itself — pane order, sizes, which pane the
// keyboard lands on — is testable without a terminal.
export function plan(l: Layout): string[][] {
  const S = l.session;
  const AGENT = "%AGENT%"; // substituted with the real pane id once tmux prints it
  return [
    // The agent's command is sequenced with the teardown rather than hooked:
    // tmux's `pane-exited` hook accepts `set-hook` and then never fires (3.4),
    // so a session whose agent had quit sat there with two panels watching a
    // repo nobody was working on. `;` rather than `&&` — an agent that exits
    // non-zero has still exited.
    ["new-session", "-d", "-s", S, "-c", l.repo, "-x", String(l.cols), "-y", String(l.rows), "-P", "-F", "#{pane_id}",
      `${cmdline(l.agent)}; ${TMUX} kill-session -t ${shq(S)}`],
    // Dock first, while the agent pane is still the whole window — splitting
    // it now is what makes the dock span the full width. Doing this after the
    // rail split would wedge the dock under the agent only.
    ["split-window", "-t", AGENT, "-v", "-l", String(dockHeight(l.rows)), "-c", l.repo, cmdline(l.panel("dock"))],
    ["split-window", "-t", AGENT, "-h", "-b", "-l", String(railWidth(l.cols)), "-c", l.repo, cmdline(l.panel("rail"))],
    // Our panels draw their own section headers; tmux draws the pane titles.
    ["set-option", "-t", S, "pane-border-status", "top"],
    ["set-option", "-t", S, "pane-border-format", " #{pane_title} "],
    ["set-option", "-t", S, "pane-border-style", "fg=colour238"],
    ["set-option", "-t", S, "pane-active-border-style", "fg=cyan"],
    // We have four panels; tmux's own status bar is a fifth row saying
    // nothing this layout doesn't already say.
    ["set-option", "-t", S, "status", "off"],
    ["set-option", "-t", S, "mouse", "on"],
    // What the agents in the pane ask their terminal for. Claude Code wants
    // focus-events so it knows when you looked away; pi wants extended-keys
    // so shift+enter arrives as shift+enter instead of a bare newline. Both
    // are server-wide, which is exactly why ctui has a server of its own.
    ["set-option", "-t", S, "focus-events", "on"],
    ["set-option", "-t", S, "extended-keys", "on"],
    // The agent pane keeps the keyboard: it is the thing you type into.
    // Panels are read-only, and taking focus from the prompt to render a
    // file list would be the tail wagging the dog.
    ["select-pane", "-t", AGENT],
    // See resize(): tmux's proportional resize is wrong for a rail, and this
    // is the event that tells us it just happened.
    ["set-hook", "-t", S, "window-resized", `run-shell ${shq(`${cmdline(l.resize)} ${shq(S)}`)}`],
  ];
}

function tmux(args: string[]): { status: number; out: string } {
  const r = spawnSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8" });
  return { status: r.status ?? 1, out: (r.stdout ?? "").trim() };
}

export function have(bin: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${shq(bin)}`], { stdio: "ignore" }).status === 0;
}

export function sessionExists(name: string): boolean {
  return spawnSync("tmux", ["-L", SOCKET, "has-session", "-t", `=${name}`], { stdio: "ignore" }).status === 0;
}

// build runs the plan and names the panes, leaving the session detached.
// Separate from launch so the layout can be created and inspected without a
// terminal to attach to — which is also how it gets tested.
export function build(l: Layout, titles: Record<string, string>): void {
  const steps = plan(l);
  const first = tmux(steps[0]!);
  if (first.status !== 0) throw new Error(`tmux new-session failed: ${first.out}`);
  const agent = first.out;
  for (const step of steps.slice(1)) {
    const r = tmux(step.map((a) => a.split("%AGENT%").join(agent)));
    if (r.status !== 0) throw new Error(`tmux ${step[0]} failed: ${r.out}`);
  }
  // Titles are set after the splits so each pane id is known. The agent's is
  // the binary's own name — the pane says what is actually running in it.
  const panes = identify(l.session);
  for (const [key, id] of Object.entries(panes)) {
    if (id !== undefined) tmux(["select-pane", "-t", id, "-T", titles[key] ?? ""]);
  }
}

interface Panes {
  rail?: string;
  agent?: string;
  dock?: string;
}

// Which pane is which, by where it sits. Positions are read rather than
// remembered because a pane id is not stable across a session the user has
// since rearranged, and because `ctui resize` runs in a fresh process that
// was never told them.
//
// The dock is the bottom row; of the two above it, the rail is on the left.
// Note pane_top is 1, not 0, whenever pane borders carry titles — matching
// on zero silently labels every pane "dock".
// Split from identify so the rule itself is testable without a tmux server.
// `list-panes -F "#{pane_id} #{pane_left} #{pane_top}"` is the input.
export function pick(listing: string): Panes {
  const rows = listing
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => f.length === 3 && f[0]!.startsWith("%"))
    .map(([id, left, top]) => ({ id: id!, left: Number(left), top: Number(top) }))
    .filter((r) => Number.isFinite(r.left) && Number.isFinite(r.top));
  if (rows.length === 0) return {};
  const bottom = Math.max(...rows.map((r) => r.top));
  const dock = rows.find((r) => r.top === bottom);
  const upper = rows.filter((r) => r.top !== bottom).sort((a, b) => a.left - b.left);
  return { rail: upper[0]?.id, agent: upper[1]?.id, dock: dock?.id };
}

export function identify(session: string): Panes {
  return pick(tmux(["list-panes", "-t", session, "-F", "#{pane_id} #{pane_left} #{pane_top}"]).out);
}

// tmux resizes panes proportionally when the window changes size, so a rail
// laid out at 30% of an 80-column terminal becomes 76 columns in a maximised
// one — a file list with an acre of blank to its right, and the agent
// squeezed. This re-applies the clamp, and is bound to window-resized so it
// runs whenever tmux has just done that.
export function resize(session: string): void {
  const size = tmux(["display-message", "-p", "-t", session, "#{window_width} #{window_height}"]).out;
  const [w, h] = size.split(" ").map(Number);
  if (!Number.isFinite(w!) || !Number.isFinite(h!) || w! <= 0 || h! <= 0) return;
  const panes = identify(session);
  if (panes.rail !== undefined) tmux(["resize-pane", "-t", panes.rail, "-x", String(railWidth(w!))]);
  if (panes.dock !== undefined) tmux(["resize-pane", "-t", panes.dock, "-y", String(dockHeight(h!))]);
}

// Never returns on success: attach replaces this process, which is what
// makes ctui feel like one program rather than a launcher that hangs around.
export function launch(l: Layout, titles: Record<string, string>): void {
  build(l, titles);
  attach(l.session);
}

// Inside an existing tmux, attach-session refuses to nest. switch-client is
// the same gesture from in there, and leaves the outer session alone.
export function attach(session: string): void {
  // TMUX is dropped rather than switch-client'd: ctui's server is not the one
  // the reader may already be sitting in, and tmux refuses to attach at all
  // while that variable says it is already inside a session. Removing it is
  // the standard way to nest, and leaves their outer session alone.
  const env = { ...process.env };
  delete env.TMUX;
  const r = spawn("tmux", ["-L", SOCKET, "attach-session", "-t", session], { stdio: "inherit", env });
  r.on("exit", (code) => process.exit(code ?? 0));
}
