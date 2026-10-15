import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from 'vitest';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The overseer repeating its own format example instead of answering.
 *
 * The prompt shows Hermes the envelope to fill in. One turn copied the example
 * rather than filling it, which is still valid JSON, so it was accepted and
 * written to the conversation. Every turn after that was shown the placeholder
 * as something the overseer had already said, and copied it in turn: nineteen
 * consecutive turns on JeanBrasse's install, none able to recover on its own.
 *
 * So the assertions are about the two artifacts that carry the loop, not about
 * a helper returning true: what ends up in overseer.json, and what is in the
 * prompt actually handed to the gateway on the next turn.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-overseer-echo-'));

/** The dispatch port a real listener is stood up on below, so "no request was
 *  sent" is proved by a socket rather than by a spy. The system picks it when
 *  the listener starts: it was 31972, and every suite run at the same moment on
 *  this machine fought over it and failed here as `1 failed | 35 skipped`. Read
 *  when the overseer dispatches, which is after the listener is up. Never 31415,
 *  which no system hands out: a running Tars must not be reachable from here. */
let dispatchPort = 0;
vi.mock('../../../electron/constants', () => ({
  DATA_DIR: tmp,
  get API_PORT() { return dispatchPort; },
  dataPath: (f: string) => path.join(tmp, f),
  // The conversation lives outside the directory the agents are handed.
  // Both paths, because the module migrates from the old one to the new.
  privatePath: (...segments: string[]) => path.join(tmp, 'private', ...segments),
  OVERSEER_FILE: path.join(tmp, 'private', 'overseer.json'),
  OVERSEER_LEGACY_FILE: path.join(tmp, 'overseer.json'),
}));
/** Mutable so a test can move an agent and make watchTick see a fleet change. */
const agents = new Map<string, Record<string, unknown>>();
vi.mock('../../../electron/core/agent-manager', () => ({ agents }));
vi.mock('../../../electron/services/git-review', () => ({ repoSummary: async () => ({ success: false }) }));
vi.mock('../../../electron/services/hermes-config', () => ({
  usableHermesConnection: () => ({ url: 'http://gateway.test', token: 't' }),
}));
// No websocket transport, so every turn takes the cron path without first
// spending three seconds finding out there is no socket to open. That is a
// real configuration, not a shortcut: it is what an install behind a gateway
// with no live endpoint does on every turn.
vi.mock('../../../electron/services/hermes-session', () => ({
  liveTransportAvailable: () => false,
  createLiveSession: async () => { throw new Error('no live transport in tests'); },
  askLiveSession: async () => ({ ok: false, error: 'unavailable' }),
}));

const TEMPLATE = '<what you tell JeanBrasse, plain text or light markdown>';

/** What the gateway answers on the next turn. */
let nextReply = 'the fleet is quiet';
/** Every prompt Tars actually sent, in order. */
const promptsSent: string[] = [];

vi.mock('../../../electron/services/hermes-client', () => ({
  probeHermes: async () => ({ reachable: true, authRequired: false, signedIn: true }),
  createHermesCron: async () => ({ success: true, job: { id: 'job-1' } }),
  updateHermesCron: async (_conn: unknown, _id: string, patch: { prompt?: string }) => {
    if (typeof patch?.prompt === 'string') promptsSent.push(patch.prompt);
    return { success: true, job: { id: 'job-1' } };
  },
  hermesCronAction: async () => ({ success: true }),
  fetchHermesCronRuns: async () => {
    const t = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_');
    return { success: true, runs: [{ id: `cron_job-1_${t.slice(0, 8)}_${t.slice(9, 15)}` }] };
  },
  fetchHermesSessionMessages: async () => ({
    success: true,
    messages: [{ role: 'assistant', content: nextReply }],
  }),
  fetchHermesModelOptions: async () => ({ success: true, provider: '', model: '', providers: [] }),
  setHermesModel: async () => ({ success: true }),
}));

