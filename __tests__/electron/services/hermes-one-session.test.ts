import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { startFakeHermesGateway, type FakeHermesGateway, type HermesFlavour } from '../../fixtures/fake-hermes-gateway';

/**
 * The Chat talks to Hermes in one session, kept (JeanBrasse, 21/10: "dans chat, à chaque cron
 * automatique ça ouvre une nouvelle session et ça ne garde pas la même").
 *
 * Measured on 21/10 and 22/10 with Tars's own compiled transport against a real Hermes 0.21.5 and a
 * 0.22.2 canary (fixtures/fake-hermes-gateway.ts says what each answers): every Tars start, and every
 * turn after a failed one, opened a session with session.create and used it as the name of a terminal
 * channel, never as the conversation; each turn then opened /api/pty with a new attach token, so the
 * dashboard started a chat TUI per turn (kept 30 minutes, up to 16), and each TUI resumed the session
 * its channel's marker named or started one of its own. The first turn on a channel made a session;
 * the next ones were answered by the dashboard's {"type":"resume"} frame, taken for the reply, and
 * never asked Hermes anything; a channel whose marker was dropped started a new session again. And
 * an automatic check-in that could not go live triggered the cron job, each of whose runs is a
 * session of its own (cron/scheduler.py: cron_{job}_{YYYYMMDD_HHMMSS}).
 *
 * How it can fail, written before the fix (22/10):
 *  S1. A turn opens a terminal on the gateway (/api/pty), which starts sessions of its own.
 *  S2. The first turn makes no session or more than one; a later turn makes another.
 *  S3. Tars restarted makes a new session instead of resuming the one it kept.
 *  S4. A dropped socket (a sleep, a network change) or a restarted gateway: the next turn makes a new session.
 *  S5. A session the gateway no longer has (0.21.5 answers 4007) is not replaced and the turn fails; or
 *      its replacement is not kept, and every later turn makes another; or one is made while the
 *      gateway still has the kept one.
 *  S6. An automatic check-in falls back to the cron transport.
 *  S7. A user's turn falls back to the cron after a live turn failed: the question asked again, in a new session.
 *  S8. The answer is not the session's own message.complete: the dashboard's resume frame, a delta, or nothing.
 *  S9. A failed turn forgets the session kept: the next one makes a new session.
 *  S10. The session kept is not the one memory_search leaves out.
 *  S11. A gateway that takes no conversation socket stops answering the user (the cron fallback lost).
 *
 * The overseer, its transport and the Hermes client are the real ones, against the stand-in, in both
 * flavours. A Tars restart is every module loaded afresh, with what is on disk kept.
 */

vi.mock('electron', () => ({ ipcMain: { handle: () => {} } }));
vi.mock('../../../electron/core/agent-manager', () => ({ agents: new Map() }));
vi.mock('../../../electron/services/git-review', () => ({ repoSummary: async () => ({ success: false }) }));

type Overseer = typeof import('../../../electron/services/overseer');

let gateway: FakeHermesGateway;
let overseer: Overseer;

/** What the gateway answers on turn n, and what the Chat must show for it. */
const said = (n: number) => `Check-in number ${n}: nothing to report.`;

/** Tars starts: every module loaded afresh, as a new process loads them; the disk is kept. */
async function startTars(): Promise<Overseer> {
  vi.resetModules();
  return import('../../../electron/services/overseer');
}

async function connect(): Promise<void> {
  const conn = { mode: 'remote' as const, url: gateway.url, authMode: 'oauth' as const };
  (await import('../../../electron/services/hermes-config')).writeHermesConnection(conn);
  const signed = await (await import('../../../electron/services/hermes-client')).signInHermes(conn, { username: 'bench', password: 'pw' });
  expect(signed.success).toBe(true);
}

const rpc = (method: string) => gateway.events.filter(e => e.kind === 'rpc' && e.detail?.method === method).length;
const terminals = () => gateway.events.filter(e => e.kind === 'pty').length;
const cron = () => gateway.events.filter(e => e.kind === 'cron').length;

async function ask(text: string, opts: { isBriefing?: boolean } = {}) {
  return overseer.askOverseer(text, opts);
}

