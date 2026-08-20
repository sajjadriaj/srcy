package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// dialFake dials testdata/fake-agent.sh with the given cwd. Callers that
// also call NewSession must reuse the same cwd: the fixture's absolute
// tool_call locations are built from its own $PWD (which Dial sets to cwd),
// and relPath resolves them against whatever cwd NewSession was given —
// two different t.TempDir() calls would never agree.
func dialFake(t *testing.T, cwd string) *Client {
	t.Helper()
	// Dial sets the child's cwd to the cwd argument, so the fixture path
	// must be absolute: a relative "testdata/fake-agent.sh" would be
	// resolved against that cwd, not against this package's directory, and
	// the shell would never find it.
	script, err := filepath.Abs("testdata/fake-agent.sh")
	if err != nil {
		t.Fatal(err)
	}
	c, err := Dial(context.Background(), []string{"sh", script}, cwd)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func TestNewSessionReturnsID(t *testing.T) {
	cwd := t.TempDir()
	c := dialFake(t, cwd)
	id, err := c.NewSession(cwd)
	if err != nil {
		t.Fatal(err)
	}
	if id != "sess-1" {
		t.Fatalf("session id = %q", id)
	}
}

// wireResp is a JSON-RPC response frame, as logged verbatim by the fixture
// for the two responses the client writes back mid-turn (the rejection of
// an unsupported request, and the permission answer), so the test can
// assert on the actual bytes that went over the wire instead of trusting
// the client's own account of what it sent.
type wireResp struct {
	ID     json.RawMessage `json:"id"`
	Result struct {
		Outcome struct {
			Outcome  string `json:"outcome"`
			OptionID string `json:"optionId"`
		} `json:"outcome"`
	} `json:"result"`
	Error *rpcError `json:"error"`
}

func TestPromptStreamsUpdatesAndUnblocksOnPermission(t *testing.T) {
	wireLog := filepath.Join(t.TempDir(), "wire.log")
	t.Setenv("FAKE_AGENT_WIRE_LOG", wireLog)

	cwd := t.TempDir()
	c := dialFake(t, cwd)
	id, err := c.NewSession(cwd)
	if err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() {
		_, err := c.Prompt(id, "do the thing")
		done <- err
	}()

	var text strings.Builder
	var sawTool, sawBigLine, sawUnknownKind bool
	var ticks int
	var perm PermissionReq
	deadline := time.After(5 * time.Second)

	// Shared by every phase below: the fixture starts streaming "TICK"
	// updates the instant it sends the permission request (see the fixture
	// comment), so a tick can land during the collect loop below, during
	// the explicit wait for one after it, or during the final drain — Go's
	// select gives no ordering guarantee across c.Updates and c.Perms, and
	// none across "sent already" vs. "sent 50ms from now" either. Counting
	// ticks here regardless of which phase observes them, instead of only
	// where they're expected, is what keeps this deterministic rather than
	// occasionally flaky.
	handle := func(u Update) {
		if u.Kind == "agent_message_chunk" && u.Text == "TICK" {
			ticks++
			return
		}
		switch u.Kind {
		case "agent_message_chunk":
			text.WriteString(u.Text)
		case "tool_call":
			sawTool = true
			if u.ToolPath != "a.txt" {
				t.Errorf("tool path = %q, want the repo-relative \"a.txt\" (live locations are absolute)", u.ToolPath)
			}
			if len(u.Text) > 65536 {
				sawBigLine = true
			} else {
				t.Errorf("tool_call text = %d bytes, want > 65536 (content decoded from the live array shape, on a line over 64KB)", len(u.Text))
			}
		case "unknown_future_kind":
			sawUnknownKind = true
		}
	}

collect:
	for {
		select {
		case u := <-c.Updates:
			handle(u)
		case perm = <-c.Perms:
			break collect
		case <-deadline:
			t.Fatal("timed out before the permission request arrived")
		}
	}

	// The fixture keeps streaming updates while this permission sits
	// unanswered. A client that answered inline — blocking the read loop on
	// the reply instead of on a separate goroutine (C1) — would starve
	// these until after the reply lands, instead of delivering them now.
	// If none showed up during collect above, give it a window and require
	// at least one before replying.
	if ticks == 0 {
		tickDeadline := time.After(500 * time.Millisecond)
	waitTicks:
		for {
			select {
			case u := <-c.Updates:
				handle(u)
				if ticks > 0 {
					break waitTicks
				}
			case <-tickDeadline:
				break waitTicks
			}
		}
	}
	if ticks == 0 {
		t.Error("no update arrived while the permission request was outstanding — the read loop may be blocking on the reply instead of answering it from its own goroutine")
	}

	if perm.Title != "tool call t1" {
		t.Errorf("permission title = %q, want the id fallback (live frames carry no title and no kind)", perm.Title)
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

	// Mop up whatever else is still buffered (remaining ticks, a straggling
	// update that lost the select race) now that the turn is over.
drain:
	for {
		select {
		case u := <-c.Updates:
			handle(u)
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
	if !sawBigLine {
		t.Error("the >64KB tool_call line never arrived intact")
	}
	if !sawUnknownKind {
		t.Error("unknown_future_kind update never arrived — the client must not crash or drop it")
	}

	assertWireResponses(t, wireLog)
}

// assertWireResponses checks the raw bytes the fixture logged for the two
// responses the client writes back mid-turn: the rejection of the
// unsupported fs/read_text_file request (I4) and the permission answer,
// which must carry the request's own id, the nested
// {"outcome":{"outcome":"selected","optionId":...}} shape, and the option
// actually chosen (I11's neighbourhood — none of this was asserted before).
func assertWireResponses(t *testing.T, path string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading wire log: %v", err)
	}
	var sawFsReject, sawPermAnswer bool
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		var f wireResp
		if err := json.Unmarshal([]byte(line), &f); err != nil {
			t.Fatalf("wire log line is not valid JSON: %q: %v", line, err)
		}
		switch string(f.ID) {
		case `"fs1"`:
			sawFsReject = true
			if f.Error == nil || f.Error.Code != -32601 {
				t.Errorf("fs/read_text_file response = %+v, want error code -32601", f)
			}
		case `"p1"`:
			sawPermAnswer = true
			if f.Result.Outcome.Outcome != "selected" {
				t.Errorf("permission outcome = %q, want %q", f.Result.Outcome.Outcome, "selected")
			}
			if f.Result.Outcome.OptionID != "yes" {
				t.Errorf("permission optionId = %q, want %q", f.Result.Outcome.OptionID, "yes")
			}
		default:
			t.Errorf("unexpected wire log line: %q", line)
		}
	}
	if !sawFsReject {
		t.Error("client never answered the unsupported fs/read_text_file request (I4)")
	}
	if !sawPermAnswer {
		t.Error("client never answered the permission request")
	}
}

// A permission request with no title must still be labelled, and the label
// must survive whitespace-only and control-character content. The user is
// authorizing an action they cannot otherwise see; a blank prompt is asking
// them to approve nothing in particular, and the agent controls this
// string, so control characters reaching a naive prompt is how a dialog
// gets repainted out from under the user.
func TestPermissionTitleNeverBlank(t *testing.T) {
	cases := []struct{ title, kind, id, want string }{
		{"rm -rf build", "execute", "t1", "rm -rf build"},
		{"", "execute", "t1", "execute (t1)"},
		{"", "execute", "", "execute"},
		{"", "", "t1", "tool call t1"},
		{"", "", "", "UNIDENTIFIED tool call — the agent sent no description"},
		{"   \t\n", "execute", "t1", "execute (t1)"},
		// Pure control bytes, nothing printable left after stripping: falls
		// back like any other blank title.
		{"\x1b\x07\r", "execute", "t1", "execute (t1)"},
		// Control bytes stripped from around real content, not mistaken for
		// reason to discard the content too: the ESC and CR are gone, but
		// "[2K" is plain printable text once its ESC is gone, not a live
		// escape sequence, so it's kept.
		{"rm -rf build\x1b[2K\r", "execute", "t1", "rm -rf build[2K"},
	}
	for _, c := range cases {
		if got := permTitle(c.title, c.kind, c.id); got != c.want {
			t.Errorf("permTitle(%q,%q,%q) = %q, want %q", c.title, c.kind, c.id, got, c.want)
		}
	}
}

// N1: the live adapter refuses to start at all if CLAUDECODE or
// CLAUDE_CODE_SSE_PORT are set in its environment — the situation ctui runs
// in every time it's launched from inside a Claude Code terminal. Dial must
// scrub both before the child ever sees them.
func TestDialScrubsClaudeCodeEnvVars(t *testing.T) {
	t.Setenv("CLAUDECODE", "1")
	t.Setenv("CLAUDE_CODE_SSE_PORT", "12345")
	cwd := t.TempDir()
	c := dialFake(t, cwd)
	if _, err := c.NewSession(cwd); err != nil {
		t.Fatal(err)
	}
}

// C1: the read loop must never block on a full or undrained Updates
// channel. 200 streamed chunks is one sentence, so a bounded, synchronous
// send from inside the read loop would deadlock on the first permission
// request behind a backlog that size — nobody would ever read it off the
// wire, so no modal would appear, so nobody would drain the backlog, so it
// would never unblock. This test never reads c.Updates before checking that
// the permission still arrives, on purpose.
func TestFloodOfUpdatesDoesNotBlockPermission(t *testing.T) {
	t.Setenv("FAKE_AGENT_FLOOD", "1")
	cwd := t.TempDir()
	c := dialFake(t, cwd)
	id, err := c.NewSession(cwd)
	if err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() {
		_, err := c.Prompt(id, "flood")
		done <- err
	}()

	select {
	case perm := <-c.Perms:
		perm.Reply <- "yes"
	case <-time.After(3 * time.Second):
		t.Fatal("permission request never arrived — the read loop is blocked on a full Updates channel")
	}

	// Only start draining now, so the 300 queued updates have to survive a
	// consumer that wasn't there when they arrived.
	go func() {
		for range c.Updates {
		}
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Prompt did not return")
	}
}

// C2 / I7 / I8: an agent that exits mid-turn on its own (not via Close)
// must unblock the pending Prompt call with a real error, not hang, and a
// subsequent Close (from the caller, racing readLoop's own shutdown) must
// be idempotent and must not surface a spurious error.
func TestAgentExitingMidTurnUnblocksPromptAndClose(t *testing.T) {
	t.Setenv("FAKE_AGENT_DIE_MIDTURN", "1")
	cwd := t.TempDir()
	c := dialFake(t, cwd)
	id, err := c.NewSession(cwd)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for range c.Updates {
		}
	}()
	go func() {
		for p := range c.Perms {
			p.Reply <- "yes"
		}
	}()

	done := make(chan error, 1)
	go func() {
		_, err := c.Prompt(id, "die now")
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected an error when the agent exits mid-turn")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Prompt hung after the agent exited mid-turn")
	}

	if err := c.Close(); err != nil {
		t.Fatalf("Close() = %v, want nil (a clean exit(0) has nothing to swallow, and nothing else failed)", err)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("second Close() = %v, want nil (result must be memoized, not a spurious \"Wait was already called\")", err)
	}
}

