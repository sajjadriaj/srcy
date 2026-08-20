package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
)

// Update is one session/update notification, flattened to what the UI needs.
type Update struct {
	Kind     string // sessionUpdate, e.g. agent_message_chunk, tool_call, plan
	Text     string // for message and thought chunks, and tool call content
	Title    string // for tool calls
	ToolPath string // first location of a tool call, repo-relative when possible; blast radius uses these
	Raw      json.RawMessage
}

type PermOption struct {
	ID   string `json:"optionId"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}

// PermissionReq is a blocked agent. Sending an option ID on Reply unblocks
// it; closing Reply without a send cancels.
type PermissionReq struct {
	Title   string
	Options []PermOption
	Reply   chan string
}

type Client struct {
	// Updates is fed by an internal, unbounded relay (queueUpdate /
	// forwardUpdates), not written to directly by the read loop. That is
	// what lets a slow or absent consumer never stall frame parsing — in
	// particular, it can never leave a queued session/request_permission
	// stuck unread behind a backlog of updates nobody has drained yet.
	Updates chan Update
	Perms   chan PermissionReq

	ctx  context.Context
	cmd  *exec.Cmd
	out  *json.Encoder
	in   *bufio.Scanner
	mu   sync.Mutex
	next int
	// pending maps an outgoing request id to the channel its response lands on.
	pending map[int]chan rpcResponse
	writeMu sync.Mutex
	closed  chan struct{}

	// cwd is the active session's working directory, guarded by mu, used to
	// make tool_call locations repo-relative.
	cwd string

	// scanErr is the read loop's bufio.Scanner error (nil on a clean EOF),
	// guarded by mu and set before closed is closed, so a goroutine
	// unblocked by closed can tell a real read failure from a normal
	// shutdown instead of always reporting a bare EOF.
	scanErr error

	// closeOnce makes Close idempotent and safe to call from both a caller
	// and the read loop's own shutdown without racing on c.closed or
	// double-`Wait`ing the process.
	closeOnce sync.Once
	closeErr  error

	updMu  sync.Mutex
	updBuf []Update
	updSig chan struct{}
}

type rpcResponse struct {
	Result json.RawMessage
	Err    error
}

type rpcFrame struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Dial starts the agent process and completes the ACP handshake.
func Dial(ctx context.Context, argv []string, cwd string) (*Client, error) {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = cwd
	// claude-code-acp refuses to start if it thinks it is being launched
	// from inside another Claude Code session — exactly the environment
	// ctui itself runs in.
	cmd.Env = filterEnv(os.Environ(), "CLAUDECODE", "CLAUDE_CODE_SSE_PORT")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	c := &Client{
		Updates: make(chan Update, 128),
		Perms:   make(chan PermissionReq, 8),
		ctx:     ctx,
		cmd:     cmd,
		cwd:     cwd,
		out:     json.NewEncoder(stdin),
		in:      bufio.NewScanner(stdout),
		pending: map[int]chan rpcResponse{},
		closed:  make(chan struct{}),
		updSig:  make(chan struct{}, 1),
	}
	// Agent output is line-delimited JSON, and a long tool result is a long
	// line. The default 64K scanner limit would truncate it into a parse error.
	c.in.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	go c.readLoop()
	go c.forwardUpdates()

	if _, err := c.call("initialize", map[string]any{
		"protocolVersion": 1,
		"clientCapabilities": map[string]any{
			"fs": map[string]any{"readTextFile": false, "writeTextFile": false},
		},
	}); err != nil {
		c.Close() // reaps the process and closes both pipe fds; see Close
		return nil, fmt.Errorf("initialize: %w", err)
	}
	return c, nil
}

// filterEnv drops the named vars from env.
func filterEnv(env []string, drop ...string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		key, _, _ := strings.Cut(kv, "=")
		skip := false
		for _, d := range drop {
			if key == d {
				skip = true
				break
			}
		}
		if !skip {
			out = append(out, kv)
		}
	}
	return out
}

func (c *Client) NewSession(cwd string) (string, error) {
	res, err := c.call("session/new", map[string]any{
		"cwd":        cwd,
		"mcpServers": []any{},
	})
	if err != nil {
		return "", err
	}
	c.mu.Lock()
	c.cwd = cwd
	c.mu.Unlock()
	var out struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(res, &out); err != nil {
		return "", err
	}
	return out.SessionID, nil
}

// Prompt sends a turn and blocks until the agent finishes it. Updates and
// permission requests arrive on the channels while it is in flight, so it
// must be called from its own goroutine.
func (c *Client) Prompt(sessionID, text string) (string, error) {
	res, err := c.call("session/prompt", map[string]any{
		"sessionId": sessionID,
		"prompt":    []any{map[string]any{"type": "text", "text": text}},
	})
	if err != nil {
		return "", err
	}
	var out struct {
		StopReason string `json:"stopReason"`
	}
	json.Unmarshal(res, &out)
	return out.StopReason, nil
}

func (c *Client) Cancel(sessionID string) error {
	return c.notify("session/cancel", map[string]any{"sessionId": sessionID})
}

// Close is idempotent: repeated calls, and a call racing the read loop's own
// shutdown when the agent dies on its own, all collapse into a single
// close(closed) + Kill + Wait, and every caller sees the same memoized
// result. Wait's *exec.ExitError from killing our own (still-running) child
// is expected, not a failure, and is swallowed; any other exit still
// surfaces.
func (c *Client) Close() error {
	c.closeOnce.Do(func() {
		close(c.closed)
		if c.cmd.Process != nil {
			c.cmd.Process.Kill()
		}
		c.closeErr = ignoreOwnKill(c.cmd.Wait())
	})
	return c.closeErr
}

// ignoreOwnKill swallows the *exec.ExitError produced by killing our own
// child process — an expected side effect of Close, not a failure the
// caller needs to see. A nonzero exit the agent chose itself still surfaces.
func ignoreOwnKill(err error) error {
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if ws, ok := exitErr.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			return nil
		}
	}
	return err
}

func (c *Client) call(method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	c.next++
	id := c.next
	ch := make(chan rpcResponse, 1)
	c.pending[id] = ch
	c.mu.Unlock()

	if err := c.write(rpcFrame{
		JSONRPC: "2.0",
		ID:      json.RawMessage(fmt.Sprint(id)),
		Method:  method,
		Params:  mustJSON(params),
	}); err != nil {
		return nil, err
	}
	select {
	case r := <-ch:
		return r.Result, r.Err
	case <-c.closed:
		c.mu.Lock()
		err := c.scanErr
		c.mu.Unlock()
		if err != nil {
			return nil, err
		}
		return nil, io.ErrUnexpectedEOF
	case <-c.ctx.Done():
		return nil, c.ctx.Err()
	}
}

func (c *Client) notify(method string, params any) error {
	return c.write(rpcFrame{JSONRPC: "2.0", Method: method, Params: mustJSON(params)})
}

func (c *Client) write(f rpcFrame) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.out.Encode(f)
}

// readLoop is the only reader of the agent's stdout. It routes four shapes:
// a response (id, no method), a permission request, a session/update
// notification, and any other incoming request (id and method) — which
// JSON-RPC requires an answer to, even one we don't implement, or the agent
// stays blocked on it forever.
//
// Nothing here may block on a human. handleUpdate hands off to an unbounded
// internal queue instead of sending on Updates directly (see queueUpdate),
// and handlePermission answers on its own goroutine instead of waiting for
// the reply inline — both so that a slow UI, or a permission still awaiting
// a click, can never stall the parsing of the agent's own output.
func (c *Client) readLoop() {
	defer func() {
		if err := c.in.Err(); err != nil {
			c.mu.Lock()
			c.scanErr = err
			c.mu.Unlock()
		}
		c.Close()
		close(c.Perms)
	}()

	for c.in.Scan() {
		var f rpcFrame
		if err := json.Unmarshal(c.in.Bytes(), &f); err != nil {
			continue // a line we cannot parse is not worth dying over
		}
		switch {
		case f.Method == "" && len(f.ID) > 0:
			c.deliver(f)
		case f.Method == "session/request_permission":
			c.handlePermission(f)
		case f.Method == "session/update":
			c.handleUpdate(f)
		case f.Method != "" && len(f.ID) > 0:
			// An incoming request for a method we don't implement (e.g.
			// fs/read_text_file, a future terminal/*). Answered inline,
			// synchronously, since it is not something a human needs to
			// weigh in on — unlike a permission request, there is nothing
			// here worth spawning a goroutine to wait for.
			if err := c.write(rpcFrame{
				JSONRPC: "2.0",
				ID:      f.ID,
				Error:   &rpcError{Code: -32601, Message: "method not supported"},
			}); err != nil {
				log.Printf("acp: failed to reject unsupported request %s: %v", f.Method, err)
			}
		}
	}
}

func (c *Client) deliver(f rpcFrame) {
	var id int
	if err := json.Unmarshal(f.ID, &id); err != nil {
		return
	}
	c.mu.Lock()
	ch := c.pending[id]
	delete(c.pending, id)
	c.mu.Unlock()
	if ch == nil {
		return
	}
	if f.Error != nil {
		ch <- rpcResponse{Err: fmt.Errorf("agent error %d: %s", f.Error.Code, f.Error.Message)}
		return
	}
	ch <- rpcResponse{Result: f.Result}
}

func (c *Client) handleUpdate(f rpcFrame) {
	var p struct {
		Update struct {
			SessionUpdate string          `json:"sessionUpdate"`
			Content       json.RawMessage `json:"content"`
			Title         string          `json:"title"`
			Locations     []struct {
				Path string `json:"path"`
			} `json:"locations"`
		} `json:"update"`
	}
	if err := json.Unmarshal(f.Params, &p); err != nil {
		var syn *json.SyntaxError
		if errors.As(err, &syn) {
			return // the JSON itself is unparseable; nothing here can be trusted
		}
		// Any other error (an UnmarshalTypeError on some field we don't
		// model correctly yet) still leaves everything else Go managed to
		// populate usable — content in particular arrives as an object for
		// message/thought chunks and as an array for tool calls, and
		// extractText below tolerates both, so this is a safety net for
		// whatever comes next, not a shrug at what we already know about.
	}
	u := Update{
		Kind:  p.Update.SessionUpdate,
		Text:  extractText(p.Update.Content),
		Title: p.Update.Title,
		Raw:   f.Params,
	}
	if len(p.Update.Locations) > 0 {
		u.ToolPath = c.relPath(p.Update.Locations[0].Path)
	}
	// Unrecognized Kind values still get queued: the UI ignores what it
	// does not recognize, and the protocol gains kinds over time.
	c.queueUpdate(u)
}

// extractText pulls the streamed text out of a session/update's content,
// which the live adapter sends as an object for message/thought chunks
// ({"type":"text","text":"..."}) and as an array of content blocks for tool
// calls ([{"type":"content","content":{"type":"text","text":"..."}}, ...]).
func extractText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var obj struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &obj) == nil && obj.Text != "" {
		return obj.Text
	}
	var blocks []struct {
		Text    string `json:"text"`
		Content struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(raw, &blocks) == nil {
		var sb strings.Builder
		for _, b := range blocks {
			switch {
			case b.Text != "":
				sb.WriteString(b.Text)
			case b.Content.Text != "":
				sb.WriteString(b.Content.Text)
			}
		}
		return sb.String()
	}
	return ""
}

// relPath makes an absolute tool-call location repo-relative against the
// session's cwd: blast radius (Task 11) compares these against `git grep
// -l` output, which is always repo-relative, so a live adapter's absolute
// paths would otherwise never match. Paths outside cwd, or a path handed to
// us before any session's cwd is known, are left as-is — there is no sane
// relative form for those.
func (c *Client) relPath(path string) string {
	if !filepath.IsAbs(path) {
		return path
	}
	c.mu.Lock()
	cwd := c.cwd
	c.mu.Unlock()
	if cwd == "" {
		return path
	}
	rel, err := filepath.Rel(cwd, path)
	if err != nil || strings.HasPrefix(rel, "..") {
		return path
	}
	return rel
}

// queueUpdate hands u to the unbounded relay in front of Updates instead of
// sending directly, so the read loop never blocks on a slow or absent
// consumer. See forwardUpdates.
func (c *Client) queueUpdate(u Update) {
	c.updMu.Lock()
	c.updBuf = append(c.updBuf, u)
	c.updMu.Unlock()
	select {
	case c.updSig <- struct{}{}:
	default:
	}
}

// forwardUpdates is the only goroutine that sends on Updates, and the only
// one allowed to block on a slow consumer. queueUpdate only ever appends to
// an in-memory slice, so a full or undrained Updates channel can never
// stall readLoop — and, critically, can never leave a queued
// session/request_permission stuck unread behind a backlog of updates
// nobody has drained yet (200 streamed chunks is one sentence; the old
// bounded, synchronous send deadlocked on the first permission of a real
// turn).
func (c *Client) forwardUpdates() {
	defer close(c.Updates)
	for {
		c.updMu.Lock()
		if len(c.updBuf) == 0 {
			c.updMu.Unlock()
			select {
			case <-c.updSig:
				continue
			case <-c.closed:
				return
			}
		}
		u := c.updBuf[0]
		c.updBuf = c.updBuf[1:]
		c.updMu.Unlock()
		select {
		case c.Updates <- u:
		case <-c.closed:
			return
		}
	}
}

func (c *Client) handlePermission(f rpcFrame) {
	// The toolCall here is an ACP ToolCallUpdate, in which only toolCallId is
	// required — title, kind and locations are all optional.
	var p struct {
		ToolCall struct {
			Title      string `json:"title"`
			Kind       string `json:"kind"`
			ToolCallID string `json:"toolCallId"`
		} `json:"toolCall"`
		Options []PermOption `json:"options"`
	}
	json.Unmarshal(f.Params, &p)

	req := PermissionReq{
		Title:   permTitle(p.ToolCall.Title, p.ToolCall.Kind, p.ToolCall.ToolCallID),
		Options: p.Options,
		Reply:   make(chan string, 1),
	}
	select {
	case c.Perms <- req:
	case <-c.closed:
		return
	}

	// Answer on a goroutine: the read loop must not block, or the agent's
	// own output would stall behind the human.
	go func() {
		outcome := map[string]any{"outcome": "cancelled"}
		select {
		case id, ok := <-req.Reply:
			if ok {
				outcome = map[string]any{"outcome": "selected", "optionId": id}
			}
		case <-c.closed:
			return
		}
		if err := c.write(rpcFrame{
			JSONRPC: "2.0",
			ID:      f.ID,
			Result:  mustJSON(map[string]any{"outcome": outcome}),
		}); err != nil {
			log.Printf("acp: failed to answer permission %s: %v", f.ID, err)
		}
	}()
}

// permTitle never returns a string that is blank once whitespace and
// control characters are stripped. A permission prompt is the one place the
// user authorizes an action they cannot see, so a blank label asks them to
// approve nothing in particular — and the agent controls this string, so
// ANSI escapes or a carriage return reaching a naive prompt is how you get
// a repainted dialog. Degrade to the tool kind, then to the call id, then to
// an explicit warning — but always say something clean.
func permTitle(title, kind, id string) string {
	if clean := stripControl(title); strings.TrimSpace(clean) != "" {
		return clean
	}
	kind, id = stripControl(kind), stripControl(id)
	if kind != "" && id != "" {
		return kind + " (" + id + ")"
	}
	if kind != "" {
		return kind
	}
	if id != "" {
		return "tool call " + id
	}
	return "UNIDENTIFIED tool call — the agent sent no description"
}

// stripControl removes C0 (including DEL) and C1 control characters — the
// range that lets an agent-controlled string repaint a terminal or
// otherwise escape a UI that renders it as plain text.
func stripControl(s string) string {
	return strings.Map(func(r rune) rune {
		if r <= 0x1F || r == 0x7F || (r >= 0x80 && r <= 0x9F) {
			return -1
		}
		return r
	}, s)
}

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err) // only reachable with a non-serializable literal in our own code
	}
	return b
}
