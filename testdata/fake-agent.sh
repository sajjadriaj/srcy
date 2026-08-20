#!/bin/sh
# A fake ACP agent. Reads one request per line, replies on stdout.
# Deliberately dumb: it pattern-matches on method names rather than parsing
# JSON, which is fine because the tests control every byte it receives.
#
# Adversarial, not cooperative: this mirrors what the live claude-code-acp
# 0.16.2 adapter actually sends, which the original cooperative version of
# this fixture let several mutations survive against — tool_call content as
# an array (not the object shape agent_message_chunk uses), absolute
# locations, and permission requests with no title or kind. It also throws
# in adjacent wire-robustness cases (a response for an id nobody asked
# about, an error response, one malformed line, one line over 64KB, an
# unsupported incoming request, updates that keep streaming in while a
# permission sits unanswered) and refuses to start under the same
# environment variables the real adapter refuses under.
#
# Modes, selected by environment variable, for scenarios a single turn can't
# express:
#   FAKE_AGENT_DIE_MIDTURN=1     exit mid-turn, after one update
#   FAKE_AGENT_SILENT_PROMPT=1   accept the turn and never answer it
#   FAKE_AGENT_FLOOD=1           300 updates, unread on purpose, then a
#                                 permission request behind them
#   FAKE_AGENT_HUGE_LINE=1       one update line over the 8MB scanner cap
#   FAKE_AGENT_SIMPLE_PERM=1     one ordinary titled permission request,
#                                 nothing else — for tests that only care
#                                 about the permission wire traffic itself
#   FAKE_AGENT_WIRE_LOG=<path>   append the raw fs/read_text_file and
#                                 permission responses the client sends back,
#                                 one per line, for the test to assert on

if [ -n "$CLAUDECODE" ] || [ -n "$CLAUDE_CODE_SSE_PORT" ]; then
  echo "Claude Code cannot be launched inside another Claude Code session." >&2
  exit 1
fi

log() {
  if [ -n "$FAKE_AGENT_WIRE_LOG" ]; then
    printf '%s\n' "$1" >>"$FAKE_AGENT_WIRE_LOG"
  fi
}

while IFS= read -r line; do
  case "$line" in
    *'"initialize"'*)
      id=$(printf '%s' "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1}}\n' "$id"
      ;;
    *'"session/new"'*)
      id=$(printf '%s' "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')
      printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"sess-1"}}\n' "$id"
      ;;
    *'"session/prompt"'*)
      id=$(printf '%s' "$line" | sed 's/.*"id":\([0-9]*\).*/\1/')

      if [ -n "$FAKE_AGENT_SILENT_PROMPT" ]; then
        # Accept the turn and never answer it: exercises ctx cancellation.
        continue
      fi

      if [ -n "$FAKE_AGENT_DIE_MIDTURN" ]; then
        printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"dying"}}}}\n'
        exit 0
      fi

      if [ -n "$FAKE_AGENT_FLOOD" ]; then
        # 300 updates, unread by the test on purpose, then a permission
        # request behind them: a bounded, blocking send in the read loop
        # would deadlock on update #129 and never even reach this line.
        i=0
        while [ $i -lt 300 ]; do
          printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x"}}}}\n'
          i=$((i + 1))
        done
        printf '{"jsonrpc":"2.0","id":"pflood","method":"session/request_permission","params":{"sessionId":"sess-1","toolCall":{"title":"flood test","toolCallId":"tflood"},"options":[{"optionId":"yes","name":"Allow","kind":"allow_once"}]}}\n'
        IFS= read -r ans
        printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn"}}\n' "$id"
        continue
      fi

      if [ -n "$FAKE_AGENT_HUGE_LINE" ]; then
        # A single line over the client's 8MB scanner cap. Streamed in three
        # writes instead of held in one shell variable, so building it
        # doesn't itself hit the kernel's argv/ARG_MAX limit.
        printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"'
        # "X\n" is 2 bytes per yes line; -c 18000000 gives ~9,000,000 X's
        # after stripping newlines, comfortably over the 8MB (8,388,608) cap.
        yes X | head -c 18000000 | tr -d '\n'
        printf '"}}}}\n'
        IFS= read -r ans
        printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn"}}\n' "$id"
        continue
      fi

      if [ -n "$FAKE_AGENT_SIMPLE_PERM" ]; then
        printf '{"jsonrpc":"2.0","id":"psimple","method":"session/request_permission","params":{"sessionId":"sess-1","toolCall":{"title":"simple","toolCallId":"tsimple"},"options":[{"optionId":"yes","name":"Allow","kind":"allow_once"}]}}\n'
        IFS= read -r ans
        log "$ans"
        printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn"}}\n' "$id"
        continue
      fi

      # A response for an id nobody sent, and an error response for
      # another — both must be silently ignored, not crash the client.
      printf '{"jsonrpc":"2.0","id":501,"result":{"nobody":"asked"}}\n'
      printf '{"jsonrpc":"2.0","id":502,"error":{"code":-1,"message":"nobody asked either"}}\n'

      # One line that is not JSON at all.
      printf 'not even json\n'

      # tool_call, as the live adapter actually sends it: content is an
      # array of content blocks (not agent_message_chunk's plain object),
      # and locations carry an absolute path. The embedded text also pushes
      # this single line over 64KB, to exercise the scanner's larger buffer.
      big=$(yes X | head -c 140000 | tr -d '\n')
      printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"tool_call","toolCallId":"t1","kind":"read","locations":[{"path":"%s/a.txt"}],"content":[{"type":"content","content":{"type":"text","text":"%s"}}]}}}\n' "$PWD" "$big"

      printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello "}}}}\n'
      printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"world"}}}}\n'
      printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"unknown_future_kind","whatever":true}}}\n'

      # An incoming request for a method we do not implement. JSON-RPC
      # requires an answer; block on it, so failing to answer wedges this
      # whole turn instead of quietly passing.
      printf '{"jsonrpc":"2.0","id":"fs1","method":"fs/read_text_file","params":{"path":"/etc/hosts"}}\n'
      IFS= read -r fsresp
      log "$fsresp"

      # Permission with no title and no kind, matching live frames, while
      # more updates keep streaming in behind it in the background — a
      # client that answers inline, blocking the read loop on the reply,
      # would starve these until after the reply instead of delivering them
      # now.
      (
        i=0
        while [ $i -lt 3 ]; do
          printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"TICK"}}}}\n'
          i=$((i + 1))
          sleep 0.05
        done
      ) &
      printf '{"jsonrpc":"2.0","id":"p1","method":"session/request_permission","params":{"sessionId":"sess-1","toolCall":{"toolCallId":"t1"},"options":[{"optionId":"yes","name":"Allow","kind":"allow_once"},{"optionId":"no","name":"Reject","kind":"reject_once"}]}}\n'
      IFS= read -r ans
      log "$ans"
      wait

      printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn"}}\n' "$id"
      ;;
  esac
done
