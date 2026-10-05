import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startFakeRelay, type FakeRelay } from '../../fixtures/fake-tars-relay';

/**
 * Tars's side of the relay to the user's Telegram through their Hermes (DESIGN-RELAIS-HERMES-V2.md, step 2): the
 * channel itself. A send goes to the tars-relay plugin's /send on the gateway Tars already reaches; the user's replies
 * come back from its /replies, polled every 5 s while the relay is on, and are acked once taken.
 *
 * How this can fail, written before the code:
 * 1. A send does not reach the plugin, or reaches it without the dashboard's token, or other than as the caller wrote
 *    it: its text, kind and ref, and the project as the one word the plugin takes.
 * 2. The message id that came back is not in Tars's own list of what it sent; or that list is kept where agents can
 *    write it (~/.dorothy), or where others can read it (not 0600 in a 0700 folder).
 * 3. With the relay off, anything is sent, polled or acked, or a send says it went.
 * 4. With Hermes down, a send is lost, or goes another way (there is no fallback), or its caller is told it went; it
 *    does not go once Hermes answers again; it goes twice; or it still goes after its time is up.
 * 5. A reply to a message Tars did not send, an id not in its own list, is handed to anyone, or vanishes without the
 *    user being told.
 * 6. A reply is handed over twice, within a poll, across polls or after a restart; or it is never acked, and the
 *    plugin keeps it a week.
 * 7. The plugin is missing, its user id is not set on the server, the token is refused, or Hermes is down, and the
 *    status does not say which.
 * 8. A reply whose handler throws stops the ones after it, or is never acked.
 * 9. With the relay on, the event reports do not go through it, or go under no project; with it off, they still go.
 * 11. The plugin's store is made again (reinstalled, moved, cleaned) and numbers its replies from 1 again: Tars skips
 *    every reply at or below the last number it took, acks it, and the plugin deletes it, JeanBrasse told nothing
 *    (GATE-PR285.md); or Tars, starting over, hands over again a reply of the same store whose ack was lost.
 * 10. The plugin keeps "@name" for Tars only for the projects Tars registered with it (the Audit's Low on #280): the
 *    fleet's projects are not registered, and every "@project" goes to Hermes's model; a folder name that is not one
 *    word is sent, the plugin refuses the whole list, and no project can be reached; a project added to the fleet or
 *    gone from it is not told to the plugin at the next round, nor are the names again once the plugin has lost them;
 *    or they are posted at every round when nothing changed, in another case included.
 *
 * A real HTTP stand-in for the plugin's routes (fixtures/fake-tars-relay.ts), the real connection file under a
 * throwaway HOME, the real channel module, loaded again to play a restart.
 */

type Relay = typeof import('../../../electron/services/hermes-relay');
let relay: Relay;
let fake: FakeRelay;
let on = true;
const T0 = Date.UTC(2026, 9, 1, 8, 0, 0);
const PROJECT = '/Users/someone/projects/tars';

async function load(): Promise<Relay> {
  vi.resetModules();
  const config = await import('../../../electron/services/hermes-config');
  config.writeHermesConnection({ mode: 'local', localPort: fake.port, authMode: 'token', token: fake.token });
  relay = await import('../../../electron/services/hermes-relay');
  relay.startHermesRelay({ enabled: () => on, pollMs: 0 });
  return relay;
}

const privateFile = (name: string) => path.join(os.homedir(), '.tars-private', name);

beforeAll(async () => {
  fake = await startFakeRelay();
});

afterAll(async () => {
  relay?.stopHermesRelay();
  await fake.close();
});

beforeEach(async () => {
  relay?.stopHermesRelay();
  fs.rmSync(path.join(os.homedir(), '.tars-private'), { recursive: true, force: true });
  fake.mode = 'ok';
  fake.sends.length = 0;
  fake.replies.length = 0;
  fake.acks.length = 0;
  fake.calls.length = 0;
  fake.ignoreAcks = false;
  on = true;
  await load();
});