// I6: call() must be unblocked by ctx cancellation. This end-to-end version
// exercises the realistic path (Dial ties the child process to ctx too, via
// exec.CommandContext), but note that alone doesn't isolate call()'s own
// direct `case <-c.ctx.Done()` — killing the process also closes c.closed,
// which unblocks call() on its own. TestCallCtxDoneUnblocksWithoutClosed
// below is what actually proves that specific line matters.
func TestCallReturnsWhenContextCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	t.Setenv("FAKE_AGENT_SILENT_PROMPT", "1")
	script, err := filepath.Abs("testdata/fake-agent.sh")
	if err != nil {
		t.Fatal(err)
	}
	cwd := t.TempDir()
	c, err := Dial(ctx, []string{"sh", script}, cwd)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	id, err := c.NewSession(cwd)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for range c.Updates {
		}
	}()
	go func() {
		for p := range c.Perms {
			p.Reply <- "yes"
		}
	}()

	done := make(chan error, 1)
	go func() {
		_, err := c.Prompt(id, "hang please")
		done <- err
	}()

	time.Sleep(50 * time.Millisecond) // let the call actually land and block
	cancel()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected an error after ctx was cancelled")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Prompt did not return after ctx was cancelled")
	}
}

// I6, isolated: call() must return when ctx is cancelled even if nothing
// else ever would — no response is coming, and closed is never closed. This
// is the only way to prove the direct `case <-c.ctx.Done()` matters:
// through Dial, killing the process on cancellation also closes closed,
// which would unblock call() on its own regardless of whether ctx is
// checked directly. Constructing the Client by hand instead of via Dial
// removes that fallback.
func TestCallCtxDoneUnblocksWithoutClosed(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	c := &Client{
		ctx:     ctx,
		out:     json.NewEncoder(io.Discard),
		pending: map[int]chan rpcResponse{},
		closed:  make(chan struct{}), // deliberately never closed
	}

	done := make(chan error, 1)
	go func() {
		_, err := c.call("whatever", map[string]any{})
		done <- err
	}()

	time.Sleep(20 * time.Millisecond) // let call() register and block
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("call() error = %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("call() did not return after ctx was cancelled, and closed was never closed")
	}
}

