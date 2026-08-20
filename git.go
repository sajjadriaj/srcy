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
// is what makes it work at all. Languages with no builtin driver simply
// produce empty hunk headers and degrade to "no symbol detected".
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
	if err := w.writeAttributes(); err != nil {
		return "", err
	}
	if _, err := git(w.Path, "add", "-A"); err != nil {
		return "", err
	}
	return git(w.Path, "diff", "--cached", w.Base)
}

func (w *Worktree) writeAttributes() error {
	// --git-common-dir, not --git-dir: info/ is shared across worktrees, and
	// a per-worktree attributes file would simply not be read.
	gitDir, err := git(w.Path, "rev-parse", "--git-common-dir")
	if err != nil {
		return err
	}
	if !filepath.IsAbs(gitDir) {
		gitDir = filepath.Join(w.Path, gitDir)
	}
	path := filepath.Join(gitDir, "info", "attributes")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}

	// Read existing content to preserve user's settings.
	existing, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		return err
	}

	// Remove well-formed ctui blocks, preserving user content and orphaned markers.
	// Scan for blocks: if a close marker exists and no other open marker appears
	// before it, the block is well-formed and removed. Otherwise, the open marker
	// is orphaned and preserved as user content.
	var result strings.Builder
	content := string(existing)
	pos := 0

	for {
		// Find next open marker from current position.
		start := strings.Index(content[pos:], "# >>> ctui")
		if start == -1 {
			// No more markers; write the rest and done.
			result.WriteString(content[pos:])
			break
		}
		start += pos // convert to absolute index

		// From just after the open marker, find the next close and next open.
		searchStart := start + len("# >>> ctui")
		closeIdx := strings.Index(content[searchStart:], "# <<< ctui")
		nextOpenIdx := strings.Index(content[searchStart:], "# >>> ctui")

		// Well-formed block: close exists and no other open marker before it.
		if closeIdx != -1 && (nextOpenIdx == -1 || closeIdx < nextOpenIdx) {
			// Convert relative index to absolute.
			endIdx := searchStart + closeIdx + len("# <<< ctui")
			// Include trailing newline if present.
			if endIdx < len(content) && content[endIdx] == '\n' {
				endIdx++
			}
			// Write content before this block, skip the block.
			result.WriteString(content[pos:start])
			pos = endIdx
		} else {
			// Orphaned marker: preserve it as user content, continue after the marker.
			result.WriteString(content[pos : start+len("# >>> ctui")])
			pos = start + len("# >>> ctui")
		}
	}

	content = result.String()

	// Ensure trailing newline before appending new block.
	if len(content) > 0 && !strings.HasSuffix(content, "\n") {
		content += "\n"
	}

	// Append new ctui block with markers.
	newBlock := "# >>> ctui\n" + diffAttributes + "# <<< ctui\n"
	content += newBlock

	return os.WriteFile(path, []byte(content), 0o644)
}