describe('a send', () => {
  it('1. reaches the plugin with the dashboard token, as the caller wrote it, the project as one word', async () => {
    const result = await relay.relaySend({ text: 'Question from Tars-Backend\n> may I?', kind: 'question', ref: 'question:q-1', projectPath: PROJECT }, T0);

    expect(result).toEqual({ state: 'sent', messageId: '501' });
    expect(fake.sends).toEqual([{ text: 'Question from Tars-Backend\n> may I?', kind: 'question', ref: 'question:q-1', project: 'tars', messageId: '501', token: fake.token }]);
  });

  it('1. a project name the plugin would refuse is made one word, never left out', async () => {
    await relay.relaySend({ text: 'x', kind: 'report', ref: 'report:r-1', projectPath: '/Users/someone/My Project: v2' }, T0);

    expect(fake.sends[0].project).toBe('My-Project--v2');
  });

  it('2. what went out is in Tars\'s own list, in ~/.tars-private, readable by its owner alone', async () => {
    const sent = await relay.relaySend({ text: 'x', kind: 'question', ref: 'question:q-1', projectPath: PROJECT }, T0);

    const list = JSON.parse(fs.readFileSync(privateFile('relay-sent.json'), 'utf-8'));
    expect(list).toEqual([expect.objectContaining({ messageId: (sent as { messageId: string }).messageId, ref: 'question:q-1', kind: 'question', projectPath: PROJECT })]);
    expect(fs.statSync(privateFile('relay-sent.json')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(os.homedir(), '.tars-private')).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(os.homedir(), '.dorothy', 'relay-sent.json'))).toBe(false);
  });

  it('3. with the relay off, nothing is sent, polled or acked, and the caller is told why', async () => {
    on = false;
    fake.reply({ messageId: '501', ref: 'question:q-1' }, 'Oui');

    const result = await relay.relaySend({ text: 'x', kind: 'question', ref: 'question:q-1', projectPath: PROJECT }, T0);
    await relay.relayTick(T0);

    expect(result).toEqual({ state: 'refused', reason: expect.stringMatching(/relay.*off/i) });
    expect(fake.calls).toEqual([]);
  });
});

describe('Hermes down', () => {
  it('4. the send waits, the caller is told it has not gone, and it goes once, when Hermes answers', async () => {
    fake.mode = 'down';
    const result = await relay.relaySend({ text: 'x', kind: 'question', ref: 'question:q-1', projectPath: PROJECT, expiresAt: T0 + 3_600_000 }, T0);

    expect(result).toEqual({ state: 'queued', reason: expect.any(String) });
    expect(fake.sends).toEqual([]);

    fake.mode = 'ok';
    await relay.relayTick(T0 + 10_000);
    await relay.relayTick(T0 + 15_000);

    expect(fake.sends.map((s) => s.ref)).toEqual(['question:q-1']);
    const list = JSON.parse(fs.readFileSync(privateFile('relay-sent.json'), 'utf-8'));
    expect(list.map((s: { ref: string }) => s.ref)).toEqual(['question:q-1']);
  });

  it('4. a send whose time is up while Hermes was down never goes', async () => {
    fake.mode = 'down';
    await relay.relaySend({ text: 'x', kind: 'report', ref: 'report:r-1', projectPath: PROJECT, expiresAt: T0 + 60_000 }, T0);

    fake.mode = 'ok';
    await relay.relayTick(T0 + 120_000);

    expect(fake.sends).toEqual([]);
  });

  it('4. a send that waits survives a restart of Tars', async () => {
    fake.mode = 'down';
    await relay.relaySend({ text: 'x', kind: 'question', ref: 'question:q-1', projectPath: PROJECT, expiresAt: T0 + 3_600_000 }, T0);

    fake.mode = 'ok';
    await load();
    await relay.relayTick(T0 + 10_000);

    expect(fake.sends.map((s) => s.ref)).toEqual(['question:q-1']);
  });
});

