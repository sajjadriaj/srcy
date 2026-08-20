package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const twoFileDiff = `diff --git a/a.txt b/a.txt
index 1111111..2222222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,3 @@ func Get(id string) error
 one
+two
 three
@@ -10 +11,2 @@ func retryAfter() int
 ten
+eleven
diff --git a/b.txt b/b.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/b.txt
@@ -0,0 +1 @@
+brand new
`

func TestSplitDiffSeparatesFilesAndHunks(t *testing.T) {
	files := SplitDiff(twoFileDiff)
	if len(files) != 2 {
		t.Fatalf("got %d files, want 2", len(files))
	}
	if files[0].Path != "a.txt" || files[1].Path != "b.txt" {
		t.Fatalf("paths = %q, %q", files[0].Path, files[1].Path)
	}
	if len(files[0].Hunks) != 2 {
		t.Fatalf("a.txt: got %d hunks, want 2", len(files[0].Hunks))
	}
	if files[0].Hunks[0].Func != "func Get(id string) error" {
		t.Fatalf("hunk header func = %q", files[0].Hunks[0].Func)
	}
	if files[0].Hunks[1].NewStart != 11 || files[0].Hunks[1].NewCount != 2 {
		t.Fatalf("second hunk range = %d,%d", files[0].Hunks[1].NewStart, files[0].Hunks[1].NewCount)
	}
	wantBody := " one\n+two\n three\n"
	if files[0].Hunks[0].Body != wantBody {
		t.Fatalf("hunk body = %q, want %q", files[0].Hunks[0].Body, wantBody)
	}
}

// The dangerous case: a context line that looks like a file boundary.
// Line counts, not string matching, decide where a hunk ends.
func TestSplitDiffSurvivesDiffTextInsideAHunk(t *testing.T) {
	raw := `diff --git a/doc.md b/doc.md
--- a/doc.md
+++ b/doc.md
@@ -1,3 +1,4 @@
 Example output:
+diff --git a/fake.txt b/fake.txt
 @@ -1,1 +1,1 @@
 done
`
	files := SplitDiff(raw)
	if len(files) != 1 {
		t.Fatalf("got %d files, want 1 — embedded diff text split the hunk", len(files))
	}
	if len(files[0].Hunks) != 1 {
		t.Fatalf("got %d hunks, want 1", len(files[0].Hunks))
	}
	wantBody := " Example output:\n+diff --git a/fake.txt b/fake.txt\n @@ -1,1 +1,1 @@\n done\n"
	if files[0].Hunks[0].Body != wantBody {
		t.Fatalf("hunk body = %q, want %q", files[0].Hunks[0].Body, wantBody)
	}
}

func TestSplitDiffHandlesBinaryFiles(t *testing.T) {
	raw := `diff --git a/img.png b/img.png
index 1111111..2222222 100644
Binary files a/img.png and b/img.png differ
`
	files := SplitDiff(raw)
	if len(files) != 1 || !files[0].Binary {
		t.Fatalf("binary file not detected: %+v", files)
	}
	if len(files[0].Hunks) != 0 {
		t.Fatal("binary files have no hunks")
	}
}

func TestSplitDiffPreservesNoNewlineMarker(t *testing.T) {
	raw := `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,1 @@
-one
+two
\ No newline at end of file
`
	files := SplitDiff(raw)
	wantBody := "-one\n+two\n\\ No newline at end of file\n"
	if files[0].Hunks[0].Body != wantBody {
		t.Fatalf("hunk body = %q, want %q", files[0].Hunks[0].Body, wantBody)
	}
}

func TestBuildPatchKeepsOnlySelectedHunks(t *testing.T) {
	files := SplitDiff(twoFileDiff)
	// Take only a.txt's second hunk.
	patch := BuildPatch(files, func(fi, hi int) bool { return fi == 0 && hi == 1 })

	if !strings.Contains(patch, "+eleven") {
		t.Error("selected hunk missing")
	}
	if strings.Contains(patch, "+two") {
		t.Error("unselected hunk leaked into the patch")
	}
	if strings.Contains(patch, "b.txt") {
		t.Error("a file with no selected hunks must be omitted entirely")
	}
	if !strings.HasPrefix(patch, "diff --git a/a.txt b/a.txt\n") {
		t.Error("file header missing — git apply needs it")
	}
}

