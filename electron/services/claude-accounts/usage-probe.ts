import { spawn, type ChildProcess } from 'child_process';
import type { ClaudeAccountWindow } from '../../types';
import { refuseWhileQuitting } from '../../core/quit-state';
import { accountEnv } from './auth';
import { buildFullPath } from '../../utils/path-builder';
import { endProbe } from '../../core/version-probe';
import { resolveCliBinary, withPath, type Env } from '../../platform';

/**
 * Each Claude account's 5 h and weekly windows, read from Claude Code itself.
 *
 * The status line writes an account's counters only while a session on that
 * account draws itself, so an account no agent ran on for half an hour read as
 * unknown (choose.ts, STALE_AFTER_MS), and claude.ai on the web or the phone,
 * which shares the plan's limits, was never seen. `claude -p` in stream-json
 * answers a `get_usage` control request with the plan's windows as the
 * claude.ai usage endpoint gives them, per-model weeklies included (taken from
 * T3 Code, which reads them through the Agent SDK; PLAN-1.9.3.md).
 *
 * Measured on claude 2.1.289 (2026-10-04, usage-sdk-study/ in the review
 * folder): 1.7 to 2.4 s a probe; utilizations in percent, resets in ISO 8601;
 * a folder with no login answers `rate_limits_available: false`; with
 * CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC set the windows come back null.
 *
 * Claude Code reads its own credential, from the keychain item or file of the
 * folder CLAUDE_CONFIG_DIR names. Tars never reads, copies or stores a token:
 * it sends one control request and reads percentages back.
 */

export interface ProbedModelWindow {
  /** The server's label for the model bucket ("Fable"), one short line. */
  name: string;
  usedPercentage: number;
  /** Epoch seconds. */
  resetsAt: number;
}

export interface ProbedUsage {
  /** False when the account gave no reading: signed out, an API key, or no answer. */
  available: boolean;
  fiveHour: ClaudeAccountWindow | null;
  sevenDay: ClaudeAccountWindow | null;
  models: ProbedModelWindow[];
}

const NONE: ProbedUsage = { available: false, fiveHour: null, sevenDay: null, models: [] };
const PROBE_TIMEOUT_MS = 20_000;
/** How long a claude that answered has to exit by itself once its input is closed. */
const CLOSE_GRACE_MS = 3000;
const NAME_MAX = 40;

function percentage(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
}

function epochSeconds(iso: unknown): number | null {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
}

function window(raw: unknown): ClaudeAccountWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const used = percentage(r.utilization);
  const resets = epochSeconds(r.resets_at);
  return used === null || resets === null ? null : { usedPercentage: used, resetsAt: resets };
}

/** A label from the server, as one line a page can show: controls out, cut short. */
function label(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const line = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
  return line ? line.slice(0, NAME_MAX) : null;
}

/** A get_usage answer (the control response's `response`), as numbers only. */
export function parseUsageAnswer(raw: unknown): ProbedUsage {
  if (!raw || typeof raw !== 'object') return NONE;
  const answer = raw as Record<string, unknown>;
  const limits = answer.rate_limits;
  if (answer.rate_limits_available !== true || !limits || typeof limits !== 'object') return NONE;
  const l = limits as Record<string, unknown>;
  const models: ProbedModelWindow[] = [];
  for (const item of Array.isArray(l.model_scoped) ? l.model_scoped : []) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const name = label(m.display_name);
    const used = percentage(m.utilization);
    const resets = epochSeconds(m.resets_at);
    if (name && used !== null && resets !== null) models.push({ name, usedPercentage: used, resetsAt: resets });
  }
  return { available: true, fiveHour: window(l.five_hour), sevenDay: window(l.seven_day), models };
}

/**
 * The environment a probe runs with: the account's own (accountEnv: its folder,
 * none for account 1), on the PATH Tars launches CLIs with, without the
 * traffic switch, which empties the answer.
 */
export function usageProbeEnv(configDir: string | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // The PATH written once, under the spelling Windows already has (Path).
  const env = withPath(accountEnv(configDir, base) as Env, buildFullPath(), process.platform) as NodeJS.ProcessEnv;
  delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
  return env;
}

