package main

import (
	"bytes"
	"fmt"
	"os/exec"
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