func TestBuildPatchIncludesBinaryFileWhenSelected(t *testing.T) {
	raw := `diff --git a/img.png b/img.png
index 1111111..2222222 100644
Binary files a/img.png and b/img.png differ
`
	files := SplitDiff(raw)
	patch := BuildPatch(files, func(fi, hi int) bool { return true })
	if !strings.Contains(patch, "Binary files") {
		t.Fatal("a selected binary file must keep its whole section")
	}
}

// Guards against a naive implementation that scans for the next line
// starting with "@@ " or "diff --git " instead of consuming exactly the
// counts the @@ header declares. The trailing junk line here has neither
// prefix, so a prefix-scanning splitter would swallow it into the hunk
// body; a count-based one stops exactly where the header says to.
func TestSplitDiffStopsAtDeclaredHunkCounts(t *testing.T) {
	raw := "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n" +
		"@@ -1,1 +1,1 @@\n-one\n+two\n" +
		"An unprefixed trailing line, not part of the hunk.\n"
	files := SplitDiff(raw)
	want := "-one\n+two\n"
	if got := files[0].Hunks[0].Body; got != want {
		t.Fatalf("hunk body = %q, want %q — a prefix scan would have swallowed the trailing line", got, want)
	}
}

// An @@ line that fails to parse must not delete the hunk body that follows
// it, nor swallow every later hunk in the file as junk.
func TestSplitDiffRecoversFromUnparseableHunkHeader(t *testing.T) {
	raw := "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n" +
		"@@ -x,y +z,w @@\n-old\n+new\n" +
		"@@ -10,1 +10,2 @@\n ten\n+eleven\n"
	files := SplitDiff(raw)
	if len(files) != 1 {
		t.Fatalf("got %d files, want 1", len(files))
	}
	if len(files[0].Hunks) != 2 {
		t.Fatalf("got %d hunks, want 2 — a later hunk was discarded as junk", len(files[0].Hunks))
	}
	if files[0].Hunks[0].Body != "-old\n+new\n" {
		t.Fatalf("first (unparseable) hunk body = %q", files[0].Hunks[0].Body)
	}
	if files[0].Hunks[1].Body != " ten\n+eleven\n" {
		t.Fatalf("second hunk body = %q", files[0].Hunks[1].Body)
	}
}

// The no-newline marker can also appear mid-hunk, attached to a removed
// line, not just trailing the whole hunk — a different code path from the
// trailing case above: it fires while the line budget is still open, not
// after it has been exhausted.
func TestSplitDiffKeepsNoNewlineMarkerMidHunk(t *testing.T) {
	raw := "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n" +
		"@@ -1,2 +1,3 @@\n one\n-two\n\\ No newline at end of file\n+two\n+three\n"
	files := SplitDiff(raw)
	want := " one\n-two\n\\ No newline at end of file\n+two\n+three\n"
	if got := files[0].Hunks[0].Body; got != want {
		t.Fatalf("body = %q, want %q", got, want)
	}
}

