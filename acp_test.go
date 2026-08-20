package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func dialFake(t *testing.T) *Client {
	t.Helper()
	// Dial sets the child's cwd to the cwd argument (an isolated t.TempDir()
	// here, standing in for a worktree), so the fixture path must be
	// absolute: a relative "testdata/fake-agent.sh" would be resolved
	// against that tempdir, not against this package's directory, and the
	// shell would never find it.
	script, err := filepath.Abs("testdata/fake-agent.sh")
	if err != nil {
		t.Fatal(err)
	}
	c, err := Dial(context.Background(), []string{"sh", script}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func TestNewSessionReturnsID(t *testing.T) {
	c := dialFake(t)
	id, err := c.NewSession(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if id != "sess-1" {
		t.Fatalf("session id = %q", id)
	}
}

func TestPromptStreamsUpdatesAndUnblocksOnPermission(t *testing.T) {
	c := dialFake(t)
	id, err := c.NewSession(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() {
		_, err := c.Prompt(id, "do the thing")
		done <- err
	}()

	var text strings.Builder
	var sawTool bool
	var perm PermissionReq
	deadline := time.After(5 * time.Second)

collect:
	for {
		select {
		case u := <-c.Updates:
			switch u.Kind {
			case "agent_message_chunk":
				text.WriteString(u.Text)
			case "tool_call":
				sawTool = true
				if u.ToolPath != "a.txt" {
					t.Errorf("tool path = %q, want a.txt", u.ToolPath)
				}
			}
		case perm = <-c.Perms:
			break collect
		case <-deadline:
			t.Fatal("timed out before the permission request arrived")
		}
	}
	// The fake agent writes every update before it writes the permission
	// request, so by the time that request reaches c.Perms, everything
	// preceding it is already sitting in c.Updates's buffer. But Go's
	// select does not preserve arrival order across two different
	// channels: once both have buffered data, select picks pseudo-randomly
	// between them, so the loop above can reach the permission case before
	// draining every update. Drain whatever is already buffered before
	// asserting on it.
drain:
	for {
		select {
		case u := <-c.Updates:
			switch u.Kind {
			case "agent_message_chunk":
				text.WriteString(u.Text)
			case "tool_call":
				sawTool = true
				if u.ToolPath != "a.txt" {
					t.Errorf("tool path = %q, want a.txt", u.ToolPath)
				}
			}
		default:
			break drain
		}
	}

	if text.String() != "hello world" {
		t.Errorf("streamed text = %q", text.String())
	}
	if !sawTool {
		t.Error("tool_call update never arrived")
	}
	if perm.Title != "rm -rf build" {
		t.Errorf("permission title = %q", perm.Title)
	}
	if len(perm.Options) != 2 {
		t.Fatalf("got %d options, want 2", len(perm.Options))
	}

	perm.Reply <- "yes"

	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Prompt did not return after the permission was answered")
	}
}

// A permission request with no title must still be labelled. The user is
// authorizing an action they cannot otherwise see; a blank prompt is asking
// them to approve nothing in particular.
func TestPermissionTitleNeverBlank(t *testing.T) {
	cases := []struct{ title, kind, id, want string }{
		{"rm -rf build", "execute", "t1", "rm -rf build"},
		{"", "execute", "t1", "execute (t1)"},
		{"", "execute", "", "execute"},
		{"", "", "t1", "tool call t1"},
		{"", "", "", "UNIDENTIFIED tool call — the agent sent no description"},
	}
	for _, c := range cases {
		if got := permTitle(c.title, c.kind, c.id); got != c.want {
			t.Errorf("permTitle(%q,%q,%q) = %q, want %q", c.title, c.kind, c.id, got, c.want)
		}
	}
}

// An unknown sessionUpdate kind must not crash the client. The protocol
// gains kinds over time and a tool that dies on one is a tool that breaks
// on every agent upgrade.
func TestUnknownUpdateKindIsIgnored(t *testing.T) {
	c := dialFake(t)
	id, _ := c.NewSession(t.TempDir())
	go func() {
		for p := range c.Perms {
			p.Reply <- "yes"
		}
	}()
	go func() {
		for range c.Updates {
		}
	}()
	if _, err := c.Prompt(id, "go"); err != nil {
		t.Fatalf("an unknown update kind killed the turn: %v", err)
	}
}
