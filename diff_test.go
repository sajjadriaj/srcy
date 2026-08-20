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
@@ -10,1 +11,2 @@ func retryAfter() int
 ten
+eleven
diff --git a/b.txt b/b.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/b.txt
@@ -0,0 +1,1 @@
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
	if !strings.Contains(files[0].Hunks[0].Body, "+two") {
		t.Fatal("hunk body lost its added line")
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
	if !strings.Contains(files[0].Hunks[0].Body, "+diff --git a/fake.txt") {
		t.Fatal("embedded line was dropped from the body")
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
	if !strings.Contains(files[0].Hunks[0].Body, `\ No newline at end of file`) {
		t.Fatal("the no-newline marker must travel with its hunk")
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
