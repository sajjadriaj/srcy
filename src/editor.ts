import { cmdline, tmuxRun } from "./tmux.js";

// From the review pane to the reader's editor, and from the review pane to
// the agent's prompt. Both are the last step srcy left by hand: you found
// the line, now go and look at it properly, or tell the agent about it.

// GUI editors take file:line; terminal editors take +line. The editor is the
// reader's own, from the variables every other tool reads.
const GUI = new Set(["code", "codium", "code-insiders", "cursor", "zed", "subl", "atom", "windsurf"]);

export function editorArgv(env: NodeJS.ProcessEnv, path: string, line: number): string[] {
  const words = (env.VISUAL ?? env.EDITOR ?? "vi").split(" ").filter((w) => w !== "");
  const bin = (words[0] ?? "vi").split("/").pop() ?? "vi";
  if (line <= 0) return [...words, path];
  if (GUI.has(bin)) {
    // `-g` is VS Code's spelling; zed and sublime take file:line bare.
    return bin.startsWith("code") || bin === "cursor" || bin === "windsurf" ? [...words, "-g", `${path}:${line}`] : [...words, `${path}:${line}`];
  }
  return [...words, `+${line}`, path];
}

// A new window in srcy's own session, so the editor gets the whole terminal
// and closing it lands back on the panes. Never the agent's pane.
export function openEditor(session: string, cwd: string, argv: string[]): void {
  if (session === "") return;
  tmuxRun(["new-window", "-t", session, "-c", cwd, cmdline(argv)]);
}

// Into tmux's paste buffer, where `ctrl-b ]` in the agent's pane puts it on
// the prompt, and onto the terminal's clipboard for everything else. srcy
// still sends the agent nothing: the reader pastes, or does not.
export function yank(session: string, text: string): void {
  if (text === "") return;
  if (session !== "") tmuxRun(["set-buffer", text]);
  if (process.stdout.isTTY === true) {
    process.stdout.write(`\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`);
  }
}