// I7: Close() must swallow the *exec.ExitError produced by killing our own,
// still-running agent — an expected side effect of shutting down, not a
// failure every caller needs to see. The fixture's main loop never exits on
// its own, so this always requires an actual Kill+Wait, unlike the
// mid-turn-exit test above (which never even reaches this logic, since a
// clean exit(0) has no ExitError to swallow).
func TestCloseOnAStillRunningAgentReturnsNilError(t *testing.T) {
	cwd := t.TempDir()
	c := dialFake(t, cwd)
	if _, err := c.NewSession(cwd); err != nil {
		t.Fatal(err)
	}
	if err := c.Close(); err != nil {
		t.Fatalf("Close() on a live agent = %v, want nil (the SIGKILL exit must be swallowed)", err)
	}
}

// I8: a genuine scanner error — here, a line over the 8MB buffer cap — must
// surface distinctly from a clean EOF, not blur into the same generic
// io.ErrUnexpectedEOF that Close() would also produce.
func TestScannerErrorSurfacesDistinctlyFromCleanEOF(t *testing.T) {
	t.Setenv("FAKE_AGENT_HUGE_LINE", "1")
	cwd := t.TempDir()
	c := dialFake(t, cwd)
	id, err := c.NewSession(cwd)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for range c.Updates {
		}
	}()
	go func() {
		for p := range c.Perms {
			p.Reply <- "yes"
		}
	}()

	_, err = c.Prompt(id, "huge")
	if err == nil {
		t.Fatal("expected an error for a line over the scanner's buffer cap")
	}
	if !errors.Is(err, bufio.ErrTooLong) {
		t.Errorf("Prompt error = %v, want it to wrap bufio.ErrTooLong (the real scanner failure), not a generic EOF", err)
	}
}

