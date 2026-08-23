import type { MapEntry } from "./cockpit.js";

// The project as a tree you can walk, rather than a list of what changed.
//
// The change list answers "what did the agent just do". It cannot answer
// "what else is in here", which is the question you ask when you want to read
// the file next to the one being edited — so the rail shows the repo, with
// the changes marked in it.
//
// Directories start closed. Everything on the path to a change is opened, so
// a session's work is visible without a keystroke while the other ten
// thousand files stay one row each.

export interface Row {
  path: string; // repo-relative; the identity used for cursor and selection
  name: string; // just this segment
  depth: number;
  dir: boolean;
  open?: boolean;
  entry?: MapEntry; // set when this file has changes
}

// ancestors("src/auth/token.ts") -> ["src", "src/auth"]
export function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

// openForChanges returns the directories that must be open for every changed
// file to be on screen. This is the default view: a rail that hid the work
// behind a closed `src/` would make you navigate to see what you already
// asked about.
export function openForChanges(changed: Iterable<string>): Set<string> {
  const open = new Set<string>();
  for (const path of changed) for (const dir of ancestors(path)) open.add(dir);
  return open;
}

interface Dir {
  dirs: Map<string, Dir>;
  files: string[];
}

function emptyDir(): Dir {
  return { dirs: new Map(), files: [] };
}

// rows flattens the tree to what is currently visible, in the order it draws.
// Directories sort before files, both alphabetically — the ordering a file
// browser uses, so a path is where the eye expects it.
export function rows(paths: string[], open: Set<string>, changed = new Map<string, MapEntry>()): Row[] {
  const root = emptyDir();
  for (const path of paths) {
    const parts = path.split("/").filter(Boolean);
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.get(part);
      if (next === undefined) {
        next = emptyDir();
        node.dirs.set(part, next);
      }
      node = next;
    }
    const last = parts[parts.length - 1];
    if (last !== undefined) node.files.push(last);
  }

  const out: Row[] = [];
  const walk = (node: Dir, prefix: string, depth: number): void => {
    for (const name of [...node.dirs.keys()].sort()) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      const isOpen = open.has(path);
      out.push({ path, name, depth, dir: true, open: isOpen });
      if (isOpen) walk(node.dirs.get(name)!, path, depth + 1);
    }
    for (const name of [...node.files].sort()) {
      const path = prefix === "" ? name : `${prefix}/${name}`;
      out.push({ path, name, depth, dir: false, entry: changed.get(path) });
    }
  };
  walk(root, "", 0);
  return out;
}

// A cursor that stays on screen without the caller tracking scroll: given the
// cursor and how many rows fit, this is the slice to draw. Kept centred once
// the list is longer than the pane, so moving never puts the cursor on the
// edge with nothing visible past it.
export function window(total: number, cursor: number, height: number): { start: number; end: number } {
  if (total <= height) return { start: 0, end: total };
  const half = Math.floor(height / 2);
  const start = Math.max(0, Math.min(cursor - half, total - height));
  return { start, end: start + height };
}

// toggle opens a closed directory or closes an open one, returning a new set
// rather than mutating: the caller holds it in React state.
export function toggle(open: Set<string>, path: string): Set<string> {
  const next = new Set(open);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}