const OVERSEER_FILE = path.join(tmp, 'private', 'overseer.json');
// The module writes there through writeSecretFileSync, which creates the
// directory; a test that seeds the file by hand has to exist first.
fs.mkdirSync(path.dirname(OVERSEER_FILE), { recursive: true });
let overseer: typeof import('../../../electron/services/overseer');

/** The conversation section alone, which is what conditions the reply. The
 *  instructions carry the bracketed shape on purpose, so asserting against
 *  the whole prompt would be asserting against the template itself. */
function conversationOf(prompt: string): string {
  const from = prompt.indexOf('=== CONVERSATION SO FAR');
  const to = prompt.indexOf('=== FLEET SNAPSHOT');
  expect(from, 'no conversation section').toBeGreaterThan(-1);
  expect(to, 'the snapshot does not follow the conversation').toBeGreaterThan(from);
  return prompt.slice(from, to);
}

/** The conversation as it is on disk, which is what conditions the next turn. */
function persisted(): { role: string; text: string }[] {
  if (!fs.existsSync(OVERSEER_FILE)) return [];
  return JSON.parse(fs.readFileSync(OVERSEER_FILE, 'utf-8')).messages ?? [];
}

function seed(messages: { role: string; text: string }[]): void {
  fs.writeFileSync(OVERSEER_FILE, JSON.stringify({
    jobId: 'job-1',
    messages: messages.map((m, i) => ({
      id: `seed-${i}`,
      role: m.role,
      text: m.text,
      action: null,
      timestamp: new Date().toISOString(),
    })),
    previousSnapshot: null,
    longRunningReported: [],
    paused: false,
  }, null, 2));
}

/** Everything that actually reached the dispatch endpoint. */
const dispatched: { url: string; body: string }[] = [];
let dispatchServer: http.Server;

beforeAll(async () => {
  dispatchServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      dispatched.push({ url: req.url ?? '', body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode: 'pty' }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    dispatchServer.once('error', reject);
    dispatchServer.listen(0, '127.0.0.1', () => resolve());
  });
  dispatchPort = (dispatchServer.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>(r => { dispatchServer.close(() => r()); });
});

/** A conversation holding one reply that carries a proposal to message a1. */
function seedWithAction(
  replyText: string,
  actionId: string,
  stored: { agentId?: string; text?: string } = {},
): Record<string, unknown> {
  const action = {
    actionId,
    agentId: stored.agentId ?? 'a1',
    agentName: 'Frontend',
    projectPath: '/tars',
    provider: 'claude',
    pane: 'live pane',
    text: stored.text ?? 'rm -rf / --no-preserve-root',
    resolvedAt: new Date().toISOString(),
  };
  fs.writeFileSync(OVERSEER_FILE, JSON.stringify({
    jobId: 'job-1',
    messages: [{
      id: 'm1', role: 'overseer', text: replyText, action,
      timestamp: new Date().toISOString(),
    }],
    previousSnapshot: null,
    longRunningReported: [],
    paused: false,
  }, null, 2));
  return action;
}

function putAgent(status: string, id = 'a1'): void {
  agents.set(id, {
    id, name: 'Frontend', projectPath: '/tars', provider: 'claude',
    status, output: [], lastCleanOutput: '', currentTask: 'the sidebar',
  });
}

beforeEach(async () => {
  agents.clear();
  dispatched.length = 0;
  promptsSent.length = 0;
  nextReply = 'the fleet is quiet';
  if (fs.existsSync(OVERSEER_FILE)) fs.rmSync(OVERSEER_FILE);
  vi.resetModules();
  overseer = await import('../../../electron/services/overseer');
});

