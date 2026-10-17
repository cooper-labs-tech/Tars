import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DATA_DIR_SHELL, dataPath } from '../constants';
import { updateSharedJsonSync } from './shared-file';
import { nodeHookCommand, parseNodeHookCommand, isTarsHooksFile } from './hook-command';
import { getHooksPath } from './hooks-path';
import { unlinkRetryingSync } from '../platform/rename-replacing';

/**
 * The bash status line Tars installed on macOS and Linux until 2.0.4, which
 * needs bash, jq and awk. Not installed any more: hooks/statusline.mjs does
 * what it does, on every platform. Kept as the reference that port follows,
 * which the status line tests run beside it.
 */
export const STATUSLINE_SCRIPT = `#!/usr/bin/env bash
# Dev Bar statusline for Claude Code
# Style: ◆ Model │ ctx: NN% ▰▰▰▱▱ (Nk/Nk) │ branch │ NNm │ +N -N │ ↑Nk ↓Nk
# Based on https://github.com/LLRHook/claude-statusline

set -euo pipefail

INPUT=$(cat)

# --- One jq pass for everything ---
# This script runs on every turn, for every agent. Each field used to cost its
# own echo-into-jq, eighteen processes per render; one pass emits them all.
FIELDS=$(echo "$INPUT" | jq -r '
  [ (.session_id // ""),
    (.context_window.total_input_tokens // 0),
    (.context_window.total_output_tokens // 0),
    (.cost.total_cost_usd // 0),
    (.model.model_id // .model.display_name // "unknown"),
    (.rate_limits.five_hour.used_percentage // 0),
    (.rate_limits.seven_day.used_percentage // 0),
    (.model.display_name // "..."),
    (.context_window.used_percentage // 0),
    (.context_window.context_window_size // 200000),
    (.cost.total_duration_ms // 0),
    (.cost.total_lines_added // 0),
    (.cost.total_lines_removed // 0),
    ((.rate_limits // empty) | tostring)
  ] | @tsv' 2>/dev/null || true)

IFS=$'\t' read -r SESSION_ID T_IN T_OUT T_COST T_MODEL PCT_5H PCT_7D \
  MODEL RAW_PCT_RAW CTX_MAX DURATION_MS LINES_ADDED LINES_REMOVED RATE_LIMITS \
  <<< "$FIELDS"

: "\${SESSION_ID:=}" "\${T_IN:=0}" "\${T_OUT:=0}" "\${T_COST:=0}" "\${T_MODEL:=unknown}"
: "\${PCT_5H:=0}" "\${PCT_7D:=0}" "\${MODEL:=...}" "\${RAW_PCT_RAW:=0}" "\${CTX_MAX:=200000}"
: "\${DURATION_MS:=0}" "\${LINES_ADDED:=0}" "\${LINES_REMOVED:=0}"
INPUT_TOKENS="$T_IN"
OUTPUT_TOKENS="$T_OUT"
RAW_PCT=$(awk -v p="$RAW_PCT_RAW" 'BEGIN {printf "%d", p}')

RATE_LIMITS_FILE="${DATA_DIR_SHELL}/rate-limits.json"
# Which Claude account this CLI runs on, as Tars launched it: unset means
# account 1, as before several accounts. Its counters go under its own name,
# and only account 1's into rate-limits.json, which the Usage page reads. A
# name that is not an account writes nothing: it becomes a path.
RATE_LIMITS_ACCOUNT="\${TARS_CLAUDE_ACCOUNT-default}"
RATE_LIMITS_DIR="${DATA_DIR_SHELL}/rate-limits.d"
if [ -n "$RATE_LIMITS" ] && [ "$RATE_LIMITS" != "null" ]; then
  case "$RATE_LIMITS_ACCOUNT" in
    default|acct-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
      if [ "$RATE_LIMITS_ACCOUNT" = "default" ]; then
        echo "$RATE_LIMITS" > "$RATE_LIMITS_FILE" 2>/dev/null || true
      fi
      mkdir -p "$RATE_LIMITS_DIR" 2>/dev/null || true
      RATE_LIMITS_TMP="$RATE_LIMITS_DIR/.$RATE_LIMITS_ACCOUNT.$$.tmp"
      printf '{"updatedAt":%s,"rate_limits":%s}\\n' "$(date +%s)" "$RATE_LIMITS" > "$RATE_LIMITS_TMP" 2>/dev/null \\
        && mv "$RATE_LIMITS_TMP" "$RATE_LIMITS_DIR/$RATE_LIMITS_ACCOUNT.json" 2>/dev/null \\
        || rm -f "$RATE_LIMITS_TMP"
      ;;
  esac
fi

# --- Accumulate token stats per session for the Usage page ---
TOKEN_STATS_FILE="${DATA_DIR_SHELL}/token-stats.json"
if [ -n "$SESSION_ID" ]; then
  IS_EXTRA=$(awk -v a="$PCT_5H" -v b="$PCT_7D" 'BEGIN { print (a > 100 || b > 100) ? "true" : "false" }')

  # Acquire lock to prevent concurrent read-modify-write races. The lock is a
  # folder holding its owner's token, and a render removes only its own: a
  # render slow past 5 s, whose lock had been taken over, removed the new
  # holder's as it released (QA's gate of #216).
  LOCK_DIR="${DATA_DIR_SHELL}/token-stats.lock"
  LOCK_OWNER="$LOCK_DIR/owner"
  LOCK_TOKEN="$$.$RANDOM$RANDOM"
  # Past this many seconds a lock is taken for its holder's, dead.
  LOCK_STALE_AFTER=5
  LOCK_ACQUIRED=false
  take_lock() { mkdir "$LOCK_DIR" 2>/dev/null && printf '%s' "$LOCK_TOKEN" > "$LOCK_OWNER"; }
  lock_owner() { cat "$LOCK_OWNER" 2>/dev/null || true; }
  lock_age() { echo $(( $(date +%s) - $(stat -f%m "$1" 2>/dev/null || stat -c%Y "$1" 2>/dev/null || echo 0) )); }
  release_lock() {
    if [ "$(lock_owner)" = "$LOCK_TOKEN" ]; then
      rm -f "$LOCK_OWNER"
      rmdir "$LOCK_DIR" 2>/dev/null || true
    fi
  }
  for _i in $(seq 1 20); do
    if take_lock; then
      LOCK_ACQUIRED=true
      break
    fi
    sleep 0.05
  done
  # A lock over 5 s old was left by a render that died holding it, and is taken
  # over by one render at a time (the takeover folder), and only while it is
  # still the lock that was judged dead. Removed and made again by whoever
  # passed, it let two renders that had both judged it dead remove the one the
  # first had just taken, and write the count at once (the Audit's review of #216).
  if [ "$LOCK_ACQUIRED" = "false" ] && [ -d "$LOCK_DIR" ]; then
    STALE_OWNER=$(lock_owner)
    if [ "$(lock_age "$LOCK_DIR")" -gt "$LOCK_STALE_AFTER" ]; then
      TAKEOVER_DIR="$LOCK_DIR.takeover"
      # One left by a render killed while taking a lock over would stop every takeover after it.
      if [ -d "$TAKEOVER_DIR" ] && [ "$(lock_age "$TAKEOVER_DIR")" -gt "$LOCK_STALE_AFTER" ]; then
        rmdir "$TAKEOVER_DIR" 2>/dev/null || true
      fi
      if mkdir "$TAKEOVER_DIR" 2>/dev/null; then
        if [ "$(lock_owner)" = "$STALE_OWNER" ] && [ "$(lock_age "$LOCK_DIR")" -gt "$LOCK_STALE_AFTER" ]; then
          rm -f "$LOCK_OWNER"
          rmdir "$LOCK_DIR" 2>/dev/null || true
        fi
        take_lock && LOCK_ACQUIRED=true
        rmdir "$TAKEOVER_DIR" 2>/dev/null || true
      fi
    fi
  fi

  if [ "$LOCK_ACQUIRED" = "true" ]; then
    # Ensure lock is released on exit
    trap 'release_lock' EXIT

    # The file as text, parsed inside jq, so that anything which is not one
    # JSON object starts again from {}. It used to be piped straight into jq:
    # an empty file gave jq no input at all, jq printed nothing and exited 0,
    # and that nothing was moved back over the file, which then stayed empty
    # for good. A file that did not parse was never replaced either.
    EXISTING=$(cat "$TOKEN_STATS_FILE" 2>/dev/null || true)

    # Update session entry via temp file for atomic write
    T_DATE=$(date +%Y-%m-%d)
    T_PROVIDER="\${CLAUDE_PROVIDER:-claude}"
    # The account the session runs on (TARS_CLAUDE_ACCOUNT), so the Usage page
    # can say which one spent what; empty for a session that names none.
    T_ACCOUNT="\${TARS_CLAUDE_ACCOUNT:-}"
    TMP_FILE="\${TOKEN_STATS_FILE}.tmp.$$"
    printf '%s' "$EXISTING" | jq -c -R -s \
      --arg sid "$SESSION_ID" \
      --argjson tin "$T_IN" \
      --argjson tout "$T_OUT" \
      --argjson cost "$T_COST" \
      --arg model "$T_MODEL" \
      --argjson extra "$IS_EXTRA" \
      --arg date "$T_DATE" \
      --arg provider "$T_PROVIDER" \
      --arg account "$T_ACCOUNT" \
      '(try fromjson catch {}) | (if type == "object" then . else {} end)
       | .[$sid] = {"in": $tin, "out": $tout, "cost": $cost, "model": $model, "extra": $extra, "date": $date, "provider": $provider, "account": $account}' \
      > "$TMP_FILE" 2>/dev/null && mv "$TMP_FILE" "$TOKEN_STATS_FILE" 2>/dev/null || rm -f "$TMP_FILE"

    # Release lock, once. The trap goes first: the script runs on (git, for
    # the branch) before it exits, another render can take the lock by then,
    # and the trap would remove that render's lock.
    trap - EXIT
    release_lock
  fi
fi

# Autocompact buffer size (tokens). Adjust if Claude Code changes this.
AUTOCOMPACT_BUFFER=33000

# Fields already read above in a single jq pass.
CTX_USED=$(awk -v pct="$RAW_PCT" -v max="$CTX_MAX" 'BEGIN {printf "%d", (pct * max) / 100}')

# Usable space = total - autocompact buffer
CTX_USABLE=$((CTX_MAX - AUTOCOMPACT_BUFFER))
# Percentage relative to usable space (can exceed 100%)
CTX_PCT=$(awk -v used="$CTX_USED" -v usable="$CTX_USABLE" 'BEGIN {printf "%d", (used * 100) / usable}')

# --- Git branch (cached for performance) ---
# This cache used to live at /tmp/claude-statusline-git<escaped-pwd>. /tmp is
# world-writable and the name is fully derived from the project path, so any
# other local user could pre-create it as a symlink to, say,
# ~/.dorothy/app-settings.json or ~/.zshrc; the redirect below follows symlinks
# and this script runs on every agent turn, so the victim's file was truncated
# and overwritten with a branch name within seconds (CWE-59 / CWE-377).
# The cache now lives in the app's own private 0700 directory next to
# rate-limits.json and token-stats.json, and we still refuse to read or write
# through a symlink as defence in depth.
GIT_CACHE_DIR="${DATA_DIR_SHELL}/statusline-cache"
mkdir -p "$GIT_CACHE_DIR" 2>/dev/null || true
chmod 700 "$GIT_CACHE_DIR" 2>/dev/null || true
GIT_CACHE="$GIT_CACHE_DIR/git\${PWD//\//_}"
GIT_CACHE_TTL=5  # seconds
BRANCH="?"
if [ -f "$GIT_CACHE" ] && [ ! -L "$GIT_CACHE" ]; then
  CACHE_AGE=$(( $(date +%s) - $(stat -f%m "$GIT_CACHE" 2>/dev/null || stat -c%Y "$GIT_CACHE" 2>/dev/null || echo 0) ))
  if [ "$CACHE_AGE" -lt "$GIT_CACHE_TTL" ]; then
    BRANCH=$(cat "$GIT_CACHE")
  fi
fi
if [ "$BRANCH" = "?" ]; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")
  if [ ! -L "$GIT_CACHE" ]; then
    echo "$BRANCH" > "$GIT_CACHE" 2>/dev/null || true
  fi
fi

# --- Session duration ---
format_duration() {
  local ms=$1
  local total_sec=$((ms / 1000))
  local hours=$((total_sec / 3600))
  local mins=$(( (total_sec % 3600) / 60 ))
  if [ "$hours" -gt 0 ]; then
    printf "%dh%dm" "$hours" "$mins"
  elif [ "$mins" -gt 0 ]; then
    printf "%dm" "$mins"
  else
    printf "%ds" "$total_sec"
  fi
}
DURATION_FMT=$(format_duration "$DURATION_MS")

# --- Format token counts as human-readable ---
format_tokens() {
  local tokens=$1
  if [ "$tokens" -ge 1000000 ]; then
    echo "$(awk -v t="$tokens" 'BEGIN {printf "%.1f", t/1000000}')M"
  elif [ "$tokens" -ge 1000 ]; then
    echo "$(awk -v t="$tokens" 'BEGIN {printf "%.0f", t/1000}')k"
  else
    echo "$tokens"
  fi
}

CTX_USED_FMT=$(format_tokens "$CTX_USED")
CTX_USABLE_FMT=$(format_tokens "$CTX_USABLE")
IN_FMT=$(format_tokens "$INPUT_TOKENS")
OUT_FMT=$(format_tokens "$OUTPUT_TOKENS")

# --- Colors ---
RESET='\\033[0m'
DIM='\\033[2m'
BOLD='\\033[1m'
GREEN='\\033[32m'
YELLOW='\\033[33m'
RED='\\033[31m'
CYAN='\\033[36m'
MAGENTA='\\033[35m'
WHITE='\\033[37m'
BLUE='\\033[34m'

# Context color based on usage of usable space
if [ "$CTX_PCT" -ge 80 ]; then
  CTX_COLOR="$RED"
elif [ "$CTX_PCT" -ge 50 ]; then
  CTX_COLOR="$YELLOW"
else
  CTX_COLOR="$GREEN"
fi

# Build progress bar (10 segments, capped at 10 filled)
FILLED=$((CTX_PCT / 10))
if [ "$FILLED" -gt 10 ]; then FILLED=10; fi
EMPTY=$((10 - FILLED))
BAR=""
for ((i = 0; i < FILLED; i++)); do BAR+="▰"; done
for ((i = 0; i < EMPTY; i++)); do BAR+="▱"; done

# --- Separator ---
SEP="\${DIM} │ \${RESET}"

# --- Build the line ---
# Model
printf "\${CYAN}\${BOLD}◆\${RESET} \${WHITE}\${BOLD}%s\${RESET}" "$MODEL"
printf "%b" "$SEP"
# Context usage (relative to usable space)
printf "\${CTX_COLOR}ctx: %d%% %s\${RESET} \${DIM}(%s/%s)\${RESET}" "$CTX_PCT" "$BAR" "$CTX_USED_FMT" "$CTX_USABLE_FMT"
printf "%b" "$SEP"
# Git branch
printf "\${MAGENTA}%s\${RESET}" "$BRANCH"
printf "%b" "$SEP"
# Session duration
printf "\${DIM}%s\${RESET}" "$DURATION_FMT"
printf "%b" "$SEP"
# Lines changed
printf "\${GREEN}+%s\${RESET} \${RED}-%s\${RESET}" "$LINES_ADDED" "$LINES_REMOVED"
printf "%b" "$SEP"
# Token throughput (input/output)
printf "\${DIM}↑%s ↓%s\${RESET}" "$IN_FMT" "$OUT_FMT"
printf "\\n"
`;