describe.each<HermesFlavour>(['0.21.5', '0.22'])('the Chat on Hermes %s', flavour => {
  beforeEach(async () => {
    gateway = await startFakeHermesGateway({ flavour, ptyTtlMs: 200 });
    const { OVERSEER_FILE } = await import('../../../electron/constants');
    fs.rmSync(OVERSEER_FILE, { force: true });
    overseer = await startTars();
    await connect();
  });

  afterEach(async () => {
    overseer.resetLiveSession();
    await gateway.close();
  });

  it('S1 S2 S8. turns and check-ins: one session, no terminal, each answered by its own turn', async () => {
    const answers: string[] = [];
    for (const [text, isBriefing] of [['What is everyone doing?', false], ['Fleet change since the last check: one.', true], ['And now?', false]] as const) {
      const result = await ask(text, { isBriefing });
      expect(result, text).toMatchObject({ ok: true });
      if (result.ok) answers.push(result.message.text);
      // A terminal's marker is dropped with the terminal, between two check-ins.
      await new Promise(r => setTimeout(r, 300));
    }
    expect(answers).toEqual([said(1), said(2), said(3)]);
    expect(gateway.rows()).toHaveLength(1);
    expect(gateway.rows()[0].messages).toHaveLength(6);
    expect(terminals()).toBe(0);
    expect(rpc('session.create')).toBe(1);
  }, 60_000);

  it('S3. Tars restarted resumes the session it kept', async () => {
    expect(await ask('Before the restart?')).toMatchObject({ ok: true });
    const kept = gateway.rows()[0]?.id;
    overseer.resetLiveSession();
    overseer = await startTars();
    const result = await ask('After the restart?');
    expect(result).toMatchObject({ ok: true, message: { text: said(2) } });
    expect(gateway.rows().map(r => r.id)).toEqual([kept]);
    expect(rpc('session.create')).toBe(1);
    expect(rpc('session.resume')).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it('S4. a dropped socket, then a restarted gateway: still the same session', async () => {
    expect(await ask('Before the sleep?')).toMatchObject({ ok: true });
    gateway.dropSockets();
    expect(await ask('After the wake?', { isBriefing: false })).toMatchObject({ ok: true, message: { text: said(2) } });
    gateway.restart();
    expect(await ask('After the gateway restarted?')).toMatchObject({ ok: true, message: { text: said(3) } });
    expect(gateway.rows()).toHaveLength(1);
    expect(gateway.rows()[0].messages).toHaveLength(6);
    expect(rpc('session.create')).toBe(1);
  }, 60_000);

  it('S5. a session the gateway no longer has: replaced once, and the replacement kept', async () => {
    expect(await ask('First?')).toMatchObject({ ok: true });
    const first = gateway.rows()[0].id;
    gateway.deleteSession(first);
    gateway.dropSockets();
    expect(await ask('Second?')).toMatchObject({ ok: true, message: { text: said(2) } });
    gateway.dropSockets();
    expect(await ask('Third?')).toMatchObject({ ok: true, message: { text: said(3) } });
    // 0.21.5 refuses the deleted id and a new session takes its place; the canary makes it again under
    // the same id. Either way, one session from then on.
    expect(gateway.rows()).toHaveLength(1);
    expect(gateway.rows()[0].messages).toHaveLength(4);
    expect(rpc('session.create')).toBe(flavour === '0.21.5' ? 2 : 1);
  }, 60_000);

  it('S6. an automatic check-in never runs the cron job: not when the live turn fails, not when there is none', async () => {
    expect(await ask('Warm up?')).toMatchObject({ ok: true });
    gateway.dropNextTurn();
    expect(await ask('Fleet change since the last check: two.', { isBriefing: true })).toMatchObject({ ok: false });
    overseer.resetLiveSession();
    gateway.refuseConversation(true);
    expect(await ask('Fleet change since the last check: three.', { isBriefing: true })).toMatchObject({ ok: false });
    expect(cron()).toBe(0);
    expect(gateway.rows()).toHaveLength(1);
  }, 60_000);

  it('S7 S9. a failed turn asks nothing a second time, and the next one is in the same session', async () => {
    expect(await ask('Warm up?')).toMatchObject({ ok: true });
    gateway.dropNextTurn();
    expect(await ask('Is the review done?')).toMatchObject({ ok: false });
    expect(cron()).toBe(0);
    expect(await ask('Is the review done now?')).toMatchObject({ ok: true, message: { text: said(2) } });
    expect(gateway.rows()).toHaveLength(1);
    expect(rpc('session.create')).toBe(1);
  }, 60_000);

  it('S10. the session kept is the one memory_search leaves out', async () => {
    expect(await ask('Remember me?')).toMatchObject({ ok: true });
    const store = await import('../../../electron/services/overseer-store');
    expect(store.isOverseerHermesSession(gateway.rows()[0].id)).toBe(true);
  }, 60_000);

  it('S11. a gateway that takes no conversation socket still answers the user, through the cron job', async () => {
    gateway.refuseConversation(true);
    const result = await ask('Anyone stuck?');
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, message: { text: said(1) } });
    expect(cron()).toBeGreaterThan(0);
  }, 90_000);
});