/** The probe's whole group, then the probe itself should it have left it; on Windows, which has no groups, its tree by taskkill (endProbe). */
function end(child: ChildProcess): void {
  endProbe(child);
}

const running = new Set<ChildProcess>();

/** Ends every probe still running. For the quit. */
export function endUsageProbes(): void {
  for (const child of running) end(child);
  running.clear();
}

/**
 * One `get_usage` to a claude started for it, and ended once it answered.
 * Rejects when it does not answer within `timeoutMs`, exits first, or answers
 * with an error; an answer with no reading resolves as one (`available` false).
 */
export function probeUsage(binary: string, env: NodeJS.ProcessEnv, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbedUsage> {
  try {
    refuseWhileQuitting('usage probe');
  } catch (err) {
    return Promise.reject(err);
  }
  // As the platform starts it: on Windows an npm shim is read through to node and its script.
  const cli = resolveCliBinary(binary, env as Env, process.platform);
  if (!cli.ok) return Promise.reject(new Error(cli.detail));
  return new Promise((resolve, reject) => {
    // detached: a group of its own, which end() signals whole. Not on Windows,
    // where it would open a console window of its own and taskkill ends the tree.
    // No settings and no MCP server of the account's: a probe is one control
    // request, and a whole session ran the account's SessionStart hooks (Tars's
    // session-start.sh then asked Hermes for memory) and started its MCP
    // servers, ten for account 1, to kill them a second later (the Audit's
    // gate). Measured on 2.1.289: the reading is the same with both flags.
    const child = spawn(cli.file, [
      ...cli.prefixArgs,
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--strict-mcp-config', '--setting-sources', '',
    ], {
      env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    });
    running.add(child);
    const requestId = `tars-usage-${Date.now()}`;
    let settled = false;
    const settle = (err: Error | null, usage?: ProbedUsage) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        running.delete(child);
        end(child);
        reject(err);
        return;
      }
      // It answered: its input closed, claude exits by itself and removes what
      // it registered on start (~/.claude/sessions/<pid>.json, its key and
      // /tmp/cc-socks/<pid>.sock), which a SIGKILL left behind, 144 a day per
      // account (QA's gate: out in 0.57 s, all three gone). One still there
      // after the grace is ended, group and all; the quit ends it meanwhile.
      const grace = setTimeout(() => { running.delete(child); end(child); }, CLOSE_GRACE_MS);
      child.once('close', () => { clearTimeout(grace); running.delete(child); });
      child.stdin?.end();
      resolve(usage!);
    };
    const timer = setTimeout(() => settle(new Error(`claude did not answer get_usage in ${timeoutMs} ms`)), timeoutMs);
    let buffer = '';
    child.stdout?.on('data', chunk => {
      buffer += String(chunk);
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let message: { type?: unknown; response?: { subtype?: unknown; request_id?: unknown; response?: unknown; error?: unknown } };
        try { message = JSON.parse(line); } catch { continue; }
        if (message.type !== 'control_response' || message.response?.request_id !== requestId) continue;
        if (message.response.subtype === 'success') settle(null, parseUsageAnswer(message.response.response));
        else settle(new Error(`claude refused get_usage: ${String(message.response.error ?? 'no reason given').slice(0, 200)}`));
      }
    });
    child.on('error', err => settle(err));
    child.on('close', code => settle(new Error(`claude exited (${code}) before it answered get_usage`)));
    child.stdin?.on('error', () => { /* a CLI that exits first is reported by close */ });
    child.stdin?.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'get_usage', skip_behaviors: true } })}\n`);
  });
}

/** The last reading of each account, kept in memory only: epoch ms of the probe. */
const probes = new Map<string, { usage: ProbedUsage; at: number }>();

export function recordProbe(accountId: string, usage: ProbedUsage, at: number = Date.now()): void {
  probes.set(accountId, { usage, at });
}

export function probedUsage(): ReadonlyMap<string, { usage: ProbedUsage; at: number }> {
  return probes;
}

/** Test seam. */
export function resetProbes(): void {
  probes.clear();
}