describe('a reply that is the format template', () => {
  it('never reaches the conversation, and never leaves JeanBrasse with nothing', async () => {
    nextReply = JSON.stringify({ say: TEMPLATE, action: null });

    const result = await overseer.askOverseer('salut');

    // This used to return an error and write nothing, which meant an empty
    // thread and a toast. He asked a question, so he gets an answer.
    expect(result.ok).toBe(true);
    expect(persisted().map(m => m.role)).toEqual(['user', 'overseer']);
    // What he gets says what happened. What Hermes actually sent does not go
    // in: the template in a message would be folded away as an echo itself.
    expect(result.ok && result.message.text).toMatch(/instead of an answer/i);
    expect(JSON.stringify(persisted())).not.toContain('what you tell JeanBrasse');
  }, 30000);

  it('leaves the next turn free to answer properly', async () => {
    nextReply = JSON.stringify({ say: TEMPLATE, action: null });
    await overseer.askOverseer('salut');

    nextReply = JSON.stringify({ say: 'Frontend is waiting on you.', action: null });
    const second = await overseer.askOverseer('et maintenant?');

    expect(second.ok).toBe(true);
    // The refused turn left nothing behind for this one to copy.
    expect(promptsSent[promptsSent.length - 1]).not.toContain('OVERSEER: <what you tell JeanBrasse');
    const texts = persisted().map(m => m.text);
    expect(texts).toContain('Frontend is waiting on you.');
    expect(texts).not.toContain(TEMPLATE);
  }, 30000);

  it('catches the bare gateway sentinel too', async () => {
    // Not JSON and not in the repo: the gateway's own "produce no output"
    // marker, which used to be shown to JeanBrasse as if it were a message.
    nextReply = '[SILENT]';

    const result = await overseer.askOverseer('salut');

    expect(result.ok).toBe(true);
    expect(result.ok && result.message.text).toMatch(/instead of an answer/i);
    expect(persisted().map(m => m.text)).not.toContain('[SILENT]');
  }, 30000);

  it('does not refuse a real answer that happens to use angle brackets', async () => {
    const real = 'Backend printed `a < b && c > d` in its output, which is the comparison that fails.';
    nextReply = JSON.stringify({ say: real, action: null });

    const result = await overseer.askOverseer('salut');

    expect(result.ok).toBe(true);
    expect(persisted().map(m => m.text)).toContain(real);
  }, 30000);
});

