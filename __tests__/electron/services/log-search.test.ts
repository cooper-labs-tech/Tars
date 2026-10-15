import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

/**
 * The Logs page: searching and reading every agent's output as lines.
 *
 * JeanBrasse, 01/10: the page showed every text glued together, unreadable. The
 * lines were the raw PTY stream with its escape codes stripped, split on \n.
 * Claude Code draws its screen with cursor moves and carriage returns, not
 * line breaks: a space is a cursor move one cell right, a row is a cursor
 * position, a spinner or a countdown is the same row rewritten after a \r.
 * Strip the codes and the words run together. So the lines now come from a
 * terminal emulator, the xterm-headless mirror of #127 for a running agent,
 * and a headless replay of its kept output for one that is not.
 *
 * The streams are real: Claude Code 2.1.286 inline (its default) recorded for
 * this file, and the 2.1.280 fullscreen turn the mirror's own tests replay
 * (__tests__/fixtures/terminal-streams, each saying where it comes from).
 *
 * How it fails, written before the code (2026-10-01):
 * 1. Words a CLI separates with cursor moves come out glued
 *    ("Listthethreefilesinthisfolder"), and a search for "three files" finds
 *    nothing.
 * 2. A row rewritten in place after a \r (a spinner, a countdown) leaves each
 *    state it went through as a line of its own ("0", "22", "1").
 * 3. A CLI on the alternate screen, where Claude Code 2.1.286 draws by
 *    default, is read from the normal screen, which is empty.
 * 4. A running agent is read from its kept chunks rather than from its mirror,
 *    which holds the screen it shows now.
 * 5. An agent that is not running, and so has no mirror, shows nothing.
 * 6. A kept replay outlives the output it was made from: a chunk added, or
 *    the oldest dropped and a new one added at the same count.
 * 7. Search and tail number the lines differently.
 * 8. A line longer than the terminal is wide comes out cut in two, and a
 *    search for words across the cut finds nothing.
 *
 * And from the Audit's gate of #274 (2026-10-01): Tars runs Claude Code full
 * screen, on the alternate screen, which keeps no history and is discarded at
 * /exit. A stopped full-screen agent replayed to 7 lines, its launch commands;
 * a running one showed its visible rows only.
 * 9. A Claude agent's conversation is lost: it is read from its transcript.
 * 10. What is only on its terminal (a banner, an error, a dialog) is no longer
 *     found: search reads the terminal too.
 * 11. A transcript that grows is not read again; one that is the same is read
 *     at every search.
 * 12. A removed agent's replay is kept until Tars restarts.
 */

vi.mock('../../../electron/core/agent-manager', () => ({ agents: new Map() }));
vi.mock('../../../electron/core/pty-manager', () => ({ ptyProcesses: new Map() }));

import { agents } from '../../../electron/core/agent-manager';
import { ptyProcesses } from '../../../electron/core/pty-manager';
import { attachTerminalMirror } from '../../../electron/core/terminal-mirror';
import { searchLogs, agentTail, cachedAgentIds } from '../../../electron/services/log-search';
import type { IPty } from 'node-pty';
import type { AgentStatus } from '../../../electron/types';

function recording(name: string): { start: [number, number]; chunks: string[] } {
  const file = path.join(__dirname, '../../fixtures/terminal-streams', name);
  const lines = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
  const head = lines.shift() as { start: [number, number] };
  const decoder = new TextDecoder('utf-8');
  const chunks = lines.filter((l: { o?: string }) => l.o !== undefined)
    .map((l: { o: string }) => decoder.decode(Buffer.from(l.o, 'base64'), { stream: true }));
  return { start: head.start, chunks };
}

const INLINE = recording('claude-inline-session.jsonl.gz');
const EXIT_RESTART = recording('claude-fullscreen-exit-restart.jsonl.gz');
const SESSION = '5f0c2d4e-8a61-4b7e-9d3a-2c1b0e9f7a64';

