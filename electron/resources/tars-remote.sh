#!/usr/bin/env bash
# tars-remote: what Tars installs on a remote Linux host to run an agent's CLI there (2.0.7, item 14;
# electron/core/remote-launch.ts builds every command that calls it). Installed at ~/.tars-remote/bin/tars-remote,
# with Tars's hook scripts beside it, again before each launch. It needs bash, tmux 3.0 or newer, base64, sed and
# coreutils on the host.
#
#   tars-remote version                             prints the version Tars installed
#   tars-remote env <id>                            stdin -> ~/.tars-remote/agents/<id>/env (0600): the CLI's environment
#   tars-remote start <id> <folder> <b64> <port>    ends the agent's tmux session if one is left, then starts one running
#                                                   the command (base64 of a POSIX command line) in <folder>, its
#                                                   environment sourced from the env file, which is then deleted, and
#                                                   Tars's API at 127.0.0.1:<port>, the tunnel's end on this host
#   tars-remote attach <id>                         attaches to the agent's tmux session (exit 6 when there is none)
#   tars-remote has <id>                            exit 0 when the agent's tmux session runs
#   tars-remote stop <id>                           ends the agent's tmux session (its CLI and what runs under it)
#
# The agent's session survives a dropped connection: tmux keeps it, and `attach` reaches it again.
set -u
VERSION=3
ROOT="$HOME/.tars-remote"

die() { printf 'tars-remote: %s\n' "$1" >&2; exit "${2:-2}"; }
valid_id() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,63}$ ]] || die "not an agent id: $1"; }
is_port() { [[ "$1" =~ ^[0-9]{4,5}$ ]] && [ "$1" -ge 1024 ] && [ "$1" -le 65535 ]; }
session() { printf 'tars-%s' "$1"; }

cmd="${1:-}"
shift || true
case "$cmd" in
  version)
    printf '%s\n' "$VERSION"
    ;;
  env)
    valid_id "${1:-}"
    umask 077
    mkdir -p "$ROOT/agents/$1"
    cat > "$ROOT/agents/$1/env"
    ;;
  start)
    valid_id "${1:-}"
    [ $# -eq 4 ] || die 'usage: tars-remote start <id> <folder> <base64 command> <port>'
    # A launch that cannot start leaves no environment behind (it holds the agent's token).
    forget() { rm -f "$ROOT/agents/$1/env"; }
    is_port "$4" || { forget "$1"; die "not a port for the tunnel: $4"; }
    command -v tmux >/dev/null || { forget "$1"; die 'tmux is not installed on this host' 3; }
    # Before 3.0, tmux runs new-session's arguments as one line through sh -c (the Audit's L3 on #600): refused.
    found=$(tmux -V 2>/dev/null)
    major=$(printf '%s' "$found" | sed -n 's/^tmux [^0-9]*\([0-9][0-9]*\)\..*/\1/p')
    if [ -z "$major" ] || [ "$major" -lt 3 ]; then
      forget "$1"
      die "tmux 3.0 or newer is needed on this host to run the agent's CLI; this one says: ${found:-nothing}" 3
    fi
    [ -d "$2" ] || { forget "$1"; die "no such folder on this host: $2" 4; }
    # A launch is a new CLI: a session of the agent's left on the host (a launch Tars no longer holds) ends first.
    tmux kill-session -t "$(session "$1")" 2>/dev/null || true
    exec tmux new-session -s "$(session "$1")" -c "$2" "$ROOT/bin/tars-remote" session "$1" "$2" "$3" "$4" \; set-option status off
    ;;
  attach)
    valid_id "${1:-}"
    tmux has-session -t "$(session "$1")" 2>/dev/null || die "no session of this agent on this host" 6
    exec tmux attach-session -t "$(session "$1")"
    ;;
  session)
    # Inside tmux: the environment Tars sent, then Tars's address at the tunnel's end (never the file's), the MCP file
    # with that port, then the command; the environment file goes before it runs.
    valid_id "${1:-}"
    is_port "${4:-}" || die "not a port for the tunnel: ${4:-}"
    export TARS_REMOTE_AGENT_DIR="$ROOT/agents/$1"
    envfile="$TARS_REMOTE_AGENT_DIR/env"
    if [ -f "$envfile" ]; then
      set -a
      # shellcheck disable=SC1090
      . "$envfile"
      set +a
      rm -f "$envfile"
    fi
    export CLAUDE_MGR_API_URL="http://127.0.0.1:$4"
    # The hooks' port is the tunnel's, sshd's for as long as the agent's token lives: its listener answers nothing
    # without a token, so they send theirs without asking it first (hooks/tars-hook.sh).
    export TARS_API_TUNNEL=1
    if [ -f "$TARS_REMOTE_AGENT_DIR/mcp.tmpl" ]; then
      (umask 077 && sed "s/{{TARS_PORT}}/$4/g" "$TARS_REMOTE_AGENT_DIR/mcp.tmpl" > "$TARS_REMOTE_AGENT_DIR/mcp.json") \
        || die 'the MCP file could not be written'
    fi
    cd "$2" || die "no such folder on this host: $2" 4
    line=$(printf '%s' "$3" | base64 -d) || die 'the command could not be read'
    exec bash -lc "cd $(printf '%q' "$2") && exec $line"
    ;;
  has)
    valid_id "${1:-}"
    tmux has-session -t "$(session "$1")" 2>/dev/null
    ;;
  stop)
    valid_id "${1:-}"
    tmux kill-session -t "$(session "$1")" 2>/dev/null || true
    rm -f "$ROOT/agents/$1/env"
    ;;
  *)
    die 'usage: tars-remote version | env <id> | start <id> <folder> <b64> <port> | attach <id> | has <id> | stop <id>'
    ;;
esac
