package main

import (
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
		t.Fatalf("hunk header lost its function name — the attributes file is not where git reads it:\n%s", d)
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

func TestDiffPreservesUserAttributesFile(t *testing.T) {
	repo := newRepo(t)
	wt, err := CreateWorktree(repo, "s1")
	if err != nil {
		t.Fatal(err)
	}

	// Pre-write a custom attributes file with user rules.
	gitCommonDir, err := git(repo, "rev-parse", "--git-common-dir")
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(gitCommonDir) {
		gitCommonDir = filepath.Join(repo, gitCommonDir)
	}
	attrsPath := filepath.Join(gitCommonDir, "info", "attributes")
	if err := os.MkdirAll(filepath.Dir(attrsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	userContent := "*.custom diff=mine\n"
	if err := os.WriteFile(attrsPath, []byte(userContent), 0o644); err != nil {
		t.Fatal(err)
	}

	// Call Diff() twice.
	if _, err := wt.Diff(); err != nil {
		t.Fatal(err)
	}
	if _, err := wt.Diff(); err != nil {
		t.Fatal(err)
	}

	// Verify custom rule is still there exactly once.
	content, err := os.ReadFile(attrsPath)
	if err != nil {
		t.Fatal(err)
	}
	contentStr := string(content)
	if !strings.Contains(contentStr, "*.custom diff=mine") {
		t.Fatal("user's custom attributes rule was lost")
	}
	if strings.Count(contentStr, "*.custom diff=mine") != 1 {
		t.Fatalf("custom rule appears multiple times:\n%s", contentStr)
	}

	// Verify exactly one ctui block (markers should not accumulate).
	if strings.Count(contentStr, "# >>> ctui") != 1 {
		t.Fatalf("ctui marker appears %d times, want 1:\n%s", strings.Count(contentStr, "# >>> ctui"), contentStr)
	}
}

func TestDiffHandlesOrphanedOpenMarker(t *testing.T) {
	repo := newRepo(t)
	wt, err := CreateWorktree(repo, "s1")
	if err != nil {
		t.Fatal(err)
	}

	// Pre-write attributes with orphaned open marker and user content.
	gitCommonDir, err := git(repo, "rev-parse", "--git-common-dir")
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(gitCommonDir) {
		gitCommonDir = filepath.Join(repo, gitCommonDir)
	}
	attrsPath := filepath.Join(gitCommonDir, "info", "attributes")
	if err := os.MkdirAll(filepath.Dir(attrsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(attrsPath, []byte("# >>> ctui\nmy custom line\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Call Diff() twice.
	if _, err := wt.Diff(); err != nil {
		t.Fatal(err)
	}
	if _, err := wt.Diff(); err != nil {
		t.Fatal(err)
	}

	// Verify custom line is still present.
	content, err := os.ReadFile(attrsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(content), "my custom line") {
		t.Fatalf("orphaned marker caused loss of user content:\n%s", content)
	}
}

func TestDiffRemovesMultipleCtUIBlocks(t *testing.T) {
	repo := newRepo(t)
	wt, err := CreateWorktree(repo, "s1")
	if err != nil {
		t.Fatal(err)
	}

	// Pre-write attributes with two ctui blocks and a user line between them.
	gitCommonDir, err := git(repo, "rev-parse", "--git-common-dir")
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(gitCommonDir) {
		gitCommonDir = filepath.Join(repo, gitCommonDir)
	}
	attrsPath := filepath.Join(gitCommonDir, "info", "attributes")
	if err := os.MkdirAll(filepath.Dir(attrsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	doubleBlock := "# >>> ctui\n*.old diff=golang\n# <<< ctui\nmy user line\n# >>> ctui\n*.older diff=python\n# <<< ctui\n"
	if err := os.WriteFile(attrsPath, []byte(doubleBlock), 0o644); err != nil {
		t.Fatal(err)
	}

	// Call Diff() to rewrite blocks.
	if _, err := wt.Diff(); err != nil {
		t.Fatal(err)
	}

	// Verify both old blocks are gone, user line survives, exactly one ctui block remains.
	content, err := os.ReadFile(attrsPath)
	if err != nil {
		t.Fatal(err)
	}
	contentStr := string(content)
	if strings.Contains(contentStr, "*.old") || strings.Contains(contentStr, "*.older") {
		t.Fatalf("old ctui blocks not removed:\n%s", contentStr)
	}
	if !strings.Contains(contentStr, "my user line") {
		t.Fatalf("user line between blocks was lost:\n%s", contentStr)
	}
	if strings.Count(contentStr, "# >>> ctui") != 1 {
		t.Fatalf("expected 1 ctui block, got %d:\n%s", strings.Count(contentStr, "# >>> ctui"), contentStr)
	}
}

func TestDiffPreservesOrphanedCloseMarker(t *testing.T) {
	repo := newRepo(t)
	wt, err := CreateWorktree(repo, "s1")
	if err != nil {
		t.Fatal(err)
	}

	// Pre-write attributes with orphaned close marker (user typed/copy-pasted).
	gitCommonDir, err := git(repo, "rev-parse", "--git-common-dir")
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(gitCommonDir) {
		gitCommonDir = filepath.Join(repo, gitCommonDir)
	}
	attrsPath := filepath.Join(gitCommonDir, "info", "attributes")
	if err := os.MkdirAll(filepath.Dir(attrsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(attrsPath, []byte("some custom config\n# <<< ctui\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Call Diff() to add ctui block.
	if _, err := wt.Diff(); err != nil {
		t.Fatal(err)
	}

	// Verify orphaned close marker is still present.
	content, err := os.ReadFile(attrsPath)
	if err != nil {
		t.Fatal(err)
	}
	contentStr := string(content)
	if !strings.Contains(contentStr, "# <<< ctui") {
		t.Fatalf("orphaned close marker was removed:\n%s", contentStr)
	}
	if !strings.Contains(contentStr, "some custom config") {
		t.Fatalf("custom config was lost:\n%s", contentStr)
	}
}
