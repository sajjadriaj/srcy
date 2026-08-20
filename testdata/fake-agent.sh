#!/bin/sh
# A fake ACP agent. Reads one request per line, replies on stdout.
# Deliberately dumb: it pattern-matches on method names rather than parsing
# JSON, which is fine because the tests control every byte it receives.
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
      # Stream a message chunk, then ask permission, then finish.
      printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello "}}}}\n'
      printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"world"}}}}\n'
      printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Read a.txt","kind":"read","locations":[{"path":"a.txt"}]}}}\n'
      printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"sess-1","update":{"sessionUpdate":"unknown_future_kind","whatever":true}}}\n'
      printf '{"jsonrpc":"2.0","id":"p1","method":"session/request_permission","params":{"sessionId":"sess-1","toolCall":{"title":"rm -rf build"},"options":[{"optionId":"yes","name":"Allow","kind":"allow_once"},{"optionId":"no","name":"Reject","kind":"reject_once"}]}}\n'
      # Wait for the permission answer before finishing the turn.
      IFS= read -r ans
      printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn"}}\n' "$id"
      ;;
  esac
done