describe('a conversation that is already poisoned', () => {
  /** JeanBrasse's file: two real answers, then the echo on every turn after. */
  const poisoned = [
    { role: 'user', text: 'salut' },
    { role: 'overseer', text: 'Salut JeanBrasse. Rien de bloque, mais un agent t attend.' },
    ...Array.from({ length: 17 }, () => ({ role: 'overseer', text: TEMPLATE })),
    { role: 'user', text: 'ca dit quoi?' },
  ];

  it('is flagged on read, never deleted from disk', async () => {
    seed(poisoned);

    const history = overseer.getOverseerHistory();

    // Every message is still there. An earlier version of this fix dropped
    // them and rewrote the file, which meant every mistake the rule made was
    // permanent data loss; the rule is allowed to be wrong, not to destroy.
    expect(history).toHaveLength(poisoned.length);
    expect(history.filter(m => m.templateEcho)).toHaveLength(17);
    expect(persisted()).toHaveLength(poisoned.length);
    expect(fs.readFileSync(OVERSEER_FILE, 'utf-8')).toContain('what you tell JeanBrasse');
  });

  it('flags only the echoes, and never a real message', async () => {
    seed(poisoned);

    const flagged = overseer.getOverseerHistory().filter(m => m.templateEcho).map(m => m.text);

    expect(new Set(flagged)).toEqual(new Set([TEMPLATE]));
  });

  it('leaves the file untouched even after a full turn runs against it', async () => {
    seed(poisoned);
    const before = fs.readFileSync(OVERSEER_FILE, 'utf-8');
    expect((before.match(/what you tell JeanBrasse/g) || []).length).toBe(17);

    nextReply = JSON.stringify({ say: 'Frontend is waiting on you.', action: null });
    await overseer.askOverseer('et maintenant?');

    const after = fs.readFileSync(OVERSEER_FILE, 'utf-8');
    // The turn appended; it did not prune.
    expect((after.match(/what you tell JeanBrasse/g) || []).length).toBe(17);
    expect(persisted()).toHaveLength(poisoned.length + 2);
  }, 30000);

  it('keeps the real answers it is sitting between', async () => {
    seed(poisoned);

    const texts = overseer.getOverseerHistory().map(m => m.text);

    expect(texts).toContain('Salut JeanBrasse. Rien de bloque, mais un agent t attend.');
    expect(texts).toContain('salut');
    expect(texts).toContain('ca dit quoi?');
  });

  it('never quotes the echo back to the model as an example to follow', async () => {
    seed(poisoned);

    await overseer.askOverseer('et maintenant?');

    const conversation = conversationOf(promptsSent[promptsSent.length - 1]);
    // The conversation section is what conditions the reply. The 17 echoes
    // must not appear in it under any speaker.
    expect(conversation).not.toContain(TEMPLATE);
    // The real turns still do, or the fix would have cost the context.
    expect(conversation).toContain('Salut JeanBrasse. Rien de bloque');
  }, 30000);

  /**
   * This asserted the opposite a day ago, and the reversal is deliberate.
   *
   * The example was filled in with a plausible sentence so that copying it
   * would be less tempting. The model copied it anyway, and because it read
   * as a real observation nothing could tell: it went out a hundred and
   * seventy eight times over a day. A bracketed hole is copied just as
   * readily and is copied visibly, which isTemplateEcho then catches. Make
   * the failure detectable rather than betting on it not happening.
   */
  /**
   * This has now asserted three different things, and the third is the one
   * that follows from what actually happened. A blank specimen was copied. A
   * filled in one was copied, and worse, because it read as a real
   * observation. So there is no specimen: the object is described in words and
   * there is nothing in the instructions to return unchanged.
   */
  it('shows no specimen of the reply object at all', async () => {
    await overseer.askOverseer('salut');

    const prompt = promptsSent[promptsSent.length - 1];
    const instructions = prompt.slice(0, prompt.indexOf('=== CONVERSATION SO FAR'));

    // The contract is still stated, in prose.
    expect(instructions).toContain('"say"');
    expect(instructions).toContain('"action"');
    // But nothing in it is a ready made answer.
    expect(instructions).not.toContain('{"say"');
    expect(instructions).not.toMatch(/<what you tell JeanBrasse/);
    expect(instructions).not.toMatch(/<id from the snapshot>/);
    // The old ones are still recognised, for conversations already holding them.
    expect(overseer.isTemplateEcho('<what you tell JeanBrasse, plain text or light markdown>')).toBe(true);
  }, 30000);
});

describe("short messages that carry brackets but are not templates", () => {
  /**
   * Every one of these was destroyed by the first version of this fix. They
   * are the class the original guard never considered: real messages that are
   * short AND bracketed, where the earlier "at least twelve surviving
   * characters" rule left between four and ten and called them templates.
   */
  const REAL = [
    '[API] down.',
    '[URGENT] Build KO.',
    '[MERGED] feat/qa.',
    '[IMPORTANT] QA a fini.',
    '[URGENT] Frontend KO.',
    'Wrap it in <div>.',
    'Use Map<string, Agent>.',
    'Fix: a < b, not a > b.',
    'Voir <https://example.com/docs>.',
  ];

  it('survive on disk, unflagged, when they are already in the conversation', async () => {
    seed(REAL.map(text => ({ role: 'overseer', text })));

    const history = overseer.getOverseerHistory();

    expect(history).toHaveLength(REAL.length);
    expect(history.filter(m => m.templateEcho)).toHaveLength(0);
    expect(history.map(m => m.text)).toEqual(REAL);
  });

  it('are still quoted back to the model, because they are context', async () => {
    seed(REAL.map(text => ({ role: 'overseer', text })));

    await overseer.askOverseer('et maintenant?');

    const prompt = promptsSent[promptsSent.length - 1];
    for (const text of REAL) expect(prompt).toContain(text);
  }, 30000);

  it('are judged one by one, and none of them reads as a template', () => {
    for (const text of REAL) {
      expect(overseer.isTemplateEcho(text), `wrongly refused: ${text}`).toBe(false);
    }
    // And the shapes that are templates still are, so this is not the rule
    // having simply been switched off.
    expect(overseer.isTemplateEcho(TEMPLATE)).toBe(true);
    expect(overseer.isTemplateEcho('[SILENT]')).toBe(true);
    expect(overseer.isTemplateEcho('<...>')).toBe(true);
  });

  it('are accepted and recorded when Hermes sends one as its answer', async () => {
    // One full turn rather than nine: the other nine paths are already driven
    // end to end by the two tests above, which read and serialize all of them.
    nextReply = JSON.stringify({ say: '[URGENT] Build KO.', action: null });

    const result = await overseer.askOverseer('salut');

    expect(result.ok).toBe(true);
    expect(persisted().map(m => m.text)).toContain('[URGENT] Build KO.');
  }, 30000);
});

