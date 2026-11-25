import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * update_agent: the orchestrator changes an agent of its project (2.0.4).
 *
 * The tool is the real one, registered on a fake server that validates the
 * arguments against the tool's own schema the way the SDK does (see
 * orchestrator-create-agent.test.ts for why each field is parsed by itself),
 * so a field the schema does not declare is dropped here as it would be there.
 *
 * How it fails, written before the code (2026-10-19):
 * 1. There is no update_agent, or it calls another route than
 *    POST /api/agents/:id/update.
 * 2. Its schema takes role, orchestratorMode or projectPath: what the user
 *    changes in the Agents page.
 * 3. A field left out is sent, as undefined or as null: null clears a field,
 *    so a field nobody named would be cleared.
 * 4. null, which clears the model, the effort, the CLI path or the secondary
 *    project path, does not reach the API.
 * 5. Its description does not say who may (the project's orchestrator, never a
 *    worker or another project), that the role stays the user's, that a turn
 *    is never cut, that a change of CLI waits for the agent to be stopped and
 *    starts a new conversation, and that the answer says when it applies.
 * 6. An effort or a permission mode outside its values reaches the API.
 * 7. What the orchestrator reads leaves out the route's sentence: when the
 *    change applies and whether the conversation is kept.
 * 8. create_agent's description names 'gpt-5-codex', a codex model its CLI no
 *    longer runs: an orchestrator that copies it makes an agent that fails at
 *    its first turn.
 */

vi.mock('../../mcp-orchestrator/src/utils/api.js', () => ({
  apiRequest: (...args: unknown[]) => mockApiRequest(...args),
  getCallerIdentity: () => ({ agentId: 'agent-alpha', projectPath: '/projects/alpha' }),
}));

let mockApiRequest: ReturnType<typeof vi.fn>;

type FieldSchema = { parse(value: unknown): unknown; description?: string };

function makeFakeServer() {
  const tools = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  const shapes = new Map<string, Record<string, FieldSchema>>();
  const descriptions = new Map<string, string>();
  return {
    tools,
    shapes,
    descriptions,
    tool(name: string, desc: string, shape: Record<string, FieldSchema>, handler: (args: Record<string, unknown>) => Promise<unknown>) {
      shapes.set(name, shape);
      descriptions.set(name, desc);
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

async function load() {
  const { registerAgentTools } = await import('../../mcp-orchestrator/src/tools/agents.js');
  const server = makeFakeServer();
  registerAgentTools(server as never);
  return server;
}

const ANSWER = {
  agent: { id: 'w1', name: 'Coder', provider: 'claude', model: 'opus' },
  changed: ['provider', 'model'],
  applies: 'next-start',
  session: 'new',
  text: 'Its next start runs Claude Code, on a new conversation: no CLI continues another one\'s.',
};

beforeEach(() => {
  mockApiRequest = vi.fn(async () => ANSWER);
  vi.resetModules();
});

describe('update_agent', () => {
  it('1. posts to /api/agents/:id/update', async () => {
    const server = await load();
    const update = server.tools.get('update_agent');
    expect(update).toBeDefined();
    await update!({ id: 'w1', model: 'opus' });
    const [endpoint, method] = mockApiRequest.mock.calls[0];
    expect([endpoint, method]).toEqual(['/api/agents/w1/update', 'POST']);
  });

  it('2. takes no role, orchestratorMode or projectPath', async () => {
    const server = await load();
    const shape = server.shapes.get('update_agent')!;
    for (const field of ['role', 'orchestratorMode', 'projectPath']) expect(Object.keys(shape)).not.toContain(field);
    await server.tools.get('update_agent')!({ id: 'w1', role: 'orchestrator', orchestratorMode: true, projectPath: '/x', model: 'opus' });
    const [, , body] = mockApiRequest.mock.calls[0];
    expect(body).toEqual({ model: 'opus' });
  });

  it('3. sends the fields given and only them', async () => {
    const server = await load();
    const update = server.tools.get('update_agent')!;
    await update({
      id: 'w1', name: 'Coder', provider: 'codex', model: 'gpt-x', effort: 'high', permissionMode: 'normal',
      cliPath: '/opt/bin/codex', skills: ['react'], character: 'ninja', secondaryProjectPath: '/projects/shared',
    });
    expect(mockApiRequest.mock.calls[0][2]).toEqual({
      name: 'Coder', provider: 'codex', model: 'gpt-x', effort: 'high', permissionMode: 'normal',
      cliPath: '/opt/bin/codex', skills: ['react'], character: 'ninja', secondaryProjectPath: '/projects/shared',
    });
    await update({ id: 'w1', effort: 'low' });
    expect(mockApiRequest.mock.calls[1][2]).toEqual({ effort: 'low' });
  });

  it('4. sends null for a field to clear', async () => {
    const server = await load();
    await server.tools.get('update_agent')!({ id: 'w1', model: null, effort: null, cliPath: null, secondaryProjectPath: null });
    expect(mockApiRequest.mock.calls[0][2]).toEqual({ model: null, effort: null, cliPath: null, secondaryProjectPath: null });
  });

  it('5. says who may, what stays the user\'s, that nothing is cut, and what a change of CLI does', async () => {
    const server = await load();
    const description = server.descriptions.get('update_agent')!;
    expect(description).toMatch(/orchestrator/);
    expect(description).toMatch(/worker/);
    expect(description).toMatch(/worker_may_not_update/);
    expect(description).toMatch(/another project/);
    expect(description).toMatch(/role/);
    expect(description).toMatch(/Agents page/);
    expect(description).toMatch(/turn/);
    expect(description).toMatch(/never cut/);
    expect(description).toMatch(/stop_agent/);
    expect(description).toMatch(/cli_running/);
    expect(description).toMatch(/new conversation/);
    expect(description).toMatch(/answer says/);
    expect(description).not.toMatch(/[–—]/);
  });

  it('6. refuses an effort or a permission mode outside its values before the API', async () => {
    const server = await load();
    const update = server.tools.get('update_agent')!;
    // A tool that is not there throws too: it must be there, and take the values it does.
    expect(update).toBeDefined();
    await update({ id: 'w1', effort: 'high', permissionMode: 'auto' });
    mockApiRequest.mockClear();
    await expect(async () => update({ id: 'w1', effort: 'extreme' })).rejects.toThrow();
    await expect(async () => update({ id: 'w1', permissionMode: 'yolo' })).rejects.toThrow();
    expect(mockApiRequest).not.toHaveBeenCalled();
  });

  it('7. answers with what changed and the route\'s sentence', async () => {
    const server = await load();
    const result = await server.tools.get('update_agent')!({ id: 'w1', provider: 'claude', model: 'opus' }) as { content: Array<{ text: string }> };
    const said = result.content.map(c => c.text).join('\n');
    expect(said).toMatch(/Coder/);
    expect(said).toMatch(/provider, model/);
    expect(said).toContain(ANSWER.text);
  });

  it('names every provider of the registry by its id, as create_agent does', async () => {
    const server = await load();
    const description = server.shapes.get('update_agent')!.provider?.description ?? '';
    const { getAllProviders } = await import('../../electron/providers');
    for (const p of getAllProviders()) expect(description).toContain(p.id);
  });
});

describe('create_agent', () => {
  it("8. names no codex model in its description", async () => {
    const server = await load();
    const shape = server.shapes.get('create_agent')!;
    const said = [server.descriptions.get('create_agent'), ...Object.values(shape).map(f => f.description ?? '')].join('\n');
    expect(said).not.toMatch(/gpt-5-codex/);
  });
});
