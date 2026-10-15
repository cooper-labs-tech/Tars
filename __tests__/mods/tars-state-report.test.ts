/**
 * The state mod's posts to Tars (mods/tars-state/hooks/register.ts).
 *
 * From the Audit's gate of #308 (Low): the posts were fire and forget, and a
 * response other than 2xx was not looked at either. For a session the mod
 * registered, Tars sets aside the shell hook's post for the same event, so a
 * Stop's `idle` lost or refused (Tars busy, a 503) left the agent reading
 * `running` until its next turn, and the heartbeat kept it from the stall
 * watch.
 *
 * How it fails, written before the code (2026-10-05):
 * 1. A post whose request fails, or that Tars answers with no 2xx, is not
 *    sent again: the event is lost.
 * 2. A post sent again lands after the next event's, or holds the next one
 *    back for good: the order of the events must hold, and a post that keeps
 *    failing is given up after three tries.
 * 3. A post Tars took (2xx) is sent again: a second idle, a second
 *    "finished" notice.
 * 4. The tries come back to back, into a Tars that is busy.
 * And from QA's gate of #322 (05/10): the shell's Stop hook now counts what the
 * agent leaves waiting inside its CLI (`session_crons`, `background_tasks`)
 * and posts it as `pending`, which decides whether the sleep pass may end it.
 * For a session the mod registered that post is set aside.
 * 5. The mod's Stop does not count them, and an agent at rest with a /loop
 *    timer or a background task is put to sleep, which loses both.
 * 6. It counts them otherwise than on-stop.sh: a finished task counted, or a
 *    count sent when Claude Code sent no lists (nothing is known then).
 * And mods step 4 (JeanBrasse's go): each turn's usage, for the task ledger.
 * 7. A turn's usage (turn.complete) is not posted, or without its session, or
 *    ahead of the Stop's posts that came before it.
 * 8. The event is not handed on unchanged, or a turn.complete with no usage
 *    posts one.
 * And from the nested session of 13/10: a `claude -p` run inside an agent's
 * terminal loads this mod too, and its SessionStart took the agent's session.
 * Tars registers only the CLI it launched there, by its pid.
 * 9. The mod in a nested claude speaks for the agent. Measured by the Audit
 *    (gate of #380, claude 2.1.296): Claude Code puts CLAUDE_PID into the
 *    environment of what it starts, not into its own; the mod's $.env is its
 *    own process's, so CLAUDE_PID there is the pid of the claude that started
 *    this one. A mod that sends it as its CLI's pid hands Tars the agent's own
 *    CLI's pid, and the nested session was taken. A mod that sees CLAUDE_PID is
 *    in a claude another claude started: it says nothing to Tars at all (no
 *    registration, no heartbeat, no turn, no question), and it never sends a
 *    pid it cannot know.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

type Hook = ($: unknown, e: unknown, next: (e: unknown) => Promise<unknown>) => unknown;
type Reply = { status: number; ok: boolean; text: string };

const ENV: Record<string, string> = {
  CLAUDE_AGENT_ID: 'a1', CLAUDE_MGR_API_URL: 'http://127.0.0.1:1', CLAUDE_MGR_API_TOKEN: 'tok', TARS_INSTANCE_ID: 'inst',
};
const SESSION = '11111111-1111-4111-8111-111111111111';

let hooks: Map<string, Hook>;
let sent: Array<{ route: string; body: Record<string, unknown> }>;
let replies: Array<Reply | Error>;
let slept: number[];

const ok: Reply = { status: 200, ok: true, text: '{"success":true}' };

const $ = {
  env: { get: async (name: string) => ENV[name] },
  clock: { every: () => undefined, sleep: async (ms: number) => { slept.push(ms); } },
  http: {
    fetch: async (url: string, init?: { body?: string }) => {
      if (url.includes('/api/health')) {
        const challenge = new URL(url).searchParams.get('challenge');
        return { status: 200, ok: true, headers: {}, text: JSON.stringify({ proof: createHash('sha256').update(`inst:${challenge}`).digest('hex') }) };
      }
      const route = new URL(url).pathname;
      sent.push({ route, body: JSON.parse(init?.body ?? '{}') });
      const reply = replies.shift() ?? ok;
      if (reply instanceof Error) throw reply;
      return { headers: {}, ...reply };
    },
  },
};

async function load(): Promise<void> {
  vi.resetModules();
  hooks = new Map();
  const mod = await import('../../mods/tars-state/hooks/register');
  mod.register(((event: string, hook: Hook) => { hooks.set(event, hook); }) as never);
}

const fire = (event: string, e: Record<string, unknown>) => hooks.get(event)!($, e, async x => x);
/** The posts, in the order Tars got them, once the mod's queue has drained. */
async function drained(): Promise<string[]> {
  for (let i = 0; i < 50; i++) await new Promise(r => setTimeout(r, 0));
  return sent.map(s => `${s.route} ${String(s.body.status ?? '')}`.trim());
}

beforeEach(async () => {
  sent = [];
  replies = [];
  slept = [];
  await load();
  await fire('classic.SessionStart', { session_id: SESSION, source: 'startup' });
  await drained();
  sent = [];
});