describe('a refusal during an automatic check-in', () => {
  /**
   * Two ticks: the first only records a baseline, the second sees the move.
   * It has to end on `waiting`, because a fleet diff only raises a note for a
   * transition into waiting, completed or error.
   */
  async function tickTwice(): Promise<void> {
    putAgent('running');
    await overseer.watchTick();
    putAgent('waiting');
    await overseer.watchTick();
  }

  it('is recorded and readable instead of vanishing', async () => {
    nextReply = JSON.stringify({ say: TEMPLATE, action: null });

    await tickTwice();

    // Nobody is waiting on a briefing, so a plain null here was a cycle that
    // failed every five minutes with nothing anywhere to show for it.
    const failure = overseer.getLastWatchFailure();
    expect(failure).not.toBeNull();
    expect(failure?.error).toMatch(/template/i);
    expect(failure?.at).toBeTypeOf('string');
    // Still nothing written, which is the other half of the contract.
    expect(persisted()).toHaveLength(0);
  }, 40000);

  it('is cleared by the next check-in that works', async () => {
    nextReply = JSON.stringify({ say: TEMPLATE, action: null });
    await tickTwice();
    expect(overseer.getLastWatchFailure()).not.toBeNull();

    nextReply = JSON.stringify({ say: 'Frontend went idle.', action: null });
    await tickTwice();

    expect(overseer.getLastWatchFailure()).toBeNull();
  }, 40000);
});

/**
 * A guard that leaves the user with nothing has not protected anybody.
 *
 * Shipped in 1.6.18: Hermes kept returning the template, the guard correctly
 * refused it, and JeanBrasse got "la page chat ne fonctionne pas, aucun message" plus
 * an error toast every time he wrote. A visibly wrong answer had been turned
 * into no answer, which is the failure this codebase has spent days removing
 * from everywhere else. The refusal was right; stopping there was not.
 */
