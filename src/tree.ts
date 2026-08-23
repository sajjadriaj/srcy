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

// What the reader has opened and closed by hand, on top of what the work
// opens by itself.
//
// A single "manual overrides everything" set was wrong: touching one
// directory froze the view, so a change the agent made somewhere else after
// that stayed hidden behind a closed folder. These are overrides, and
// everything not overridden still follows the work.
export interface Manual {
  opened: Set<string>;
  closed: Set<string>;
}

export const NOTHING: Manual = { opened: new Set(), closed: new Set() };

export function openSet(auto: Set<string>, manual: Manual): Set<string> {
  const open = new Set(auto);
  for (const p of manual.opened) open.add(p);
  for (const p of manual.closed) open.delete(p);
  return open;
}

// toggle records the override rather than the resulting state, so a
// directory the reader closed stays closed when the agent edits inside it —
// and one they opened stays open when it no longer holds a change.
export function toggle(manual: Manual, path: string, isOpen: boolean): Manual {
  const opened = new Set(manual.opened);
  const closed = new Set(manual.closed);
  if (isOpen) {
    opened.delete(path);
    closed.add(path);
  } else {
    closed.delete(path);
    opened.add(path);
  }
  return { opened, closed };
}