/** A Claude Code transcript for an agent of /tmp/p, as ~/.claude/projects keeps it. */
function transcript(records: Array<{ role: 'user' | 'assistant'; text: string }>): string {
  const file = path.join(os.homedir(), '.claude', 'projects', '-tmp-p', `${SESSION}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r, i) => JSON.stringify({
    type: r.role, uuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, parentUuid: null, isSidechain: false, sessionId: SESSION,
    timestamp: new Date(Date.UTC(2026, 9, 1, 8) + i * 1000).toISOString(),
    message: r.role === 'user' ? { role: 'user', content: r.text } : { id: `msg_${i}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: r.text }] },
  })).join('\n') + '\n');
  return file;
}
const FULLSCREEN = recording('claude-fullscreen-long-turn.jsonl.gz');

function agent(id: string, output: string[], extra: Partial<AgentStatus> = {}): AgentStatus {
  const a = { id, name: `Agent ${id}`, projectPath: '/tmp/p', status: 'idle', output: [...output], skills: [], ...extra } as unknown as AgentStatus;
  (agents as Map<string, AgentStatus>).set(id, a);
  return a;
}

/** A running agent: a terminal with a mirror, fed the stream. Its kept output is left empty. */
function running(id: string, rec: { start: [number, number]; chunks: string[] }): AgentStatus {
  const listeners: Array<(d: string) => void> = [];
  const pty = {
    onData: (l: (d: string) => void) => { listeners.push(l); return { dispose() {} }; },
    onExit: () => ({ dispose() {} }),
  } as unknown as IPty;
  attachTerminalMirror(pty, { cols: rec.start[0], rows: rec.start[1], watchRepaint: false, label: id });
  for (const chunk of rec.chunks) for (const l of listeners) l(chunk);
  (ptyProcesses as Map<string, IPty>).set(`pty-${id}`, pty);
  return agent(id, [], { ptyId: `pty-${id}`, status: 'running' } as Partial<AgentStatus>);
}

beforeEach(() => {
  (agents as Map<string, AgentStatus>).clear();
  (ptyProcesses as Map<string, IPty>).clear();
});

describe('an agent that is not running, read from its kept output', () => {
  it('1. keeps the spaces a cursor move drew, so a sentence is found as typed', async () => {
    agent('a1', INLINE.chunks);

    const tail = (await agentTail('a1'))!.lines;
    expect(tail).toContainEqual(expect.stringContaining('List the three files in this folder'));
    expect(tail.join('\n')).not.toContain('Listthethreefiles');
    expect((await searchLogs({ query: 'three files' })).lines.map(l => l.line)).toEqual([
      expect.stringContaining('❯ List the three files in this folder'),
    ]);
  });

  it('2. gives a row rewritten after a carriage return once, as it ended', async () => {
    agent('a1', INLINE.chunks);

    const tail = (await agentTail('a1'))!.lines;
    expect(tail.filter(l => /^\s*\d+\s*$/.test(l)), 'a countdown left its digits as lines').toEqual([]);
    const refused = tail.filter(l => l.includes('Connection refused'));
    expect(refused).toHaveLength(1);
    // The row as the screen shows it at the end: the last retry, and only it.
    expect(refused[0]).toMatch(/Retrying in \d+s · attempt \d+\/10$/);
    expect(refused[0].match(/attempt/g)).toHaveLength(1);
  });

  it('3. reads the alternate screen a CLI draws on', async () => {
    agent('a1', FULLSCREEN.chunks);

    const tail = (await agentTail('a1'))!.lines;
    expect(tail).toContainEqual(expect.stringContaining('LONGTURN: think for a long time'));
    expect(tail).toContainEqual(expect.stringContaining('Cogitated for 5m 2s'));
    expect(tail).toContainEqual(expect.stringContaining('Claude Code v2.1.280'));
    expect(tail).toContainEqual(expect.stringContaining('⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'));
  });

  it('6. follows the kept output as it changes, a chunk added or the oldest swapped for a new one', async () => {
    // The first 7 chunks: the screen before anything was typed.
    const a = agent('a1', INLINE.chunks.slice(0, 7));
    const before = (await agentTail('a1'))!.lines.join('\n');
    expect(before).not.toContain('List the three files');

    a.output.push(...INLINE.chunks.slice(7));
    expect((await agentTail('a1'))!.lines.join('\n')).toContain('List the three files in this folder');

    const count = a.output.length;
    a.output.shift();
    a.output.push('\r\nthe newest line\r\n');
    expect(a.output).toHaveLength(count);
    expect((await agentTail('a1'))!.lines.join('\n')).toContain('the newest line');
  });
});

