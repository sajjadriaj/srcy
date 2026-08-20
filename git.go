package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// git runs a git command in dir and returns its trimmed stdout.
// On failure the error carries git's stderr verbatim: the user is going to
// debug this with the same command, so they should see what git said.
func git(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %w: %s",
			strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return strings.TrimSpace(stdout.String()), nil
}

// gitRaw is git() without the trimming. Diff output is bytes we hand to
// `git apply` verbatim, and a trailing whitespace-only context line is
// content, not noise: trimming it leaves the @@ counts describing more
// lines than the body contains, which git rejects as a corrupt patch.
func gitRaw(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %w: %s",
			strings.Join(args, " "), err, strings.TrimSpace(stderr.String()))
	}
	return stdout.String(), nil
}

// Worktree is one session's isolated checkout.
type Worktree struct {
	Repo   string // the user's repository
	Path   string // .ctui/wt/<name>
	Branch string // ctui/<name>
	Base   string // repo HEAD at creation; every diff is taken against this
}

// CreateWorktree branches from the repo's current HEAD into .ctui/wt/<name>.
func CreateWorktree(repo, name string) (*Worktree, error) {
	base, err := git(repo, "rev-parse", "HEAD")
	if err != nil {
		return nil, err
	}
	w := &Worktree{
		Repo:   repo,
		Path:   filepath.Join(repo, ".ctui", "wt", name),
		Branch: "ctui/" + name,
		Base:   base,
	}
	if err := excludeCtui(repo); err != nil {
		return nil, err
	}
	if _, err := git(repo, "worktree", "add", "-b", w.Branch, w.Path, w.Base); err != nil {
		return nil, err
	}
	if err := runPostCreate(w); err != nil {
		if destroyErr := w.Destroy(); destroyErr != nil {
			return nil, fmt.Errorf("postcreate failed: %w (also failed to rollback: %v)", err, destroyErr)
		}
		return nil, err
	}
	return w, nil
}

// Destroy removes the worktree and its branch. Force, because the agent
// almost always leaves uncommitted work behind and we are discarding it
// deliberately.
func (w *Worktree) Destroy() error {
	if _, err := git(w.Repo, "worktree", "remove", "--force", w.Path); err != nil {
		return err
	}
	_, err := git(w.Repo, "branch", "-D", w.Branch)
	return err
}

// excludeCtui hides .ctui/ via .git/info/exclude rather than .gitignore:
// this is our bookkeeping, not a fact about the user's project, and it
// should never show up in their diff.
func excludeCtui(repo string) error {
	gitDir, err := git(repo, "rev-parse", "--git-common-dir")
	if err != nil {
		return err
	}
	if !filepath.IsAbs(gitDir) {
		gitDir = filepath.Join(repo, gitDir)
	}
	path := filepath.Join(gitDir, "info", "exclude")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	existing, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, line := range strings.Split(string(existing), "\n") {
		if strings.TrimSpace(line) == ".ctui/" {
			return nil
		}
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	prefix := ""
	if len(existing) > 0 && !strings.HasSuffix(string(existing), "\n") {
		prefix = "\n"
	}
	_, err = f.WriteString(prefix + ".ctui/\n")
	return err
}

// runPostCreate runs .ctui/postcreate if it exists and is executable.
// Fresh worktrees have no node_modules and no build cache; what fixes that
// varies per repo, so it is a script that either exists or doesn't rather
// than a config file with a schema.
func runPostCreate(w *Worktree) error {
	script := filepath.Join(w.Repo, ".ctui", "postcreate")
	info, err := os.Stat(script)
	if err != nil || info.Mode()&0o111 == 0 {
		return nil
	}
	cmd := exec.Command(script)
	cmd.Dir = w.Path
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("postcreate: %w: %s", err, out)
	}
	return nil
}

// diffAttributes enables git's builtin funcname drivers so hunk headers
// carry the enclosing function. Blast radius reads those headers, so this
// is what makes it work at all.
//
// Without a driver git falls back to a generic heuristic that takes the last
// preceding unindented line, which for an indented method reports the
// enclosing class instead of the method — the wrong symbol, silently.
//
// This file is written inside .ctui and passed to git per-invocation via
// -c core.attributesFile. We never write to the repository's own
// .git/info/attributes: users legitimately keep custom diff, merge and
// textconv rules there, and no amount of careful merging into a shared file
// we do not own is worth the risk of eating them. core.attributesFile also
// sits at the lowest precedence, so a rule the user set anywhere still wins
// over ours, which is the correct relationship.
const diffAttributes = `*.go diff=golang
*.py diff=python
*.rs diff=rust
*.rb diff=ruby
*.php diff=php
*.java diff=java
*.kt diff=kotlin
*.cs diff=csharp
*.c diff=cpp
*.h diff=cpp
*.cc diff=cpp
*.cpp diff=cpp
*.m diff=objc
*.pl diff=perl
*.ex diff=elixir
*.exs diff=elixir
*.css diff=css
*.md diff=markdown
`

// Diff returns the worktree's changes against its base commit.
//
// It stages first: agents routinely leave work uncommitted, and a plain
// `git diff` would silently omit every file they created. Staging is
// harmless here because the worktree is disposable.
func (w *Worktree) Diff() (string, error) {
	attrs, err := w.writeAttributes()
	if err != nil {
		return "", err
	}
	if _, err := git(w.Path, "add", "-A"); err != nil {
		return "", err
	}
	// We are producing bytes for `git apply`, so the diff must be literal
	// regardless of how the user has configured *reading* diffs: neutralize
	// diff.mnemonicPrefix (c/i instead of a/b), diff.noprefix (no prefix at
	// all), and core.quotePath (which C-quotes any non-ASCII path — the only
	// path source left for a mode-only or binary section, which carries no
	// "+++"/"rename to" line for the unquote fallback to read instead); and
	// disable any external diff driver or textconv filter that would make
	// the output something other than a real patch. core.quotePath=false
	// still quotes a path containing an actual control character (e.g. a
	// literal tab), so that case stays quoted and goes through the existing
	// unquote branch rather than silently mis-parsing.
	return gitRaw(w.Path,
		"-c", "core.attributesFile="+attrs,
		"-c", "diff.mnemonicPrefix=false",
		"-c", "diff.noprefix=false",
		"-c", "core.quotePath=false",
		"diff", "--cached", "--no-ext-diff", "--no-textconv", w.Base)
}

// writeAttributes drops our driver mappings in .ctui and returns the path,
// for the caller to pass to git as core.attributesFile. It owns this file
// completely, so it can truncate without reading anything first.
func (w *Worktree) writeAttributes() (string, error) {
	path := filepath.Join(w.Repo, ".ctui", "attributes")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(diffAttributes), 0o644); err != nil {
		return "", err
	}
	return path, nil
}