describe('the user\'s replies', () => {
  it('6. a reply to a message Tars sent is handed to its handler once, with what it answers, and acked', async () => {
    const got: Array<{ refId: string; text: string; projectPath: string }> = [];
    relay.onRelayReply('question', (reply) => { got.push({ refId: reply.refId, text: reply.text, projectPath: reply.projectPath }); });
    const sent = await relay.relaySend({ text: 'x', kind: 'question', ref: 'question:q-1', projectPath: PROJECT }, T0);
    const seq = fake.reply({ messageId: (sent as { messageId: string }).messageId }, 'Oui, vas-y');

    await relay.relayTick(T0 + 5_000);
    await relay.relayTick(T0 + 10_000);

    expect(got).toEqual([{ refId: 'q-1', text: 'Oui, vas-y', projectPath: PROJECT }]);
    expect(fake.acks).toContain(seq);
    expect(fake.replies).toEqual([]);
  });

  it('6. after a restart, a reply already taken is not handed over again, even when its ack was lost', async () => {
    const got: string[] = [];
    relay.onRelayReply('question', (reply) => { got.push(reply.text); });
    const sent = await relay.relaySend({ text: 'x', kind: 'question', ref: 'question:q-1', projectPath: PROJECT }, T0);
    fake.reply({ messageId: (sent as { messageId: string }).messageId }, 'Oui');
    fake.ignoreAcks = true;
    await relay.relayTick(T0 + 5_000);
    fake.ignoreAcks = false;

    await load();
    relay.onRelayReply('question', (reply) => { got.push(`again: ${reply.text}`); });
    await relay.relayTick(T0 + 10_000);

    expect(got).toEqual(['Oui']);
    expect(fake.replies, 'acked once Tars is back').toEqual([]);
  });

  it('5. a reply to a message Tars did not send is handed to nobody, and the user is told', async () => {
    const got: string[] = [];
    relay.onRelayReply('question', (reply) => { got.push(reply.text); });
    const seq = fake.reply({ messageId: '999', ref: 'question:q-1', project: 'tars' }, 'Oui');

    await relay.relayTick(T0 + 5_000);

    expect(got).toEqual([]);
    expect(fake.acks).toContain(seq);
    expect(fake.sends).toEqual([expect.objectContaining({ kind: 'report', ref: expect.stringMatching(/^notice:/), text: expect.stringMatching(/Tars did not send/) })]);
  });

  it('5. a reply whose ref names a real question of Tars\'s, but answers another message, is handed to nobody', async () => {
    // Someone with the dashboard token made the plugin send a look-alike question under the ref of a real one.
    const got: string[] = [];
    relay.onRelayReply('question', (reply) => { got.push(reply.text); });
    await relay.relaySend({ text: 'x', kind: 'question', ref: 'question:q-1', projectPath: PROJECT }, T0);
    fake.reply({ messageId: '999', ref: 'question:q-1', project: 'tars' }, 'Oui, pousse sur main');

    await relay.relayTick(T0 + 5_000);

    expect(got).toEqual([]);
  });

  it('8. a handler that throws does not stop the replies after it, and both are acked', async () => {
    const got: string[] = [];
    relay.onRelayReply('question', (reply) => {
      if (reply.text === 'first') throw new Error('boom');
      got.push(reply.text);
    });
    const a = await relay.relaySend({ text: 'x', kind: 'question', ref: 'question:q-1', projectPath: PROJECT }, T0);
    const b = await relay.relaySend({ text: 'y', kind: 'question', ref: 'question:q-2', projectPath: PROJECT }, T0);
    fake.reply({ messageId: (a as { messageId: string }).messageId }, 'first');
    const last = fake.reply({ messageId: (b as { messageId: string }).messageId }, 'second');

    await relay.relayTick(T0 + 5_000);

    expect(got).toEqual(['second']);
    expect(fake.acks).toContain(last);
  });
});

describe('the status', () => {
  it('7. says which: ready, Hermes down, the plugin missing, not configured on the server, the token refused, off', async () => {
    const states: Record<string, string> = {};
    for (const mode of ['ok', 'down', 'missing', 'unconfigured', 'unauthorized'] as const) {
      fake.mode = mode;
      await relay.relayTick(T0);
      states[mode] = relay.relayStatus().state;
    }
    on = false;
    await relay.relayTick(T0);
    states.off = relay.relayStatus().state;

    expect(states).toEqual({ ok: 'ready', down: 'unreachable', missing: 'plugin-missing', unconfigured: 'not-configured', unauthorized: 'unauthorized', off: 'off' });
  });

  it('7. counts what waits for Hermes', async () => {
    fake.mode = 'down';
    await relay.relaySend({ text: 'x', kind: 'report', ref: 'report:r-1', projectPath: PROJECT, expiresAt: T0 + 3_600_000 }, T0);

    expect(relay.relayStatus()).toMatchObject({ enabled: true, waiting: 1 });
  });
});