// BuildPatch never reads Path, but a later task scopes a `git commit` by
// it, so it must survive spaces and git's quoting intact rather than the
// mangled output of splitting the "diff --git" line on whitespace.
func TestSplitDiffPathSurvivesSpacesAndQuoting(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{
			name: "unquoted path with spaces",
			raw: `diff --git a/my file.txt b/my file.txt
index 1111111..2222222 100644
--- a/my file.txt
+++ b/my file.txt
@@ -1,1 +1,1 @@
-old
+new
`,
			want: "my file.txt",
		},
		{
			name: "git-quoted non-ASCII path",
			raw: `diff --git "a/caf\303\251.txt" "b/caf\303\251.txt"
index 1111111..2222222 100644
--- "a/caf\303\251.txt"
+++ "b/caf\303\251.txt"
@@ -1,1 +1,1 @@
-old
+new
`,
			want: "café.txt",
		},
		{
			name: "quoted path with spaces",
			raw: `diff --git "a/caf\303\251 report.txt" "b/caf\303\251 report.txt"
index 1111111..2222222 100644
--- "a/caf\303\251 report.txt"
+++ "b/caf\303\251 report.txt"
@@ -1,1 +1,1 @@
-old
+new
`,
			want: "café report.txt",
		},
		{
			name: "deletion uses the old-side name",
			raw: `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 1111111..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-bye
`,
			want: "gone.txt",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			files := SplitDiff(c.raw)
			if len(files) != 1 {
				t.Fatalf("got %d files, want 1", len(files))
			}
			if files[0].Path != c.want {
				t.Fatalf("Path = %q, want %q", files[0].Path, c.want)
			}
		})
	}
}

// A hunkless section — a pure rename or a mode-only change — must survive
// selecting everything. Real git output only: a hand-written fixture is how
// this bug (BuildPatch dropping such sections) was missed the first time.
func TestBuildPatchKeepsHunklessFileSections(t *testing.T) {
	repo := newRepo(t)
	write(t, repo, "b.sh", "#!/bin/sh\necho hi\n")
	if _, err := git(repo, "add", "-A"); err != nil {
		t.Fatal(err)
	}
	if _, err := git(repo, "commit", "-qm", "add b.sh"); err != nil {
		t.Fatal(err)
	}
	wt, err := CreateWorktree(repo, "s1")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(wt.Path, "a.txt"), filepath.Join(wt.Path, "renamed.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(wt.Path, "b.sh"), 0o755); err != nil {
		t.Fatal(err)
	}

	raw, err := wt.Diff()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, "rename from a.txt") || !strings.Contains(raw, "old mode 100644") {
		t.Fatalf("test setup did not produce a rename and a mode change; got:\n%s", raw)
	}

	files := SplitDiff(raw)
	foundRename := false
	for _, f := range files {
		if f.Path == "renamed.txt" {
			foundRename = true
		}
	}
	if !foundRename {
		t.Error("renamed file's Path should be the new name \"renamed.txt\"")
	}

	patch := BuildPatch(files, func(fi, hi int) bool { return true })
	if patch != raw {
		t.Errorf("hunkless sections lost when selecting everything\n--- got ---\n%s\n--- want ---\n%s", patch, raw)
	}
}

// The unit tests above use hand-written diffs. This one proves the splitter
// survives git's real output and that the reassembled patch still applies.
//
// applyPatch is implemented in Task 8; until then this test is skipped, and
// the call to it stays commented out below so the package still compiles
// (a skipped test's body is still type-checked — an undefined reference
// would fail the build even though the test never runs).
func TestBuildPatchRoundTripsThroughGitApply(t *testing.T) {
	t.Skip("unskipped in Task 8, once applyPatch exists")

	repo := newRepo(t)
	wt, err := CreateWorktree(repo, "s1")
	if err != nil {
		t.Fatal(err)
	}
	write(t, wt.Path, "a.txt", "one\ntwo\n")
	write(t, wt.Path, "new.txt", "brand new\n")

	raw, err := wt.Diff()
	if err != nil {
		t.Fatal(err)
	}
	patch := BuildPatch(SplitDiff(raw), func(fi, hi int) bool { return true })
	if patch != raw {
		t.Errorf("selecting everything must reproduce the diff byte for byte\n--- got ---\n%s\n--- want ---\n%s", patch, raw)
	}
	// if err := applyPatch(repo, patch); err != nil {
	// 	t.Fatalf("reassembled patch did not apply: %v", err)
	// }
	got, err := os.ReadFile(filepath.Join(repo, "new.txt"))
	if err != nil || string(got) != "brand new\n" {
		t.Fatalf("file not applied: %q %v", got, err)
	}
}
