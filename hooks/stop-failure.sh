#!/bin/bash
source "$(dirname "${BASH_SOURCE[0]}")/tars-hook.sh"
# StopFailure hook for tars
#
# A turn that ends on an API error does not fire Stop. It fires StopFailure, and
# nothing listened to it, so an agent whose turn failed stayed `running` for
# ever: its process alive, its session registered, a turn begun, every signal
# Tars reads saying it was working.
#
# Measured on claude 2.1.268 with a HOME holding no credential. The CLI does not
# exit. SessionStart fires, the task becomes a turn and UserPromptSubmit fires,
# then the turn ends at once on "Not logged in · Please run /login", and the
# next event is this one:
#
#   {"hook_event_name":"StopFailure","error":"authentication_failed",
#    "last_assistant_message":"Not logged in · Please run /login", ...}
#
# One expired credential is shared by every agent on the machine, so they all
# fail in the same second. That is the night of 2026-09-16: five sessions dead
# in one minute, and JeanBrasse asking why nobody was working while the CLI had
# written the reason in each terminal.
#
# So this posts the failure with the CLI's own words, and the server puts the
# agent in `error` carrying them. Not a timer and not a guess about silence:
# the CLI says the turn failed, and says why.

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
ERROR_KIND=$(echo "$INPUT" | jq -r '.error // empty')
MESSAGE=$(echo "$INPUT" | jq -r '.last_assistant_message // empty')

echo "[$(date)] STOP_FAILURE hook. AGENT_ID=${CLAUDE_AGENT_ID:-unset} SESSION_ID=$SESSION_ID ERROR=$ERROR_KIND" >> "$HOOK_LOG"

# The Tars that spawned this agent, not whoever happens to own 31415:
# CLAUDE_MGR_API_URL is in the pty environment and follows DOROTHY_API_PORT.
API_URL="${CLAUDE_MGR_API_URL:-http://127.0.0.1:31415}"
AGENT_ID="${CLAUDE_AGENT_ID:-$SESSION_ID}"

# Built by jq rather than by quoting in shell: the message is text the CLI
# wrote, and a quote inside it must not end the JSON early.
PAYLOAD=$(jq -n \
  --arg agent_id "$AGENT_ID" \
  --arg session_id "$SESSION_ID" \
  --arg error_kind "$ERROR_KIND" \
  --arg error_message "$MESSAGE" \
  '{agent_id: $agent_id, session_id: $session_id, status: "error", event: "StopFailure", hook: "StopFailure",
    error_kind: $error_kind, error_message: $error_message}')

# Retried once, like the other posts that decide what Tars believes about a
# session: lost, and the agent goes back to saying it is working.
RESULT=$(curl -s --max-time 3 -X POST "$API_URL/api/hooks/status" -H @<(tars_auth) \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>&1)
if [ -z "$RESULT" ]; then
  sleep 1
  RESULT=$(curl -s --max-time 3 -X POST "$API_URL/api/hooks/status" -H @<(tars_auth) \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" 2>&1)
fi
echo "[$(date)] STOP_FAILURE curl result: $RESULT" >> "$HOOK_LOG"

exit 0
