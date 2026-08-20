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