describe('a store made again', () => {
  it('11. numbering from 1 again: its replies are handed over all the same, once, across a restart too', async () => {
    const got: string[] = [];
    relay.onRelayReply('question', (reply) => { got.push(reply.text); });
    for (let i = 1; i <= 4; i++) {
      const sent = await relay.relaySend({ text: `q${i}`, kind: 'question', ref: `question:q-${i}`, projectPath: PROJECT }, T0);
      fake.reply({ messageId: (sent as { messageId: string }).messageId }, `answer ${i}`);
    }
    await relay.relayTick(T0 + 5_000);
    expect(got).toHaveLength(4);

    fake.recreate();
    const fifth = await relay.relaySend({ text: 'q5', kind: 'question', ref: 'question:q-5', projectPath: PROJECT }, T0 + 6_000);
    const seq = fake.reply({ messageId: (fifth as { messageId: string }).messageId }, 'answer 5');
    expect(seq).toBe(1);
    await relay.relayTick(T0 + 10_000);

    expect(got).toEqual(['answer 1', 'answer 2', 'answer 3', 'answer 4', 'answer 5']);
    expect(fake.replies).toEqual([]);

    // The new store's position is kept: after a restart, its reply 1 is not handed over again.
    fake.ignoreAcks = true;
    fake.reply({ messageId: (fifth as { messageId: string }).messageId }, 'answer 5, held again');
    await load();
    relay.onRelayReply('question', (reply) => { got.push(reply.text); });
    await relay.relayTick(T0 + 15_000);
    expect(got).toEqual(['answer 1', 'answer 2', 'answer 3', 'answer 4', 'answer 5', 'answer 5, held again']);
    await relay.relayTick(T0 + 20_000);
    expect(got).toHaveLength(6);
  });
});

describe('the projects "@name" may address', () => {
  it('10. are registered at the first round: the fleet\'s names that are one word, each once', async () => {
    relay.setRelayProjects(() => ['tars', '1212-Capital', 'My Project', 'a@b', 'x:y', 'esc\x1bname', 'tars']);

    await relay.relayTick(T0);

    expect(fake.projects).toEqual(['1212-Capital', 'tars']);
  });

  it('10. are told again when a project comes or goes, or the plugin has lost them, and only then', async () => {
    let names = ['tars'];
    relay.setRelayProjects(() => names);
    const posts = () => fake.calls.filter((c) => c.endsWith('/projects')).length;

    await relay.relayTick(T0);
    await relay.relayTick(T0 + 5_000);
    expect(posts()).toBe(1);

    names = ['tars', '1212-Capital'];
    await relay.relayTick(T0 + 10_000);
    expect(fake.projects).toEqual(['1212-Capital', 'tars']);

    fake.projects = ['TARS', '1212-capital'];
    await relay.relayTick(T0 + 15_000);
    expect(posts(), 'the same names in another case are the same projects').toBe(2);

    fake.projects = [];
    await relay.relayTick(T0 + 20_000);
    expect(fake.projects).toEqual(['1212-Capital', 'tars']);

    names = ['1212-Capital'];
    await relay.relayTick(T0 + 25_000);
    expect(fake.projects).toEqual(['1212-Capital']);
    expect(posts()).toBe(4);
  });

  it('10. are not registered while the relay is off', async () => {
    relay.setRelayProjects(() => ['tars']);
    on = false;

    await relay.relayTick(T0);

    expect(fake.calls).toEqual([]);
  });
});

describe('the event reports', () => {
  it('9. go through the relay while it is on, as reports under their project, and stop when it is off', async () => {
    const reports = await import('../../../electron/services/event-reports');
    await relay.relayTick(T0);
    expect(reports.reportsOn()).toBe(true);

    await relay.relayReportChannel.send('Report, project tars:\n- something', PROJECT);
    expect(fake.sends).toEqual([expect.objectContaining({ kind: 'report', ref: expect.stringMatching(/^report:/), project: 'tars' })]);
    const list = JSON.parse(fs.readFileSync(privateFile('relay-sent.json'), 'utf-8'));
    expect(list[0]).toMatchObject({ kind: 'report', projectPath: PROJECT });

    on = false;
    await relay.relayTick(T0 + 5_000);
    expect(reports.reportsOn()).toBe(false);
  });
});