// The documented "closing Reply without a send cancels" contract — what
// main.go's I9 guard relies on for an agent that offers zero permission
// options, and previously dead code in this suite (every other test always
// sends an explicit reply).
func TestClosingReplyCancelsThePermission(t *testing.T) {
	wireLog := filepath.Join(t.TempDir(), "wire.log")
	t.Setenv("FAKE_AGENT_WIRE_LOG", wireLog)
	t.Setenv("FAKE_AGENT_SIMPLE_PERM", "1")
	cwd := t.TempDir()
	c := dialFake(t, cwd)
	id, err := c.NewSession(cwd)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for range c.Updates {
		}
	}()

	done := make(chan error, 1)
	go func() {
		_, err := c.Prompt(id, "cancel me")
		done <- err
	}()

	perm := <-c.Perms
	close(perm.Reply) // cancel, instead of answering

	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Prompt did not return after the permission was cancelled")
	}

	data, err := os.ReadFile(wireLog)
	if err != nil {
		t.Fatal(err)
	}
	var f wireResp
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(data))), &f); err != nil {
		t.Fatalf("wire log line is not valid JSON: %s: %v", data, err)
	}
	if f.Result.Outcome.Outcome != "cancelled" {
		t.Errorf("outcome = %q, want %q", f.Result.Outcome.Outcome, "cancelled")
	}
	if f.Result.Outcome.OptionID != "" {
		t.Errorf("optionId = %q, want empty for a cancelled outcome", f.Result.Outcome.OptionID)
	}
}
