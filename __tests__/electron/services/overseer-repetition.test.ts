import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The overseer saying one thing for a day.
 *
 * Yesterday's fix stopped it copying the bracketed placeholder out of its own
 * prompt. What it did next was copy the filled in example that replaced the
 * placeholder, a plausible sentence about a sidebar width, and say that a
 * hundred and seventy eight times over twenty one hours, including straight
 * back at JeanBrasse every time he tried to talk to it. Every guard passed, because
 * every guard was about a shape of text and the problem is a behaviour.
 *
 * The fixture has the shape of JeanBrasse's real conversation and none of its
 * words (since 2026-10-17): the same turns in the same order, the stuck
 * sentence and the placeholder echoes where they were, and each check-in on
 * the same side of the 30-minute window as before. The user's lines and the
 * overseer's few real answers are invented. These assert that it comes
 * unstuck, and that a healthy conversation is untouched, rather than that some
 * helper rejects one particular sentence.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-overseer-rep-'));

vi.mock('../../../electron/constants', () => ({
  DATA_DIR: tmp,
  API_PORT: 31973,
  dataPath: (f: string) => path.join(tmp, f),
  // The conversation lives outside the directory the agents are handed.
  // Both paths, because the module migrates from the old one to the new.
  privatePath: (...segments: string[]) => path.join(tmp, 'private', ...segments),
  OVERSEER_FILE: path.join(tmp, 'private', 'overseer.json'),
  OVERSEER_LEGACY_FILE: path.join(tmp, 'overseer.json'),
}));
const agents = new Map<string, Record<string, unknown>>();
vi.mock('../../../electron/core/agent-manager', () => ({ agents }));
vi.mock('../../../electron/services/git-review', () => ({ repoSummary: async () => ({ success: false }) }));
vi.mock('../../../electron/services/hermes-config', () => ({
  usableHermesConnection: () => ({ url: 'http://gateway.test', token: 't' }),
}));
// The live conversation, a fake answering every turn with nextReply: an
// automatic check-in never runs the cron job, each of whose runs is a Hermes
// session of its own (hermes-one-session.test.ts).
vi.mock('../../../electron/services/hermes-session', () => ({
  liveTransportAvailable: () => true,
  conversationRefused: () => false,
  openConversation: async () => ({
    session: { sessionId: 'live-1', storedSessionId: 'stored-1' },
    closed: false,
    ask: async (prompt: string) => { promptsSent.push(prompt); return { ok: true, text: nextReply }; },
    close: () => {},
  }),
}));

/** The sentence JeanBrasse watched for a day. It is the example composeTurn used. */
const STUCK = 'Frontend has been waiting on your answer about the sidebar width for eleven minutes. Nothing else is blocked.';

let nextReply = 'the fleet is quiet';
const promptsSent: string[] = [];