describe('a question that Hermes answers with the template', () => {
  it('is answered anyway, with something a person can act on', async () => {
    nextReply = JSON.stringify({ say: TEMPLATE, action: null });

    const result = await overseer.askOverseer('ca dit quoi?');

    expect(result.ok).toBe(true);
    const text = result.ok ? result.message.text : '';
    expect(text.length).toBeGreaterThan(40);
    // It says what happened and what to do about it, not just that something
    // failed: the cause is almost always the model the gateway is running.
    expect(text).toMatch(/instead of an answer/i);
    expect(text).toMatch(/model/i);
  }, 30000);

  it('leaves a thread with something in it, not an empty page', async () => {
    nextReply = JSON.stringify({ say: TEMPLATE, action: null });

    await overseer.askOverseer('ca dit quoi?');

    const thread = persisted();
    expect(thread).toHaveLength(2);
    expect(thread[1].role).toBe('overseer');
    expect(thread[1].text.trim().length).toBeGreaterThan(0);
  }, 30000);

  it('writes a message the thread will actually show', async () => {
    nextReply = JSON.stringify({ say: TEMPLATE, action: null });

    const result = await overseer.askOverseer('ca dit quoi?');

    // The thread folds anything flagged as an echo. A notice that quoted the
    // template would be flagged itself, so the one line written to stop the
    // page being empty would be the one line the page hides.
    expect(overseer.isTemplateEcho(result.ok ? result.message.text : '')).toBe(false);
  }, 30000);

  it('carries no proposal out of a reply that observed nothing', async () => {
    putAgent('waiting');
    nextReply = JSON.stringify({
      say: TEMPLATE,
      action: { kind: 'message_agent', agent_id: 'a1', text: 'do the thing' },
    });

    const result = await overseer.askOverseer('ca dit quoi?');

    expect(result.ok).toBe(true);
    expect(result.ok && result.message.action).toBeNull();
    expect(dispatched).toEqual([]);
  }, 30000);

  it('says nothing at all when it is a check-in nobody asked for', async () => {
    nextReply = JSON.stringify({ say: TEMPLATE, action: null });

    const result = await overseer.askOverseer('fleet change', { isBriefing: true });

    // Nobody is waiting, so a notice would just be noise in the thread.
    expect(result.ok).toBe(false);
    expect(persisted()).toEqual([]);
  }, 30000);

  it('does not let the notice become the next turn\'s example', async () => {
    nextReply = JSON.stringify({ say: TEMPLATE, action: null });
    await overseer.askOverseer('ca dit quoi?');

    nextReply = JSON.stringify({ say: 'Frontend is waiting on the sidebar width.', action: null });
    await overseer.askOverseer('et maintenant?');

    // The loop stays shut: whatever Hermes returned is not in the prompt, and
    // the notice that replaced it is a Tars line, not an observation to copy.
    const conversation = conversationOf(promptsSent[promptsSent.length - 1]);
    expect(conversation).not.toContain('what you tell JeanBrasse');
  }, 30000);
});

describe('the proposal attached to a reply', () => {
  /**
   * The write door. confirmPendingAction used to take the action object it was
   * handed at its word, so a proposal still attached to a template reply, of
   * which there are some on disk from before those were refused, would be
   * dispatched by anything that offered it. The renderer no longer offers one,
   * but the write happens here, so the check has to be here.
   *
   * The listener stood up in beforeAll is the assertion: a POST that goes out
   * is recorded, so "it was not sent" is a socket that stayed quiet, not a
   * function that returned false.
   */
  it('is sent when the reply is a real answer', async () => {
    putAgent('waiting');
    const action = seedWithAction('Backend has retried the same test three times.', 'act-good');

    const result = await overseer.confirmPendingAction(action as never, true);

    // The control. Without it, "nothing was dispatched" below could be a test
    // that is simply unable to dispatch anything at all.
    expect(result.success).toBe(true);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].url).toContain('/api/agents/a1/dispatch');
  });

  it('is refused when the reply was the format template, and nothing is sent', async () => {
    putAgent('waiting');
    const action = seedWithAction(TEMPLATE, 'act-echo');

    const result = await overseer.confirmPendingAction(action as never, true);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/template/i);
    // The point of the whole test: no request left this process.
    expect(dispatched).toEqual([]);
  });

  it('is sent as the conversation stored it, not as the caller re-describes it', async () => {
    putAgent('waiting', 'a1');
    putAgent('waiting', 'a2');
    seedWithAction(
      'Backend has retried the same test three times.',
      'act-real',
      { agentId: 'a1', text: 'Can you rebase onto main?' },
    );

    // A perfectly valid id, and everything else swapped underneath it. Only
    // the id was ever checked against the conversation, so dispatching the
    // caller's object sent a target and a body nobody had ever proposed.
    const tampered = {
      actionId: 'act-real', agentId: 'a2', agentName: 'Frontend',
      projectPath: '/tars', provider: 'claude', pane: 'live pane',
      text: 'rm -rf / --no-preserve-root', resolvedAt: new Date().toISOString(),
    };
    const result = await overseer.confirmPendingAction(tampered as never, true);

    expect(result.success).toBe(true);
    expect(dispatched).toHaveLength(1);
    // The stored proposal went out, whole: the agent the overseer named and
    // the words JeanBrasse was shown.
    expect(dispatched[0].url).toContain('/api/agents/a1/dispatch');
    expect(JSON.parse(dispatched[0].body)).toEqual({ message: 'Can you rebase onto main?' });
    // And nothing the caller substituted reached the wire.
    expect(dispatched[0].url).not.toContain('a2');
    expect(dispatched[0].body).not.toContain('rm -rf');
  });

  it('is refused when the conversation does not carry it at all', async () => {
    putAgent('waiting');
    seedWithAction('Backend has retried the same test three times.', 'act-good');

    const forged = {
      actionId: 'act-never-proposed', agentId: 'a1', agentName: 'Frontend',
      projectPath: '/tars', provider: 'claude', pane: 'live pane',
      text: 'rm -rf / --no-preserve-root', resolvedAt: new Date().toISOString(),
    };
    const result = await overseer.confirmPendingAction(forged as never, true);

    expect(result.success).toBe(false);
    expect(dispatched).toEqual([]);
  });

  it('still refuses the echo when the caller declines rather than approves', async () => {
    putAgent('waiting');
    const action = seedWithAction(TEMPLATE, 'act-echo-2');

    const result = await overseer.confirmPendingAction(action as never, false);

    expect(result.success).toBe(false);
    expect(dispatched).toEqual([]);
  });
});

