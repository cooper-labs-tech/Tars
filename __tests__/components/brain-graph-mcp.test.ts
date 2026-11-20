import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { globalMcpServers } from '../../src/components/Memory/AgentKnowledgeGraph';

/**
 * The servers of ~/.claude/mcp.json, as the Brain graph reads them from
 * fs:read-text-file's answer: `{ content }`, or `{ content: '', error }` for a
 * file missing or out of the allowed roots. The whole chain, the file on disk
 * to the node in the graph, is e2e/brain-mcp-servers.spec.ts. Written before
 * the code, as the ways it can fail:
 * 1. the file's servers never reach the graph: they are read from a field the
 *    channel does not return (`output`, the defect QA found on main);
 * 2. a missing, refused or unreadable file breaks the graph, or adds a server;
 * 3. a file that names no servers, or names them as something else than an
 *    object, adds one.
 */

const file = (content: unknown) => ({ content: JSON.stringify(content) });

describe('the servers of ~/.claude/mcp.json', () => {
  it("reads them from the channel's content (1)", () => {
    expect(globalMcpServers(file({ mcpServers: { probe: { command: 'node', args: ['probe.js'] } } })))
      .toEqual({ probe: { command: 'node', args: ['probe.js'] } });
  });

  it('gives none, quietly, for a file missing, refused or unreadable (2)', () => {
    expect(globalMcpServers({ content: '', error: 'Not found' })).toBeUndefined();
    expect(globalMcpServers({ content: '', error: 'Path outside allowed roots' })).toBeUndefined();
    expect(globalMcpServers(null)).toBeUndefined();
    expect(globalMcpServers({ content: '{ not json' })).toBeUndefined();
  });

  it('gives none for a file that names no servers (3)', () => {
    expect(globalMcpServers(file({}))).toBeUndefined();
    expect(globalMcpServers(file({ mcpServers: 'probe' }))).toBeUndefined();
    expect(globalMcpServers(file({ mcpServers: null }))).toBeUndefined();
  });
});
