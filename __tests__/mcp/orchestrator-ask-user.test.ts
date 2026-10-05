import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * ask_user: the tool an agent asks the user with, on their Telegram (step 2 of the
 * relay plan). It posts through Tars (`/api/user/ask`), which decides who is
 * asking from the agent's own token, sends the question and types the answer
 * back into the agent's terminal.
 *
 * The tool is the real one, on a fake server that validates the arguments with
 * the tool's own schema (orchestrator-send-discord.test.ts does the same).
 *
 * How it fails, written before the code (2026-09-28):
 * 1. It posts anywhere but /api/user/ask, or not the question and context.
 * 2. It answers as if the user had answered: the agent must be told their answer
 *    comes later, typed into its terminal after "Message from the user via
 *    Telegram:", and nothing else carries it.
 * 3. A refusal of Tars's (a question already open, the day's limit, no
 *    Telegram) is not said in Tars's words.
 * 4. It takes a call with no question.
 * 5. (the relay, 2026-10-01) A question that waits for Hermes is answered as if it had been asked: the agent must be
 *    told it has not reached the user yet, and goes when Hermes takes it.
 * 6. (JeanBrasse's rule of 2026-10-01) Its description lets a worker think it may ask the user: only a project's
 *    orchestrator does, through the user's Hermes.
 */

vi.mock('../../mcp-orchestrator/src/utils/api.js', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  getCallerIdentity: () => ({ agentId: 'agent-lead', projectPath: '/projects/alpha' }),
}));

let mockApiRequest: ReturnType<typeof vi.fn>;
type FieldSchema = { parse(value: unknown): unknown };
type Answer = { content: Array<{ text: string }>; isError?: boolean };

async function loadAskUser() {
  const tools = new Map<string, { description: string; run: (args: Record<string, unknown>) => Promise<Answer> }>();
  const server = {
    tool(name: string, description: string, shape: Record<string, FieldSchema>, handler: (args: Record<string, unknown>) => Promise<Answer>) {
      tools.set(name, {
        description,
        run: args => {
          const parsed: Record<string, unknown> = {};
          for (const [key, field] of Object.entries(shape)) {
            const value = field.parse(args[key]);
            if (value !== undefined) parsed[key] = value;
          }
          return handler(parsed);
        },
      });
    },
  };
  const { registerMessagingTools } = await import('../../mcp-orchestrator/src/tools/messaging.js');
  registerMessagingTools(server as never);
  return tools.get('ask_user')!;
}

beforeEach(() => {
  mockApiRequest = vi.fn(async () => ({ success: true, id: 'q-1', expiresAt: '2026-09-28T12:00:00.000Z' }));
  vi.resetModules();
});

describe('ask_user', () => {
  it('1, 2. posts the question through Tars, and says the answer comes later, typed after the user\'s line', async () => {
    const ask = await loadAskUser();
    const r = await ask.run({ question: 'Staging or prod?', context: 'The migration touches billing.' });

    expect(mockApiRequest).toHaveBeenCalledWith('/api/user/ask', 'POST', { question: 'Staging or prod?', context: 'The migration touches billing.' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain('Message from the user via Telegram:');
    expect(r.content[0].text).toContain('2026-09-28T12:00:00.000Z');
    expect(ask.description).toMatch(/Telegram/);
  });

  it('3. says what Tars refused, in its words', async () => {
    mockApiRequest = vi.fn(async () => { throw new Error('You already have a question open for the user'); });
    const ask = await loadAskUser();
    const r = await ask.run({ question: 'Again?' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('Error asking the user: You already have a question open for the user');
  });

  it('5. a question that waits for Hermes is not said to be asked', async () => {
    const ask = await loadAskUser();
    mockApiRequest.mockResolvedValueOnce({ success: true, id: 'q-2', expiresAt: '2026-10-01T12:00:00.000Z', queued: true, reason: 'Hermes did not answer. The message waits, and goes when Hermes takes it.' });
    const r = await ask.run({ question: 'Staging or prod?' });

    expect(r.content[0].text).toMatch(/not reached the user yet/);
    expect(r.content[0].text).toContain('Hermes did not answer.');
    expect(r.content[0].text).not.toMatch(/^Asked the user/);
  });

  it('6. says it is a project orchestrator\'s, through the user\'s Hermes', async () => {
    const ask = await loadAskUser();
    expect(ask.description).toMatch(/orchestrator/);
    expect(ask.description).toMatch(/Hermes/);
    expect(ask.description).toMatch(/worker/);
  });

  it('4. needs a question', async () => {
    const ask = await loadAskUser();
    await expect((async () => ask.run({ context: 'no question' }))()).rejects.toThrow();
  });
});