describe('a template wrapped in a few words of its own', () => {
  const WRAPPED = 'Voici ma reponse: <what you tell JeanBrasse, plain text or light markdown>.';

  it('does not reach the conversation, and still answers JeanBrasse', async () => {
    nextReply = JSON.stringify({ say: WRAPPED, action: null });

    const result = await overseer.askOverseer('salut');

    expect(result.ok).toBe(true);
    expect(result.ok && result.message.text).toMatch(/instead of an answer/i);
    expect(JSON.stringify(persisted())).not.toContain('what you tell JeanBrasse');
  }, 30000);

  it('is never quoted back to the model when it is already on disk', async () => {
    seed([
      { role: 'user', text: 'salut' },
      { role: 'overseer', text: WRAPPED },
      { role: 'overseer', text: 'Frontend is waiting on you.' },
    ]);

    await overseer.askOverseer('et maintenant?');

    const conversation = conversationOf(promptsSent[promptsSent.length - 1]);
    // The conversation, not the whole prompt: the instructions carry the
    // bracketed shape deliberately, so that a copy of it is recognisable.
    expect(conversation).not.toContain(TEMPLATE);
    expect(conversation).not.toContain('what you tell JeanBrasse');
    expect(conversation).toContain('Frontend is waiting on you.');
  }, 30000);

  it('covers every placeholder this app has ever shown the model', () => {
    for (const token of ['<what you tell JeanBrasse, plain text or light markdown>', '<id from the snapshot>', '<the exact message to send>', '<...>']) {
      expect(overseer.isTemplateEcho(`Reponse: ${token} voila.`), token).toBe(true);
    }
  });
});

describe('a short reply that is only a label and a sign', () => {
  it('keeps an emoji, which is an answer', () => {
    expect(overseer.isTemplateEcho('[DONE] \u{1F44D}')).toBe(false);
  });

  it('still folds one that is only punctuation', () => {
    expect(overseer.isTemplateEcho('[DONE] !!!')).toBe(true);
  });
});

describe('clearing the conversation', () => {
  it('empties it and says how much it dropped, keeping the settings', async () => {
    seed([
      { role: 'user', text: 'salut' },
      { role: 'overseer', text: 'Frontend is waiting on you.' },
    ]);
    overseer.setOverseerSettings({ watchIntervalMs: 900_000, provider: 'anthropic', model: 'claude-opus-5' });

    expect(overseer.clearOverseerHistory()).toEqual({ cleared: 2 });

    expect(overseer.getOverseerHistory()).toEqual([]);
    expect(overseer.getOverseerSettings()).toMatchObject({
      watchIntervalMs: 900_000,
      provider: 'anthropic',
      model: 'claude-opus-5',
    });
  });

  it('is a no-op on an empty conversation', () => {
    expect(overseer.clearOverseerHistory()).toEqual({ cleared: 0 });
  });
});
