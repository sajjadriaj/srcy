import assert from "node:assert/strict";
import test from "node:test";
import { editorArgv } from "../src/editor.js";

test("the editor is the reader's own, opened on the line under the cursor", () => {
  // The pager convention, which every terminal editor honours.
  assert.deepEqual(editorArgv({ EDITOR: "vim" }, "src/a.ts", 42), ["vim", "+42", "src/a.ts"]);
  assert.deepEqual(editorArgv({ VISUAL: "nvim", EDITOR: "vi" }, "src/a.ts", 42), ["nvim", "+42", "src/a.ts"]);
  assert.deepEqual(editorArgv({ EDITOR: "emacs -nw" }, "src/a.ts", 7), ["emacs", "-nw", "+7", "src/a.ts"]);
  // GUI editors take file:line, and would otherwise open a file named "+42".
  assert.deepEqual(editorArgv({ EDITOR: "code --wait" }, "src/a.ts", 42), ["code", "--wait", "-g", "src/a.ts:42"]);
  assert.deepEqual(editorArgv({ EDITOR: "zed" }, "src/a.ts", 42), ["zed", "src/a.ts:42"]);
  // No line is the file alone; no editor at all is vi, which every box has.
  assert.deepEqual(editorArgv({ EDITOR: "vim" }, "src/a.ts", 0), ["vim", "src/a.ts"]);
  assert.deepEqual(editorArgv({}, "src/a.ts", 3), ["vi", "+3", "src/a.ts"]);
});