const SCRIPT_PATH = dataPath('statusline.sh');
const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

/**
 * Remove the bash status line an older Tars installed in ~/.dorothy/statusline.sh
 */
function removeScript(): void {
  if (fs.existsSync(SCRIPT_PATH)) {
    fs.unlinkSync(SCRIPT_PATH);
  }
}

/**
 * Read Claude Code's settings.json
 */
function readClaudeSettings(): Record<string, unknown> {
  try {
    if (fs.existsSync(CLAUDE_SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8'));
    }
  } catch {
    // ignore parse errors
  }
  return {};
}

/**
 * Change Claude Code's settings.json. `change` gets what the file holds now and
 * returns it changed, or undefined to leave it as it is.
 *
 * Through updateSharedJsonSync, because every claude binary reads this file
 * when it starts and Claude Code writes it too, and this runs at every launch
 * while the status line is on. It was rewritten in place each time, whether
 * anything changed or not, and a file that did not parse was read as `{}`, so
 * turning the status line on wrote `statusLine` alone over every other
 * setting. Now it is written beside itself and renamed over, with its mode
 * kept, not at all when nothing changes, and never over a file that is not
 * JSON.
 *
 * `change` returns the whole file, not a patch to merge: merging with what is
 * on disk would quietly undo `disableStatusLine`'s delete, since the key it
 * just removed would come straight back from the file.
 */
function updateClaudeSettings(change: (settings: Record<string, unknown>) => Record<string, unknown> | undefined): void {
  const outcome = updateSharedJsonSync<Record<string, unknown>>(
    CLAUDE_SETTINGS_PATH,
    current => change(current ?? {}),
    { createMode: 0o644 },
  );
  if (outcome === 'unreadable') console.warn(`[statusline] ${CLAUDE_SETTINGS_PATH} is not valid JSON, left untouched`);
  if (outcome === 'busy') console.warn(`[statusline] ${CLAUDE_SETTINGS_PATH} kept changing, left as Claude Code wrote it`);
}

/** Where the platform and the hooks folder come from; the app passes neither. */
type StatusLineOptions = { platform?: NodeJS.Platform; hooksDir?: string };

/**
 * The status line is hooks/statusline.mjs run by the Node runner's launcher
 * (hook-launcher.ts), or `node`, on every platform: nothing is installed in
 * ~/.dorothy, the command names the bundled file, quoted for Git Bash and
 * PowerShell alike. Until 2.0.4 macOS and Linux ran a bash script that needs
 * jq and awk (STATUSLINE_SCRIPT above).
 */
function nodeStatusLineCommand(hooksDir: string): string {
  return nodeHookCommand(path.join(hooksDir, 'statusline.mjs'));
}

/**
 * A Node status line Tars wrote, from this checkout or another Tars: its
 * statusline.mjs in this app's hooks folder, or in one that holds Tars's
 * runner beside it, never under a .claude or .gemini folder. A user's own
 * Node status line called statusline.mjs is theirs (isTarsHooksFile).
 */
function isTarsNodeStatusLine(command: unknown, hooksDir: string): boolean {
  const parsed = parseNodeHookCommand(command);
  return !!parsed && !parsed.event
    && isTarsHooksFile(parsed.script, 'statusline.mjs', path.dirname(CLAUDE_SETTINGS_PATH), hooksDir);
}

/**
 * Enable the statusline: point Claude settings.json at statusline.mjs, and
 * remove the bash one an older Tars installed.
 */
export function enableStatusLine({ hooksDir }: StatusLineOptions = {}): void {
  const command = nodeStatusLineCommand(hooksDir ?? getHooksPath());
  updateClaudeSettings(settings => ({
    ...settings,
    statusLine: {
      type: 'command',
      command,
      padding: 1,
    },
  }));
  removeScript();
}

/**
 * Disable the statusline: remove config from Claude settings.json + remove script
 */
export function disableStatusLine({ platform = process.platform, hooksDir }: StatusLineOptions = {}): void {
  updateClaudeSettings(settings => {
    // Only ours. `statusLine` is Claude Code's setting, not Tars's: a user can
    // point it at their own script, and Claude Code can write it itself.
    // Turning Tars's statusline off means stop using Tars's script, never
    // delete whichever statusline happens to be configured. Deleting a key we
    // did not write is how a setting disappears with nobody able to say what
    // removed it.
    const configured = settings.statusLine as { command?: unknown } | undefined;
    const isOurs = !!configured
      && typeof configured === 'object'
      && (configured.command === SCRIPT_PATH || isTarsNodeStatusLine(configured.command, hooksDir ?? getHooksPath()));
    if (!isOurs) return undefined;
    const withoutOurs = { ...settings };
    delete withoutOurs.statusLine;
    return withoutOurs;
  });

  removeScript();

  // Remove cached rate-limits data so Usage page no longer shows stale quota
  const rateLimitsFile = dataPath('rate-limits.json');
  if (fs.existsSync(rateLimitsFile)) {
    unlinkRetryingSync(rateLimitsFile, { platform });
  }
}

/**
 * Check if statusline is currently configured in Claude settings.json
 */
export function isStatusLineConfigured(): boolean {
  const settings = readClaudeSettings();
  return settings.statusLine != null;
}