vi.mock('../../../electron/services/hermes-client', () => ({
  probeHermes: async () => ({ reachable: true, authRequired: false, signedIn: true }),
  createHermesCron: async () => ({ success: true, job: { id: 'job-1' } }),
  updateHermesCron: async (_c: unknown, _id: string, patch: { prompt?: string }) => {
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
const FIXTURE = path.join(__dirname, '../../fixtures/overseer-repetition.json');
let overseer: typeof import('../../../electron/services/overseer');

function persisted(): { role: string; text: string }[] {
  if (!fs.existsSync(OVERSEER_FILE)) return [];
  return JSON.parse(fs.readFileSync(OVERSEER_FILE, 'utf-8')).messages ?? [];
}

/** The conversation, as the fixture holds it. */
function seedUsersConversation(): void {
  fs.copyFileSync(FIXTURE, OVERSEER_FILE);
}

/**
 * The same conversation with the stuck sentence swapped for one nothing knows
 * about.
 *
 * His actual sentence is now refused by name, because it was the example
 * composeTurn used to print. That fixes his install and fixes nothing else:
 * the next lock-up will be on a sentence the model wrote itself. So the shape
 * of his conversation, a hundred and seventy eight of one thing, is replayed
 * with text no rule can have heard of, and the assertions about repetition
 * are made against that.
 */
const NOVEL = 'The migration branch has been green for a while and nobody has merged it yet.';

function seedTheSameShapeWithNewWords(): void {
  const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
  raw.messages = raw.messages.map((m: { text: string }) => (
    m.text === STUCK ? { ...m, text: NOVEL } : m
  ));
  // The fixture's turns are weeks old. The last turn is stamped as just now,
  // which is how the loop looked while JeanBrasse was watching it: the newest repeat
  // had arrived minutes ago.
  const last = raw.messages[raw.messages.length - 1];
  last.timestamp = new Date().toISOString();
  last.isBriefing = true;
  fs.writeFileSync(OVERSEER_FILE, JSON.stringify(raw, null, 1));
}

function seed(messages: { role: string; text: string }[]): void {
  fs.writeFileSync(OVERSEER_FILE, JSON.stringify({
    jobId: 'job-1',
    messages: messages.map((m, i) => ({
      id: `seed-${i}`, role: m.role, text: m.text, action: null,
      timestamp: new Date().toISOString(),
    })),
    previousSnapshot: null, longRunningReported: [], paused: false,
  }, null, 2));
}

/** The conversation section of the prompt actually sent to the gateway. */
function conversationSent(): string {
  const prompt = promptsSent[promptsSent.length - 1];
  expect(prompt, 'no prompt was sent').toBeTypeOf('string');
  const from = prompt.indexOf('=== CONVERSATION SO FAR');
  const to = prompt.indexOf('=== FLEET SNAPSHOT');
  // Guarded, so a prompt whose sections are the other way round yields an
  // empty string and quietly satisfies every assertion made about it.
  expect(from, 'no conversation section').toBeGreaterThan(-1);
  expect(to, 'the snapshot does not follow the conversation').toBeGreaterThan(from);
  return prompt.slice(from, to);
}

function putAgent(status: string, id = 'a1'): void {
  agents.set(id, {
    id, name: 'Frontend', projectPath: '/tars', provider: 'claude',
    status, output: [], lastCleanOutput: '', currentTask: 'the sidebar',
  });
}

beforeEach(async () => {
  agents.clear();
  promptsSent.length = 0;
  nextReply = 'the fleet is quiet';
  if (fs.existsSync(OVERSEER_FILE)) fs.rmSync(OVERSEER_FILE);
  vi.resetModules();
  overseer = await import('../../../electron/services/overseer');
});

describe("JeanBrasse's stuck conversation", () => {
  it('really is stuck, which is the precondition for the rest', () => {
    seedUsersConversation();
    const texts = persisted().filter(m => m.role === 'overseer').map(m => m.text);

    expect(texts.filter(t => t === STUCK).length).toBeGreaterThan(150);
  });

  it('stops being recited back to the model', async () => {
    seedUsersConversation();

    await overseer.askOverseer('ca dit quoi?');

    const conversation = conversationSent();
    const occurrences = conversation.split(STUCK).length - 1;
    // Once, as context, instead of the twenty four the window used to carry.
    expect(occurrences).toBeLessThanOrEqual(1);
  }, 30000);

  it('is told, in the prompt, that it already said that', async () => {
    // The same lock-up, on words no rule has ever seen. This is the class,
    // and it is the half that will still hold the next time the model picks
    // a sentence of its own to get stuck on.
    seedTheSameShapeWithNewWords();

    await overseer.askOverseer('ca dit quoi?');

    const conversation = conversationSent();
    expect(conversation).toMatch(/said that again \d+ more time\(s\)/);
    expect(conversation.split(NOVEL).length - 1).toBe(1);
  }, 30000);

  it('refuses to check in with an unknown sentence it just said, too', async () => {
    seedTheSameShapeWithNewWords();
    nextReply = JSON.stringify({ say: NOVEL, action: null });

    const result = await overseer.askOverseer('fleet change', { isBriefing: true });

    expect(result.ok).toBe(false);
    expect(persisted().filter(m => m.text === NOVEL).length).toBeGreaterThan(150);
  }, 30000);

  it('loses nothing from the disk in the process', async () => {
    seedUsersConversation();
    const before = persisted().length;

    await overseer.askOverseer('ca dit quoi?');

    // The user's own turns and every overseer reply are still there: the
    // repetition is filtered on the way into the prompt, never deleted.
    expect(persisted().length).toBe(before + 2);
    expect(persisted().filter(m => m.text === STUCK).length).toBeGreaterThan(150);
  }, 30000);

  it('does not record the same answer once more, and says so instead', async () => {
    seedUsersConversation();
    nextReply = JSON.stringify({ say: STUCK, action: null });

    const result = await overseer.askOverseer('ca dit quoi?');

    // The sentence is one of the examples the prompt used to print, so it is
    // refused by name. He asked a question, so he is told that rather than
    // being left with an empty thread.
    expect(result.ok).toBe(true);
    expect(result.ok && result.message.text).toMatch(/instead of an answer/i);
    // And the count does not grow: the repeat itself is still not written.
    expect(persisted().filter(m => m.text === STUCK).length).toBeGreaterThan(150);
    expect(persisted().filter(m => m.text === STUCK).length).toBeLessThan(200);
  }, 30000);

  it('accepts a genuinely new answer on the very next turn', async () => {
    seedUsersConversation();
    nextReply = JSON.stringify({ say: 'Backend errored on the schema migration ten minutes ago and nothing has picked it up.', action: null });

    const result = await overseer.askOverseer('ca dit quoi?');

    expect(result.ok).toBe(true);
    expect(persisted().map(m => m.text)).toContain(
      'Backend errored on the schema migration ten minutes ago and nothing has picked it up.',
    );
  }, 30000);
});

describe('a repetition that is not word for word', () => {
  it('is still the same repetition when only a number moved', async () => {
    seed([
      { role: 'user', text: 'salut' },
      { role: 'overseer', text: 'Frontend has been waiting for eleven minutes.' },
    ]);
    nextReply = JSON.stringify({ say: 'Frontend has been waiting for twelve minutes.', action: null });

    const result = await overseer.askOverseer('fleet change', { isBriefing: true });

    expect(result.ok).toBe(false);
  }, 30000);

  it('is still the same repetition when the number is spelled differently', () => {
    expect(overseer.isSameThingSaidAgain(
      'Frontend has been waiting for eleven minutes.',
      'Frontend has been waiting for 11 minutes.',
    )).toBe(true);
  });
});

describe('an overseer that is still allowed to talk', () => {
  it('says something new when something new happened', async () => {
    seed([
      { role: 'overseer', text: 'Frontend is waiting on the sidebar width.' },
    ]);
    nextReply = JSON.stringify({ say: 'QA has errored on the migration test, and Frontend is still waiting.', action: null });

    const result = await overseer.askOverseer('et maintenant?');

    expect(result.ok).toBe(true);
  }, 30000);

  it('may repeat an observation that is separated by a different one', async () => {
    // Still blocked an hour later is worth saying again. Only the reply that
    // directly follows an identical one is refused.
    seed([
      { role: 'overseer', text: 'Frontend is waiting on the sidebar width.' },
      { role: 'overseer', text: 'QA has errored on the migration test.' },
    ]);
    nextReply = JSON.stringify({ say: 'Frontend is waiting on the sidebar width.', action: null });

    const result = await overseer.askOverseer('et maintenant?');

    expect(result.ok).toBe(true);
  }, 30000);

  it('keeps a healthy conversation intact in the prompt', async () => {
    const healthy = [
      { role: 'user', text: 'salut' },
      { role: 'overseer', text: 'Frontend is waiting on the sidebar width.' },
      { role: 'user', text: 'et backend?' },
      { role: 'overseer', text: 'Backend is midway through the schema migration.' },
      { role: 'user', text: 'et QA?' },
      { role: 'overseer', text: 'QA has errored on the migration test.' },
    ];
    seed(healthy);

    await overseer.askOverseer('ca dit quoi?');

    const conversation = conversationSent();
    for (const m of healthy) expect(conversation).toContain(m.text);
    expect(conversation).not.toMatch(/said that again/);
  }, 30000);
});

describe('the fleet as it is now', () => {
  it('is put after the conversation, so it reads last before the question', async () => {
    seedUsersConversation();
    putAgent('running');

    await overseer.askOverseer('ca dit quoi?');

    const prompt = promptsSent[promptsSent.length - 1];
    // A day of history used to sit between the snapshot and the question.
    expect(prompt.indexOf('=== FLEET SNAPSHOT')).toBeGreaterThan(prompt.indexOf('=== CONVERSATION SO FAR'));
    expect(prompt.indexOf('=== FLEET SNAPSHOT')).toBeLessThan(prompt.indexOf('=== USER ==='));
  }, 30000);

  it('is labelled as now, and the conversation as the past', async () => {
    seed([{ role: 'overseer', text: 'Frontend is waiting.' }]);

    await overseer.askOverseer('ca dit quoi?');

    const prompt = promptsSent[promptsSent.length - 1];
    expect(prompt).toMatch(/FLEET SNAPSHOT \(the fleet as it is right now/);
    expect(prompt).toMatch(/CONVERSATION SO FAR \(what was already said/);
  }, 30000);
});

describe('the example in the prompt', () => {
  it('is not there at all any more', async () => {
    seed([{ role: 'overseer', text: 'Frontend is waiting.' }]);

    await overseer.askOverseer('ca dit quoi?');

    const prompt = promptsSent[promptsSent.length - 1];
    const instructions = prompt.slice(0, prompt.indexOf('=== CONVERSATION SO FAR'));
    // Filled in, it was copied and read as an observation. Blank, it was
    // copied and read as gibberish. Neither shape is the problem: having
    // something there to copy is.
    expect(instructions).not.toContain('sidebar width for eleven minutes');
    expect(instructions).not.toContain('{"say"');
    expect(instructions).not.toContain('<what you tell JeanBrasse');
  }, 30000);

  it('is refused if it comes back anyway', () => {
    expect(overseer.isTemplateEcho(STUCK)).toBe(true);
    expect(overseer.isTemplateEcho(
      'Backend has retried the same failing test three times without changing anything. Worth asking it.',
    )).toBe(true);
    // And a real sentence of the same shape is not.
    expect(overseer.isTemplateEcho('Frontend is waiting on the sidebar width.')).toBe(false);
  });
});

/**
 * Where the line actually falls, measured rather than assumed.
 *
 * It has moved since this was first pinned, in two directions, and both moves
 * are the point of the change. The refusal now applies only to a check-in
 * nobody asked for, and only while the thing it repeats is recent. A question
 * from JeanBrasse always gets an answer, because handing him an error instead is the
 * exact thing he could not get past, and the same answer to the same question
 * is an answer when nothing has moved.
 */
describe('the repetition boundary', () => {
  const X = 'Frontend is still blocked on the sidebar width and nobody has answered.';
  const Y = 'Backend finished the usage backfill a moment ago.';

  /** One overseer check-in, said `minutesAgo` minutes ago. */
  function seedAged(text: string, minutesAgo: number): void {
    fs.writeFileSync(OVERSEER_FILE, JSON.stringify({
      jobId: 'job-1',
      messages: [{
        id: 'aged', role: 'overseer', text, action: null, isBriefing: true,
        timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      }],
      previousSnapshot: null, longRunningReported: [], paused: false,
    }, null, 2));
  }

  it('refuses a check-in that repeats the one just before it', async () => {
    putAgent('waiting');
    seedAged(X, 3);
    nextReply = JSON.stringify({ say: X, action: null });

    expect((await overseer.askOverseer('fleet change', { isBriefing: true })).ok).toBe(false);
  }, 30000);

  it('lets the same observation through once it has stood for long enough', async () => {
    putAgent('waiting');
    // Still blocked an hour later is not a repetition, it is the news that it
    // has not moved. This used to be refused, which is what JeanBrasse lost.
    seedAged(X, 61);
    nextReply = JSON.stringify({ say: X, action: null });

    expect((await overseer.askOverseer('fleet change', { isBriefing: true })).ok).toBe(true);
  }, 30000);

  it('answers JeanBrasse even when the answer has not changed', async () => {
    putAgent('waiting');
    seedAged(X, 3);
    nextReply = JSON.stringify({ say: X, action: null });

    // He asked. An error in place of an answer is worse than an answer that
    // happens to be the same as the last one.
    expect((await overseer.askOverseer('alors ?')).ok).toBe(true);
  }, 30000);

  // The window itself, not somewhere either side of it. 3 and 61 minutes hold
  // whatever the constant is; these two fail if it moves, which is the point:
  // thirty minutes was chosen against JeanBrasse's own gaps (median 2.6 min between
  // repeats, 9 of 291 above the window) and a later change to it should have
  // to be deliberate.
  it('still refuses one minute inside the window', async () => {
    putAgent('waiting');
    seedAged(X, 29);
    nextReply = JSON.stringify({ say: X, action: null });

    expect((await overseer.askOverseer('fleet change', { isBriefing: true })).ok).toBe(false);
  }, 30000);

  it('accepts one minute outside it', async () => {
    putAgent('waiting');
    seedAged(X, 31);
    nextReply = JSON.stringify({ say: X, action: null });

    expect((await overseer.askOverseer('fleet change', { isBriefing: true })).ok).toBe(true);
  }, 30000);

  it('allows it again once the overseer has said something else', async () => {
    putAgent('waiting');
    seed([{ role: 'overseer', text: X }, { role: 'overseer', text: Y }]);
    nextReply = JSON.stringify({ say: X, action: null });

    expect((await overseer.askOverseer('fleet change', { isBriefing: true })).ok).toBe(true);
  }, 30000);
});

/**
 * The five the rule used to swallow, one by one.
 *
 * Each pair is two real observations that the edit budget merged into one, so
 * the second was refused and lost. The first matters most: two agents failing
 * one after the other, and only the first ever reported.
 */
describe('observations that name different subjects', () => {
  it.each([
    ['two different agents failing', 'Agent a1 errored', 'Agent a2 errored'],
    ['a count that is not a duration', 'Two agents are waiting', 'Nine agents are waiting'],
    ['a build that flipped', 'The build is green', 'The build is red'],
    ['a status that changed', 'Frontend is done', 'Frontend is idle'],
    ['two ids a letter apart', 'Agent ab', 'Agent ac'],
  ])('keeps %s apart', (_name, a, b) => {
    expect(overseer.isSameThingSaidAgain(a as string, b as string)).toBe(false);
  });

  it('does not drop the second agent to fail', async () => {
    putAgent('error', 'a1');
    putAgent('error', 'a2');
    seed([{ role: 'overseer', text: 'Agent a1 errored on the migration.' }]);
    nextReply = JSON.stringify({ say: 'Agent a2 errored on the migration.', action: null });

    const result = await overseer.askOverseer('fleet change', { isBriefing: true });

    expect(result.ok).toBe(true);
    expect(persisted().map(m => m.text)).toContain('Agent a2 errored on the migration.');
  }, 30000);

  it('still merges a duration that only got older', () => {
    expect(overseer.isSameThingSaidAgain(
      'Frontend has been waiting for eleven minutes.',
      'Frontend has been waiting for 12 minutes.',
    )).toBe(true);
  });
});

/**
 * The conversation that started all this, replayed against the rule.
 *
 * Loosening for the false positives above must not let the loop back in. Those
 * repeats were rigorously identical and close together, so they have to stay
 * refused, and this counts them rather than trusting the reasoning.
 */
describe('the hundred and eighty repeats', () => {
  it('are still refused, essentially all of them', () => {
    const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));
    const messages: { role: string; text: string; timestamp: string; isBriefing?: boolean }[] = raw.messages;

    let checkIns = 0;
    let refused = 0;
    let previous: (typeof messages)[number] | undefined;
    for (const m of messages) {
      if (m.role !== 'overseer') continue;
      if (previous && m.isBriefing) {
        checkIns++;
        const age = Date.parse(m.timestamp) - Date.parse(previous.timestamp);
        if (overseer.isSameThingSaidAgain(m.text, previous.text) && age < 30 * 60 * 1000) refused++;
      }
      previous = m;
    }

    expect(checkIns).toBeGreaterThan(170);
    // All but the handful that stood for over half an hour, which are exactly
    // the ones worth hearing.
    expect(refused / checkIns).toBeGreaterThan(0.95);
  });
});

/**
 * The two directions the rule can be wrong in, pinned at their real position.
 *
 * Normalisation flattens digits and number words, and the budget is five
 * percent of the longer sentence with a floor of three. Five percent only
 * exceeds three above sixty normalised characters, so for almost every real
 * sentence the rule is "identical, give or take three characters". That is
 * exactly right for the failure it exists for, a hundred and seventy eight
 * identical lines, and it is loose on short sentences and blind to rewording.
 */
describe('what the rule merges and what it does not', () => {
  it('merges the same observation whose number moved', () => {
    expect(overseer.isSameThingSaidAgain(
      'Frontend has been waiting for eleven minutes.',
      'Frontend has been waiting for 12 minutes.',
    )).toBe(true);
  });

  it('keeps two different agents apart', () => {
    expect(overseer.isSameThingSaidAgain(
      'Frontend is blocked on the sidebar width.',
      'Backend is blocked on the sidebar width.',
    )).toBe(false);
  });

  it('does not merely rewrite: a reworded repeat still gets through', () => {
    // Not an assertion that this is desirable, an assertion of what it does.
    // A model that rewords rather than repeats is not caught here, which is
    // why the fold and the prompt instruction carry the rest of the load.
    expect(overseer.isSameThingSaidAgain(
      'Frontend is waiting for your answer.',
      'Frontend is awaiting your reply.',
    )).toBe(false);
  });
});
