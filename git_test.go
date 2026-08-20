package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// newRepo makes a temp git repo with one commit and returns its path.
func newRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"},
		{"config", "user.name", "t"},
		{"config", "user.email", "t@t"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	write(t, dir, "a.txt", "one\n")
	if _, err := git(dir, "add", "-A"); err != nil {
		t.Fatal(err)
	}
	if _, err := git(dir, "commit", "-qm", "init"); err != nil {
		t.Fatal(err)
	}
	return dir
}

func write(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestGitReturnsTrimmedStdout(t *testing.T) {
	repo := newRepo(t)
	out, err := git(repo, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	if out != "main" {
		t.Fatalf("got %q, want %q", out, "main")
	}
}

func TestGitErrorIncludesStderr(t *testing.T) {
	repo := newRepo(t)
	_, err := git(repo, "rev-parse", "--verify", "no-such-ref")
	if err == nil {
		t.Fatal("expected an error")
	}
	if !strings.Contains(err.Error(), "no-such-ref") {
		t.Fatalf("error should quote git's stderr, got: %v", err)
	}
}

func TestCreateWorktree(t *testing.T) {
	repo := newRepo(t)
	head, err := git(repo, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}

	wt, err := CreateWorktree(repo, "s1")
	if err != nil {
		t.Fatal(err)
	}
	if wt.Base != head {
		t.Fatalf("base = %q, want HEAD %q", wt.Base, head)
	}
	if wt.Branch != "ctui/s1" {
		t.Fatalf("branch = %q", wt.Branch)
	}
	if _, err := os.Stat(filepath.Join(wt.Path, "a.txt")); err != nil {
		t.Fatalf("worktree should contain the repo contents: %v", err)
	}

	// .ctui must be excluded without touching the user's .gitignore.
	excl, err := os.ReadFile(filepath.Join(repo, ".git", "info", "exclude"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(excl), ".ctui/") {
		t.Fatal(".ctui/ was not added to .git/info/exclude")
	}
	if _, err := os.Stat(filepath.Join(repo, ".gitignore")); !os.IsNotExist(err) {
		t.Fatal("must not create or modify the user's .gitignore")
	}
}

func TestCreateWorktreeIsIdempotentlyExcluded(t *testing.T) {
	repo := newRepo(t)
	if _, err := CreateWorktree(repo, "s1"); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateWorktree(repo, "s2"); err != nil {
		t.Fatal(err)
	}
	excl, _ := os.ReadFile(filepath.Join(repo, ".git", "info", "exclude"))
	if strings.Count(string(excl), ".ctui/") != 1 {
		t.Fatalf("exclude entry written twice:\n%s", excl)
	}
}

func TestCreateWorktreeRejectsDuplicateName(t *testing.T) {
	repo := newRepo(t)
	if _, err := CreateWorktree(repo, "s1"); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateWorktree(repo, "s1"); err == nil {
		t.Fatal("expected an error for an existing branch")
	}
}

func TestDestroyWorktree(t *testing.T) {
	repo := newRepo(t)
	wt, err := CreateWorktree(repo, "s1")
	if err != nil {
		t.Fatal(err)
	}
	if err := wt.Destroy(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(wt.Path); !os.IsNotExist(err) {
		t.Fatal("worktree directory should be gone")
	}
	if _, err := git(repo, "rev-parse", "--verify", "ctui/s1"); err == nil {
		t.Fatal("branch should be deleted")
	}
}

func TestDestroyRemovesWorktreeWithUncommittedWork(t *testing.T) {
	repo := newRepo(t)
	wt, err := CreateWorktree(repo, "s1")
	if err != nil {
		t.Fatal(err)
	}
	write(t, wt.Path, "dirty.txt", "agent left this\n")
	if err := wt.Destroy(); err != nil {
		t.Fatalf("destroy must force-remove a dirty worktree: %v", err)
	}
}

func TestDiffIncludesUntrackedFiles(t *testing.T) {
	repo := newRepo(t)
	wt, err := CreateWorktree(repo, "s1")
	if err != nil {
		t.Fatal(err)
	}
	// An agent edits one file and creates another, committing neither.
	write(t, wt.Path, "a.txt", "one\ntwo\n")
	write(t, wt.Path, "new.txt", "brand new\n")

	d, err := wt.Diff()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(d, "a.txt") {
		t.Error("modified file missing from diff")
	}
	if !strings.Contains(d, "new.txt") {
		t.Error("untracked file missing from diff — plain `git diff` would miss it")
	}
	if !strings.Contains(d, "+brand new") {
		t.Error("new file's contents missing from diff")
	}
}

func TestDiffIsEmptyWhenNothingChanged(t *testing.T) {
	repo := newRepo(t)
	wt, err := CreateWorktree(repo, "s1")
	if err != nil {
		t.Fatal(err)
	}
	d, err := wt.Diff()
	if err != nil {
		t.Fatal(err)
	}
	if d != "" {
		t.Fatalf("want empty diff, got:\n%s", d)
	}
}

func TestCreateWorktreeRollsBackOnPostcreateFailure(t *testing.T) {
	repo := newRepo(t)
	// Create a failing postcreate script.
	postcreateDir := filepath.Join(repo, ".ctui")
	if err := os.MkdirAll(postcreateDir, 0o755); err != nil {
		t.Fatal(err)
	}
	postcreate := filepath.Join(postcreateDir, "postcreate")
	if err := os.WriteFile(postcreate, []byte("#!/bin/sh\nexit 1"), 0o755); err != nil {
		t.Fatal(err)
	}

	// Attempt to create worktree — postcreate will fail.
	_, err := CreateWorktree(repo, "s1")
	if err == nil {
		t.Fatal("expected postcreate to fail")
	}

	// Verify worktree was cleaned up: directory should be gone.
	wtPath := filepath.Join(repo, ".ctui", "wt", "s1")
	if _, err := os.Stat(wtPath); !os.IsNotExist(err) {
		t.Fatal("worktree directory should be removed after postcreate failure")
	}

	// Verify branch was cleaned up.
	_, err = git(repo, "rev-parse", "--verify", "ctui/s1")
	if err == nil {
		t.Fatal("branch ctui/s1 should be deleted after postcreate failure")
	}
}

func TestDiffHunkHeadersCarryFunctionNames(t *testing.T) {
	repo := newRepo(t)
	write(t, repo, "svc.go", "package p\n\nfunc Get(id string) error {\n\tx := 1\n\ty := 2\n\tz := 3\n\treturn nil\n}\n")
	git(repo, "add", "-A")
	git(repo, "commit", "-qm", "svc")

	wt, err := CreateWorktree(repo, "s1")
	if err != nil {
		t.Fatal(err)
	}
	write(t, wt.Path, "svc.go", "package p\n\nfunc Get(id string) error {\n\tx := 1\n\ty := 2\n\tz := 4\n\treturn nil\n}\n")

	d, err := wt.Diff()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(d, "@@ ") || !strings.Contains(d, "func Get") {
		t.Fatalf("hunk header lost its function name — git is not reading our attributes file:\n%s", d)
	}
}

// The driver must beat git's generic fallback, which reports the enclosing
// class for an indented method — the wrong symbol, and silently wrong.
func TestDiffFindsIndentedMethodNotEnclosingClass(t *testing.T) {
	repo := newRepo(t)
	body := "class Widget:\n    def retry_after(self, n):\n"
	for i := 1; i <= 12; i++ {
		body += fmt.Sprintf("        a%d = %d\n", i, i)
	}
	write(t, repo, "w.py", body)
	git(repo, "add", "-A")
	git(repo, "commit", "-qm", "w")

	wt, err := CreateWorktree(repo, "s1")
	if err != nil {
		t.Fatal(err)
	}
	write(t, wt.Path, "w.py", strings.Replace(body, "a10 = 10", "a10 = 99", 1))

	d, err := wt.Diff()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(d, "def retry_after") {
		t.Fatalf("want the method in the hunk header, got:\n%s", d)
	}
}

// We must never read, write, or otherwise disturb the repository's own
// attributes file. Users keep real configuration there.
func TestDiffLeavesUserAttributesFileAlone(t *testing.T) {
	repo := newRepo(t)
	attrs := filepath.Join(repo, ".git", "info", "attributes")
	if err := os.MkdirAll(filepath.Dir(attrs), 0o755); err != nil {
		t.Fatal(err)
	}
	const userContent = "*.custom diff=mine\n*.secret filter=crypt\n"
	if err := os.WriteFile(attrs, []byte(userContent), 0o644); err != nil {
		t.Fatal(err)
	}

	wt, err := CreateWorktree(repo, "s1")
	if err != nil {
		t.Fatal(err)
	}
	write(t, wt.Path, "a.txt", "one\ntwo\n")
	for i := 0; i < 3; i++ {
		if _, err := wt.Diff(); err != nil {
			t.Fatal(err)
		}
	}

	got, err := os.ReadFile(attrs)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != userContent {
		t.Fatalf("ctui modified the user's attributes file.\nwant %q\ngot  %q", userContent, got)
	}
}

// A file whose final line is blank produces a trailing whitespace-only
// context line in git's diff output. The plain, trimming git() helper
// would strip it, leaving the @@ header's declared counts describing more
// lines than the body actually has — corrupt input for `git apply`. Diff()
// must use the untrimmed gitRaw instead.
func TestDiffPreservesTrailingBlankContextLine(t *testing.T) {
	repo := newRepo(t)
	write(t, repo, "f.txt", "l1\nl2\nl3\nl4\nl5\n\n")
	if _, err := git(repo, "add", "-A"); err != nil {
		t.Fatal(err)
	}
	if _, err := git(repo, "commit", "-qm", "add f.txt"); err != nil {
		t.Fatal(err)
	}

	wt, err := CreateWorktree(repo, "s1")
	if err != nil {
		t.Fatal(err)
	}
	write(t, wt.Path, "f.txt", "l1\nl2\nl3\nl4\nCHANGED\n\n")

	raw, err := wt.Diff()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, "\n \n") {
		t.Fatalf("trailing blank context line missing from diff:\n%q", raw)
	}

	files := SplitDiff(raw)
	if len(files) != 1 || len(files[0].Hunks) == 0 {
		t.Fatalf("expected one file with a hunk, got %+v", files)
	}
	h := files[0].Hunks[len(files[0].Hunks)-1]
	m := hunkRe.FindStringSubmatch(strings.TrimSuffix(h.Header, "\n"))
	if m == nil {
		t.Fatalf("hunk header did not parse: %q", h.Header)
	}
	wantOld, wantNew := countOr1(m[2]), countOr1(m[4])

	gotOld, gotNew := 0, 0
	for _, line := range strings.Split(strings.TrimSuffix(h.Body, "\n"), "\n") {
		switch {
		case strings.HasPrefix(line, "-"):
			gotOld++
		case strings.HasPrefix(line, "+"):
			gotNew++
		case strings.HasPrefix(line, `\`):
			// no-newline marker; not a counted line
		default:
			gotOld++
			gotNew++
		}
	}
	if gotOld != wantOld || gotNew != wantNew {
		t.Fatalf("hunk declares -%d +%d lines but body has %d old, %d new\nheader: %q\nbody: %q",
			wantOld, wantNew, gotOld, gotNew, h.Header, h.Body)
	}
}
