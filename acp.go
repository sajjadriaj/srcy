package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"sync"
)

// Update is one session/update notification, flattened to what the UI needs.
type Update struct {
	Kind     string // sessionUpdate, e.g. agent_message_chunk, tool_call, plan
	Text     string // for message and thought chunks
	Title    string // for tool calls
	ToolPath string // first location of a tool call; blast radius uses these
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
	Updates chan Update
	Perms   chan PermissionReq

	cmd  *exec.Cmd
	out  *json.Encoder
	in   *bufio.Scanner
	mu   sync.Mutex
	next int
	// pending maps an outgoing request id to the channel its response lands on.
	pending map[int]chan rpcResponse
	writeMu sync.Mutex
	closed  chan struct{}
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
		cmd:     cmd,
		out:     json.NewEncoder(stdin),
		in:      bufio.NewScanner(stdout),
		pending: map[int]chan rpcResponse{},
		closed:  make(chan struct{}),
	}
	// Agent output is line-delimited JSON, and a long tool result is a long
	// line. The default 64K scanner limit would truncate it into a parse error.
	c.in.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	go c.readLoop()

	if _, err := c.call("initialize", map[string]any{
		"protocolVersion": 1,
		"clientCapabilities": map[string]any{
			"fs": map[string]any{"readTextFile": false, "writeTextFile": false},
		},
	}); err != nil {
		cmd.Process.Kill()
		return nil, fmt.Errorf("initialize: %w", err)
	}
	return c, nil
}

func (c *Client) NewSession(cwd string) (string, error) {
	res, err := c.call("session/new", map[string]any{
		"cwd":        cwd,
		"mcpServers": []any{},
	})
	if err != nil {
		return "", err
	}
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

func (c *Client) Close() error {
	select {
	case <-c.closed:
	default:
		close(c.closed)
	}
	if c.cmd.Process != nil {
		c.cmd.Process.Kill()
	}
	return c.cmd.Wait()
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
		return nil, io.ErrUnexpectedEOF
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

// readLoop is the only reader of the agent's stdout. It routes three shapes:
// a response (id, no method), an incoming request (id and method), and a
// notification (method, no id).
func (c *Client) readLoop() {
	defer func() {
		select {
		case <-c.closed:
		default:
			close(c.closed)
		}
		close(c.Updates)
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
			SessionUpdate string `json:"sessionUpdate"`
			Content       struct {
				Text string `json:"text"`
			} `json:"content"`
			Title     string `json:"title"`
			Locations []struct {
				Path string `json:"path"`
			} `json:"locations"`
		} `json:"update"`
	}
	if err := json.Unmarshal(f.Params, &p); err != nil {
		return
	}
	u := Update{
		Kind:  p.Update.SessionUpdate,
		Text:  p.Update.Content.Text,
		Title: p.Update.Title,
		Raw:   f.Params,
	}
	if len(p.Update.Locations) > 0 {
		u.ToolPath = p.Update.Locations[0].Path
	}
	// Unknown kinds ride through as-is. The UI ignores what it does not
	// recognize; dying here would break on every agent release.
	select {
	case c.Updates <- u:
	case <-c.closed:
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
		c.write(rpcFrame{
			JSONRPC: "2.0",
			ID:      f.ID,
			Result:  mustJSON(map[string]any{"outcome": outcome}),
		})
	}()
}

// permTitle never returns an empty string. A permission prompt is the one
// place the user authorizes an action they cannot see, so a blank label would
// be asking them to approve nothing in particular. Degrade to the tool kind,
// then to the call id, then to an explicit warning — but always say something.
func permTitle(title, kind, id string) string {
	if title != "" {
		return title
	}
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

func mustJSON(v any) json.RawMessage {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err) // only reachable with a non-serializable literal in our own code
	}
	return b
}
