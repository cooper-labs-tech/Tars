#!/bin/bash
# Sourced by every Tars hook: where it logs, and the credential it presents.
#
# The logs were /tmp/dorothy-hooks.log and /tmp/dorothy-hooks-debug.log,
# readable by every user of the machine and shared by every Tars on it, a
# sandbox's included. They carry session ids and task text. They live in the
# data folder of the Tars that owns the CLI now, readable by its user only.
# Tars's data folder, by pickDataDir's rule (electron/core/data-dir-move.ts):
# ~/.tars when it is a folder, else ~/.dorothy; of two different folders,
# ~/.dorothy only when it alone holds Tars's records.
tars_data_dir() {
  local t="$HOME/.tars" o="$HOME/.dorothy"
  if [ ! -d "$t" ]; then
    if [ -e "$t" ] || [ -L "$t" ] || [ -d "$o" ]; then printf %s "$o"; else printf %s "$t"; fi
    return
  fi
  if [ ! -d "$o" ] || [ "$(cd -P "$t" 2>/dev/null && pwd)" = "$(cd -P "$o" 2>/dev/null && pwd)" ]; then printf %s "$t"; return; fi
  if { [ -f "$o/agents.json" ] || [ -f "$o/app-settings.json" ]; } && [ ! -f "$t/agents.json" ] && [ ! -f "$t/app-settings.json" ]; then
    printf %s "$o"
  else
    printf %s "$t"
  fi
}
TARS_DATA_DIR=$(tars_data_dir)
TARS_LOG_DIR="$TARS_DATA_DIR/logs"
umask 077
mkdir -p "$TARS_LOG_DIR" 2>/dev/null
HOOK_LOG="$TARS_LOG_DIR/hooks.log"
HOOK_DEBUG_LOG="$TARS_LOG_DIR/hooks-debug.log"

# The token of this CLI's own terminal, minted by Tars when it spawned it and
# passed in its environment. The hook routes take it and nothing else: a post
# names the agent it is from, and the token proves it. Printed into a header
# through a process substitution, so it never appears in curl's argv.
#
# Sent only to the Tars that spawned the CLI (the Audit's table, #11). While
# Tars is down any process of any account may hold its port, and got every
# token posted to it. So the port is asked first to prove it knows this
# CLI's TARS_INSTANCE_ID: a fresh random challenge goes to /api/health, and
# the answer must be sha256("<id>:<challenge>"). The id itself never leaves.
# No id, no answer within 5 s, or a wrong one: no token, and the post is
# refused as if it had none. 5 s, longer than any post waits (3 s): a Tars
# whose main thread is held (a transcript scan, 2.7 s; the Usage page, 4.15 s)
# still gets its token. At 2 s it did not, and a Stop was lost (the Audit's
# gate of #212). A closed port answers at once; only a squatter that holds
# the connection costs each hook those 5 s. Asked once, here, as the hook starts: tars_auth
# runs in a subshell of its own for each post, where nothing it learnt would
# be kept.
TARS_TOKEN_OK=no
# On a remote host (2.0.7, services/remote-agents.ts), told so by Tars's wrapper there and by nothing else: the port
# is the tunnel's end, held by sshd for as long as the agent's terminal and so its token live, and its listener on this
# side answers nothing without an agent's token, /api/health included. The check would never pass there; skipping it
# gives a squatter nothing the check would keep from it, since any other agent's tunnel on that host answers it.
if [ "${TARS_API_TUNNEL:-}" = 1 ] && [ -n "${CLAUDE_MGR_API_TOKEN:-}" ]; then
  TARS_TOKEN_OK=yes
elif [ -n "${CLAUDE_MGR_API_TOKEN:-}" ] && [ -n "${TARS_INSTANCE_ID:-}" ]; then
  tars_challenge=$(od -An -tx1 -N16 /dev/urandom 2>/dev/null | tr -d ' \n')
  if [ ${#tars_challenge} -eq 32 ]; then
    tars_proof=$(curl -s --max-time 5 "${CLAUDE_MGR_API_URL:-http://127.0.0.1:31415}/api/health?challenge=$tars_challenge" 2>/dev/null \
      | jq -r '.proof // empty' 2>/dev/null)
    if command -v sha256sum >/dev/null 2>&1; then
      tars_expected=$(printf '%s' "$TARS_INSTANCE_ID:$tars_challenge" | sha256sum | cut -d' ' -f1)
    else
      tars_expected=$(printf '%s' "$TARS_INSTANCE_ID:$tars_challenge" | shasum -a 256 | cut -d' ' -f1)
    fi
    if [ -n "$tars_proof" ] && [ "$tars_proof" = "$tars_expected" ]; then TARS_TOKEN_OK=yes; fi
  fi
  unset tars_challenge tars_proof tars_expected
fi
# And which CLI posts, on every post (Tars adopts an agent nobody owns only
# from its terminal's own CLI): Claude Code's CLAUDE_PID, digits or nothing.
TARS_CLI_PID="${CLAUDE_PID:-}"
[[ "$TARS_CLI_PID" =~ ^[0-9]+$ ]] || TARS_CLI_PID=""
tars_auth() {
  if [ "$TARS_TOKEN_OK" = yes ]; then
    printf "Authorization: Bearer %s" "$CLAUDE_MGR_API_TOKEN"
    if [ -n "$TARS_CLI_PID" ]; then printf "\nX-Tars-Cli-Pid: %s" "$TARS_CLI_PID"; fi
  fi
}

# The token a hook's reads present (the bootstrap, the memory context, the
# memory post), on the same rule as its posts: the terminal's token only once
# the port proved it is this CLI's Tars. A CLI with a token whose port did not
# prove it gets none: a squatter would get it instead (the Audit's Info on
# #355). A CLI Tars did not start has no token: it reads with none, and Tars
# answers 401. It read with the shared ~/.dorothy/api-token until 2.0.4, when
# that file went to ~/.tars-private, which nothing an agent runs reads.
TARS_READ_TOKEN=""
if [ "$TARS_TOKEN_OK" = yes ]; then
  TARS_READ_TOKEN="$CLAUDE_MGR_API_TOKEN"
fi
