#!/usr/bin/env bash
# tars-remote: what Tars installs on a remote Linux host to run an agent's CLI there (2.0.7, item 14;
# electron/core/remote-launch.ts builds every command that calls it). Installed at ~/.tars-remote/bin/tars-remote,
# with Tars's hook scripts beside it. It needs bash, tmux, base64 and coreutils on the host.
#
#   tars-remote version                      prints the version Tars installed
#   tars-remote env <id>                     stdin -> ~/.tars-remote/agents/<id>/env (0600): the CLI's environment
#   tars-remote start <id> <folder> <b64>    attaches to the agent's tmux session, or starts it running the command
#                                            (base64 of a POSIX command line) in <folder>, its environment sourced
#                                            from the env file, which is then deleted
#   tars-remote has <id>                     exit 0 when the agent's tmux session runs
#   tars-remote stop <id>                    ends the agent's tmux session (its CLI and what runs under it)
#
# The agent's session survives a dropped connection: tmux keeps it, and `start` attaches to it again.
set -u
VERSION=1
ROOT="$HOME/.tars-remote"

die() { printf 'tars-remote: %s\n' "$1" >&2; exit "${2:-2}"; }
valid_id() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,63}$ ]] || die "not an agent id: $1"; }
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
    [ $# -eq 3 ] || die 'usage: tars-remote start <id> <folder> <base64 command>'
    command -v tmux >/dev/null || die 'tmux is not installed on this host' 3
    if tmux has-session -t "$(session "$1")" 2>/dev/null; then
      exec tmux attach-session -t "$(session "$1")"
    fi
    [ -d "$2" ] || die "no such folder on this host: $2" 4
    exec tmux new-session -s "$(session "$1")" -c "$2" "$ROOT/bin/tars-remote" session "$1" "$2" "$3" \; set-option status off
    ;;
  session)
    # Inside tmux: the environment Tars sent, then the command; the file goes before the command runs.
    valid_id "${1:-}"
    envfile="$ROOT/agents/$1/env"
    if [ -f "$envfile" ]; then
      set -a
      # shellcheck disable=SC1090
      . "$envfile"
      set +a
      rm -f "$envfile"
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
    die 'usage: tars-remote version | env <id> | start <id> <folder> <b64> | has <id> | stop <id>'
    ;;
esac
