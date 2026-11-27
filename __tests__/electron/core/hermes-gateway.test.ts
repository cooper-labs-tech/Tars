import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * The gateway Tars starts itself (core/hermes-gateway.ts, the orchestrator's go of 27/11): one per Tars's Hermes home,
 * started at the first Hermes terminal with no agent's identity, before that terminal's chat looks for one, restarted
 * if it dies while Hermes terminals are open, stopped by the rule of the stop (hermes-home.ts) at the last terminal and
 * at quit. Measured on the bench first (m6): the chats attach to it, A's stop leaves it and B, and each session's
 * detached tools carry their own agent's id.
 *
 * How it fails, written before the code:
 * 1. A second gateway: ensure starts one while a live gateway of this home runs (Tars's own, or one a chat started),
 *    or two when two terminals open at once.
 * 2. Gone for good: it exits while Hermes terminals are open and nothing starts it again. Or the reverse: it is
 *    started again after a stop Tars asked for, with no terminal open, or in a loop (more than three in a minute).
 * 3. The chat's line typed before the gateway holds its home (the chat would find none and start its own, with its
 *    terminal's environment): ready() resolves before the gateway is found, or never resolves.
 * 4. A binary that cannot be started throws into the terminal's spawn, instead of being said and leaving the chat to
 *    start one itself.
 * 5. The process itself (a real one here): not detached (macOS and Linux: a session of its own, which ending a
 *    terminal's tree never reaches), started with Tars's or an agent's environment instead of the gateway's, or not
 *    stopped by the stop's rule at the end.
 */

import { HermesGatewaySupervisor, startHermesGatewayProcess, type GatewayChild } from '../../../electron/core/hermes-gateway';
import { stopHermesGateway } from '../../../electron/services/hermes-home';

class FakeChild extends EventEmitter implements GatewayChild {
  constructor(readonly pid: number) { super(); }
  exit(code = 1) { this.emit('exit', code, null); }
}

function supervisor(o: { found?: number | null; terminals?: number } = {}) {
  const state = { found: o.found ?? null as number | null, terminals: o.terminals ?? 1, started: [] as FakeChild[], logs: [] as string[], now: 1_000_000, startFails: false };
  const s = new HermesGatewaySupervisor({
    find: async () => state.found,
    start: () => {
      if (state.startFails) return null;
      const c = new FakeChild(5000 + state.started.length);
      state.started.push(c);
      return c;
    },
    terminals: () => state.terminals,
    now: () => state.now,
    log: (m) => state.logs.push(m),
  });
  return { s, state };
}
const tick = () => new Promise(r => setTimeout(r, 5));

describe('starting it', () => {
  it('1: none is started while a live gateway of this home runs', async () => {
    const { s, state } = supervisor({ found: 4242 });
    expect(await s.ensure('hermes')).toBe('running');
    expect(state.started).toHaveLength(0);
  });

  it('1: one is started when there is none, even for two terminals at once', async () => {
    const { s, state } = supervisor();
    const [a, b] = await Promise.all([s.ensure('hermes'), s.ensure('hermes')]);
    expect([a, b].sort()).toEqual(['running', 'started']);
    expect(state.started).toHaveLength(1);
  });

  it('4: a binary that cannot be started is said, and nothing throws', async () => {
    const { s, state } = supervisor();
    state.startFails = true;
    expect(await s.ensure('not-there')).toBe('failed');
    expect(state.logs.join('\n')).toMatch(/gateway/);
  });
});

describe('when it exits', () => {
  it('2: it is started again while a Hermes terminal is open', async () => {
    const { s, state } = supervisor();
    await s.ensure('hermes');
    state.started[0].exit();
    await tick();
    expect(state.started).toHaveLength(2);
  });

  it('2: not after a stop Tars asked for, nor with no terminal open', async () => {
    const asked = supervisor();
    await asked.s.ensure('hermes');
    asked.s.stopping();
    asked.state.started[0].exit();
    await tick();
    expect(asked.state.started).toHaveLength(1);

    const none = supervisor();
    await none.s.ensure('hermes');
    none.state.terminals = 0;
    none.state.started[0].exit();
    await tick();
    expect(none.state.started).toHaveLength(1);
  });

  it('2: not when another gateway of this home already runs (a chat started one meanwhile)', async () => {
    const { s, state } = supervisor();
    await s.ensure('hermes');
    state.found = 4343;
    state.started[0].exit();
    await tick();
    expect(state.started).toHaveLength(1);
  });

  it('2: three times a minute at most, then said', async () => {
    const { s, state } = supervisor();
    await s.ensure('hermes');
    for (let i = 0; i < 5; i++) { state.started.at(-1)!.exit(); await tick(); }
    expect(state.started).toHaveLength(4);
    expect(state.logs.join('\n')).toMatch(/not started again/);
    state.now += 61_000;
    await s.ensure('hermes');
    expect(state.started).toHaveLength(5);
  });

  it('2: a new start after a stop is restarted again when it exits', async () => {
    const { s, state } = supervisor();
    await s.ensure('hermes');
    s.stopping();
    state.started[0].exit();
    await s.ensure('hermes');
    state.started[1].exit();
    await tick();
    expect(state.started).toHaveLength(3);
  });
});

describe('waiting for it', () => {
  it('3: ready resolves once the gateway Tars is starting is found, and not before', async () => {
    const { s, state } = supervisor();
    await s.ensure('hermes');
    let done = false;
    const ready = s.ready(2_000, 10).then((v) => { done = true; return v; });
    await new Promise(r => setTimeout(r, 50));
    expect(done).toBe(false);
    state.found = 4242;
    expect(await ready).toBe(true);
  });

  it('3: ready resolves false at its timeout', async () => {
    const { s } = supervisor();
    await s.ensure('hermes');
    expect(await s.ready(60, 10)).toBe(false);
  });

  it('3 and 4: with nothing of Tars\'s starting (its start failed, or it exited), ready holds no terminal', async () => {
    const { s, state } = supervisor();
    state.startFails = true;
    await s.ensure('not-there');
    const t = Date.now();
    expect(await s.ready(5_000, 10)).toBe(false);
    expect(Date.now() - t).toBeLessThan(1_000);
  });
});

describe.skipIf(process.platform === 'win32')('5: the process it starts, on macOS and Linux', () => {
  let tmp: string | undefined;
  let pid: number | undefined;
  afterEach(() => {
    if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    pid = undefined;
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('5: detached, the gateway\'s environment only, and stopped by the stop\'s rule', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-gateway-'));
    const root = path.join(tmp, 'hermes');
    fs.mkdirSync(root, { recursive: true });
    // A stand-in whose command line reads as a gateway's (`.../hermes_cli/main.py gateway run`): it records itself in
    // its home, says what it was given, and runs until stopped.
    const bin = path.join(tmp, 'hermes_cli', 'main.py');
    fs.mkdirSync(path.dirname(bin));
    fs.writeFileSync(bin, `#!${process.execPath}\nconst fs = require('fs'), path = require('path');\n`
      + 'const home = process.env.HERMES_HOME;\n'
      + 'fs.writeFileSync(path.join(home, "seen.json"), JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).sort(), cwd: process.cwd() }));\n'
      + 'fs.writeFileSync(path.join(home, "gateway.pid"), JSON.stringify({ pid: process.pid, hermes_home: home, kind: "hermes-gateway" }));\n'
      + 'setInterval(() => {}, 1000);\n', { mode: 0o755 });
    const source = { ...process.env, CLAUDE_AGENT_ID: 'agent-a', CLAUDE_MGR_API_TOKEN: 'tok-a', CLAUDE_PROJECT_PATH: '/p', OPENROUTER_API_KEY: 'sk-or' };
    const child = startHermesGatewayProcess(bin, { root, path: process.env.PATH ?? '/usr/bin:/bin', source });
    expect(child, 'started').toBeTruthy();
    for (let i = 0; i < 100 && !fs.existsSync(path.join(root, 'gateway.pid')); i++) await new Promise(r => setTimeout(r, 50));
    const seen = JSON.parse(fs.readFileSync(path.join(root, 'seen.json'), 'utf8'));
    pid = JSON.parse(fs.readFileSync(path.join(root, 'gateway.pid'), 'utf8')).pid;
    expect(seen.argv).toEqual(['gateway', 'run', '--quiet']);
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(root));
    for (const name of ['CLAUDE_AGENT_ID', 'CLAUDE_MGR_API_TOKEN', 'CLAUDE_PROJECT_PATH', 'OPENROUTER_API_KEY']) expect(seen.env, name).not.toContain(name);
    expect(seen.env).toContain('HERMES_HOME');
    // A session of its own: ending a terminal's tree, or its session, never reaches it.
    const sid = (p: number) => execFileSync('/bin/ps', ['-o', 'sess=', '-p', String(p)], { encoding: 'utf8' }).trim();
    const pgid = (p: number) => execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(p)], { encoding: 'utf8' }).trim();
    expect(pgid(pid!), 'its own process group').toBe(String(pid));
    if (process.platform === 'linux') expect(sid(pid!), 'its own session').not.toBe(sid(process.pid));
    // The stop's rule, as at the last terminal and at quit.
    const { commandOf, homeOf, startedAt, stopTarsHermesGatewayPid } = await import('../../../electron/core/hermes-gateway');
    expect(await stopHermesGateway(root, { commandOf, homeOf, startedAt, stop: stopTarsHermesGatewayPid })).toBe('stopped');
    for (let i = 0; i < 40; i++) { try { process.kill(pid!, 0); await new Promise(r => setTimeout(r, 50)); } catch { pid = undefined; break; } }
    expect(pid, 'stopped').toBeUndefined();
  });
});
