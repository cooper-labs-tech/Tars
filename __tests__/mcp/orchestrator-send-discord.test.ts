import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * send_discord: the orchestrator answering in Discord, as send_slack and
 * send_telegram answer in theirs.
 *
 * It posts through Tars (`/api/discord/send`), with the channel the incoming
 * message named, so that the answer lands where the question was asked; Tars
 * decides whether that channel may be written to.
 *
 * The tool is the real one, on a fake server that validates the arguments with
 * the tool's own schema, one field at a time (orchestrator-create-agent.test.ts
 * says why no zod is imported here).
 */

vi.mock('../../mcp-orchestrator/src/utils/api.js', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  getCallerIdentity: () => ({ agentId: 'agent-lead', projectPath: '/projects/alpha' }),
}));

let mockApiRequest: ReturnType<typeof vi.fn>;

type FieldSchema = { parse(value: unknown): unknown };

function makeFakeServer() {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
  return {
    tools,
    tool(name: string, _desc: string, shape: Record<string, FieldSchema>, handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) {
      tools.set(name, args => {
        const parsed: Record<string, unknown> = {};
        for (const [key, field] of Object.entries(shape)) {
          const value = field.parse(args[key]);
          if (value !== undefined) parsed[key] = value;
        }
        return handler(parsed);
      });
    },
  };
}

async function loadSendDiscord() {
  const { registerMessagingTools } = await import('../../mcp-orchestrator/src/tools/messaging.js');
  const server = makeFakeServer();
  registerMessagingTools(server as never);
  return server.tools.get('send_discord')!;
}

beforeEach(() => {
  mockApiRequest = vi.fn(async () => ({ success: true }));
  vi.resetModules();
});

describe('send_discord', () => {
  it('posts through Tars, to the channel the message came from', async () => {
    const send = await loadSendDiscord();
    const r = await send({ message: 'Dune is on it.', channel_id: 'C-TEAM' });
    expect(mockApiRequest).toHaveBeenCalledWith('/api/discord/send', 'POST', { message: 'Dune is on it.', channel_id: 'C-TEAM' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toBe('Message sent to Discord: "Dune is on it."');
  });

  it('leaves the channel to Tars when none is named', async () => {
    const send = await loadSendDiscord();
    await send({ message: 'Done.' });
    expect(mockApiRequest).toHaveBeenCalledWith('/api/discord/send', 'POST', { message: 'Done.', channel_id: undefined });
  });

  it('says what Tars refused', async () => {
    mockApiRequest = vi.fn(async () => { throw new Error('Tars posts only to the channel Settings > Discord detected'); });
    const send = await loadSendDiscord();
    const r = await send({ message: 'Hi', channel_id: 'C-OTHER' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe('Error sending to Discord: Tars posts only to the channel Settings > Discord detected');
  });

  it('needs a message', async () => {
    const send = await loadSendDiscord();
    // The schema refuses it before the handler runs, synchronously on this fake as in the SDK.
    await expect((async () => send({ channel_id: 'C-TEAM' }))()).rejects.toThrow();
    expect(mockApiRequest).not.toHaveBeenCalled();
  });
});