describe('a line longer than the terminal is wide', () => {
  it('8. is one line, found by words that straddle the wrap', async () => {
    // Replayed at 120 columns: the sentence starts at column 116.
    const long = `${'w'.repeat(115)} needle across the wrap ${'z'.repeat(40)}`;
    agent('a1', [`${long}\r\n`]);

    expect((await agentTail('a1'))!.lines).toEqual([long]);
    expect((await searchLogs({ query: 'needle across the wrap' })).lines).toHaveLength(1);
  });
});

describe('a running agent, read from its mirror', () => {
  it('4. reads the screen the mirror holds, not the kept chunks', async () => {
    running('r1', INLINE);

    const tail = (await agentTail('r1'))!.lines;
    expect(tail).toContainEqual(expect.stringContaining('List the three files in this folder'));
    expect((await searchLogs({ query: 'Retrying in' })).lines).toHaveLength(1);
  });

  it('3. reads a fullscreen CLI from its alternate screen', async () => {
    running('r1', FULLSCREEN);

    expect((await searchLogs({ query: 'LONGTURN' })).lines.map(l => l.agentId)).toEqual(['r1']);
  });
});

describe('the fleet', () => {
  it('5, 7. finds lines in running and stopped agents alike, at the positions their tail gives them', async () => {
    running('r1', FULLSCREEN);
    agent('a1', INLINE.chunks);

    const hits = (await searchLogs({ query: '/Claude Code v2\\.1\\.28[06]/' })).lines;
    expect(hits.map(h => h.agentId).sort()).toEqual(['a1', 'r1']);
    for (const hit of hits) {
      const tail = (await agentTail(hit.agentId, 10_000))!.lines;
      expect(tail[hit.position]).toBe(hit.line);
    }
  });
});

describe("a Claude agent, read from its transcript (the Audit's gate of #274)", () => {
  it('9. shows the conversation of a stopped full-screen session, which its terminal no longer holds', async () => {
    agent('c1', EXIT_RESTART.chunks, { resumableSessionId: SESSION } as Partial<AgentStatus>);
    transcript([
      { role: 'user', text: 'Explain how the panel repaints after a resize' },
      { role: 'assistant', text: 'Paragraph one: the repaint follows SIGWINCH.\nParagraph two: the rows are redrawn.' },
    ]);

    const tail = (await agentTail('c1'))!.lines.join('\n');
    expect(tail).toContain('Explain how the panel repaints after a resize');
    expect(tail).toContain('Paragraph two: the rows are redrawn.');
    expect((await searchLogs({ query: 'Paragraph one' })).lines).toHaveLength(1);
  });

  it('10. finds what is only on its terminal too', async () => {
    agent('c1', INLINE.chunks, { currentSessionId: SESSION } as Partial<AgentStatus>);
    transcript([{ role: 'user', text: 'List the three files in this folder' }]);

    const hits = (await searchLogs({ query: 'Connection refused' })).lines;
    expect(hits).toHaveLength(1);
    expect(hits[0].agentId).toBe('c1');
  });

  it('11. reads a transcript again once it has grown', async () => {
    agent('c1', [], { currentSessionId: SESSION } as Partial<AgentStatus>);
    transcript([{ role: 'user', text: 'first question' }]);
    expect((await agentTail('c1'))!.lines.join('\n')).not.toContain('second question');

    transcript([{ role: 'user', text: 'first question' }, { role: 'assistant', text: 'an answer' }, { role: 'user', text: 'second question' }]);
    expect((await agentTail('c1'))!.lines.join('\n')).toContain('second question');
  });
});

describe('the replays it keeps', () => {
  it('12. forget an agent that was removed', async () => {
    agent('gone', INLINE.chunks);
    await agentTail('gone');
    expect(cachedAgentIds()).toContain('gone');

    (agents as Map<string, AgentStatus>).delete('gone');
    await searchLogs({ query: 'anything' });
    expect(cachedAgentIds()).not.toContain('gone');
  });
});