describe("the mod's posts", () => {
  it('1, 2. a Stop whose idle fails once is sent again, before the posts after it', async () => {
    replies = [ok, new Error('socket hang up')];
    await fire('classic.Stop', { session_id: SESSION, last_assistant_message: 'done' });
    expect(await drained()).toEqual([
      '/api/hooks/output', '/api/hooks/status idle', '/api/hooks/status idle', '/api/hooks/agent-stopped',
    ]);
  });

  it('1. a post Tars answers with no 2xx is sent again', async () => {
    replies = [ok, { status: 503, ok: false, text: '{"error":"busy"}' }];
    await fire('classic.Stop', { session_id: SESSION, last_assistant_message: 'done' });
    expect((await drained()).filter(p => p === '/api/hooks/status idle')).toHaveLength(2);
  });

  it('2. gives a post up after three tries, and the next event still goes', async () => {
    replies = [new Error('down'), new Error('down'), new Error('down')];
    await fire('classic.UserPromptSubmit', { session_id: SESSION, prompt: 'go' });
    await fire('classic.Stop', { session_id: SESSION });
    expect(await drained()).toEqual([
      '/api/hooks/status running', '/api/hooks/status running', '/api/hooks/status running',
      '/api/hooks/status idle', '/api/hooks/agent-stopped',
    ]);
  });

  it('3. a post Tars took is sent once', async () => {
    await fire('classic.Stop', { session_id: SESSION });
    expect(await drained()).toEqual(['/api/hooks/status idle', '/api/hooks/agent-stopped']);
    expect(slept).toEqual([]);
  });

  const statusBody = () => sent.find(s => s.route === '/api/hooks/status' && s.body.status === 'idle')?.body;

  it('5, 6. a Stop counts the timers and the background tasks still running, as on-stop.sh', async () => {
    await fire('classic.Stop', {
      session_id: SESSION,
      session_crons: [{ id: 'c1' }],
      background_tasks: [{ status: 'running' }, { status: 'completed' }, { status: 'failed' }, {}, 'opaque'],
    });
    await drained();
    expect(statusBody()?.pending).toEqual({ crons: 1, background: 3 });
  });

  it('6. sends no count when Claude Code sent no lists', async () => {
    await fire('classic.Stop', { session_id: SESSION });
    await drained();
    expect(statusBody()).toBeDefined();
    expect(statusBody()).not.toHaveProperty('pending');
    sent = [];
    await fire('classic.Stop', { session_id: SESSION, session_crons: 'x', background_tasks: [] });
    await drained();
    expect(statusBody()).not.toHaveProperty('pending');
  });

  it('4. waits between tries, longer each time', async () => {
    replies = [new Error('down'), new Error('down')];
    await fire('classic.Stop', { session_id: SESSION });
    await drained();
    expect(slept.length).toBe(2);
    expect(slept[0]).toBeGreaterThan(0);
    expect(slept[1]).toBeGreaterThan(slept[0]);
  });
});

describe("a turn's usage (mods step 4)", () => {
  const usage = { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 100, model: 'claude-opus-5-5' };

  it('7. is posted with its session, after the Stop that came before it', async () => {
    await fire('classic.Stop', { session_id: SESSION, stop_hook_active: false, last_assistant_message: 'ok' });
    const e = { answer: 'ok', reason: 'answer', turnId: 't1', durationMs: 85, usage };
    const handed = await fire('turn.complete', e);
    expect(await drained()).toEqual(['/api/hooks/output', '/api/hooks/status idle', '/api/hooks/agent-stopped', '/api/hooks/turn-usage']);
    expect(sent[3].body).toMatchObject({ agent_id: 'a1', session_id: SESSION, usage, via: 'mod' });
    expect(handed, '8. handed on unchanged').toBe(e);
  });

  it('9. in a claude another claude started (CLAUDE_PID in its environment), says nothing to Tars', async () => {
    ENV.CLAUDE_PID = '4242';
    try {
      sent = [];
      await load();
      await fire('classic.SessionStart', { session_id: SESSION, source: 'startup' });
      await fire('classic.UserPromptSubmit', { session_id: SESSION, prompt: 'nested' });
      await fire('classic.Stop', { session_id: SESSION, stop_hook_active: false, last_assistant_message: 'ok' });
      await drained();
      expect(sent.map((s) => s.route)).toEqual([]);
    } finally {
      delete ENV.CLAUDE_PID;
    }
  });

  it("9. in the agent's own claude, registers its session without a pid it cannot know", async () => {
    delete ENV.CLAUDE_PID;
    sent = [];
    await load();
    await fire('classic.SessionStart', { session_id: SESSION, source: 'startup' });
    await drained();
    expect(sent[0].body).toMatchObject({ session_id: SESSION, source: 'startup', via: 'mod' });
    expect(sent[0].body).not.toHaveProperty('cli_pid');
  });

  it('8. posts nothing for a turn.complete with no usage', async () => {
    await fire('turn.complete', { answer: 'ok', reason: 'aborted', turnId: 't2' });
    expect(await drained()).toEqual([]);
  });
});
