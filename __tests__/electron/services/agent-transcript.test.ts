import '../../setup/home-guard';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { readAgentTranscript, type AgentTranscript } from '../../../electron/services/agent-transcript';

/**
 * The panel history reads the journal Claude Code writes, so every record here
 * is shaped like one it really writes, and every file lives in a temp home. The
 * real ~/.claude/projects holds live sessions; nothing in this file reads it.
 */

const PROJECT = '/Users/someone/work/demo.app';
/**
 * Claude Code's own directory name for PROJECT, every `/` and `.` turned into
 * `-`. Spelled out rather than computed with the product's helper, so the
 * reader is held to where the CLI writes and not to wherever the helper points.
 */
const PROJECT_DIR = '-Users-someone-work-demo-app';
const SESSION = '5f0c2d4e-8a61-4b7e-9d3a-2c1b0e9f7a64';

type Page = Extract<AgentTranscript, { available: true }>;
type Rec = Record<string, unknown> & { uuid: string; timestamp: string };

let home: string;
let clock: number;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-agent-transcript-'));
  clock = 0;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function record(type: string, fields: Record<string, unknown>): Rec {
  const timestamp = new Date(Date.UTC(2026, 8, 15, 21) + 1000 * clock++).toISOString();
  return { type, uuid: randomUUID(), parentUuid: null, isSidechain: false, sessionId: SESSION, timestamp, ...fields };
}

/** Something a person typed: a user record whose content is a plain string. */
function typed(text: string): Rec {
  return record('user', { message: { role: 'user', content: text } });
}

/** A tool's answer, which Claude Code files under the user role. */
function toolAnswer(toolUseId: string, content: unknown, isError?: boolean): Rec {
  const block = { type: 'tool_result', tool_use_id: toolUseId, content, ...(isError === undefined ? {} : { is_error: isError }) };
  return record('user', { message: { role: 'user', content: [block] } });
}

function assistant(content: unknown[]): Rec {
  return record('assistant', {
    message: { id: `msg_${clock}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content, stop_reason: null },
  });
}

/** A thinking block as Claude Code really writes it: the signature, and no text. */
function emptyThinking() {
  return { type: 'thinking', thinking: '', signature: 'EqQBCkgIBxABGAIqQJ8xZ3' };
}

function attachment(): Rec {
  return record('attachment', { attachment: { type: 'hook_additional_context', content: ['project context'] } });
}

function jsonl(records: unknown[]): string {
  return records.map(r => `${JSON.stringify(r)}\n`).join('');
}

function writeTranscript(records: unknown[], dir = PROJECT_DIR, sessionId = SESSION): void {
  const file = path.join(home, '.claude', 'projects', dir, `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, jsonl(records));
}

function appendToTranscript(text: string): void {
  fs.appendFileSync(path.join(home, '.claude', 'projects', PROJECT_DIR, `${SESSION}.jsonl`), text);
}

function read(params: { sessionId?: string; before?: string; limit?: number } = {}): Promise<AgentTranscript> {
  return readAgentTranscript({ sessionId: SESSION, projectPath: PROJECT, homeDir: home, ...params });
}

async function readPage(params: { before?: string; limit?: number } = {}): Promise<Page> {
  const result = await read(params);
  if (!result.available) throw new Error(`expected a page, got ${result.reason}: ${result.detail}`);
  return result;
}

const idsOf = (page: Page) => page.messages.map(m => m.id);

/**
 * `count` messages with what Claude Code writes around them: an attachment
 * after each one, the most common record in real files, and an empty thinking
 * record ahead of each assistant reply.
 */
function conversation(count: number, label = 'turn'): { records: Rec[]; ids: string[] } {
  const records: Rec[] = [];
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    if (i % 2 === 0) records.push(assistant([emptyThinking()]));
    const message = i % 2 ? typed(`${label} ${i}`) : assistant([{ type: 'text', text: `${label} ${i}` }]);
    records.push(message, attachment());
    ids.push(message.uuid);
  }
  return { records, ids };
}

/** Every page from the newest up to the first, following nextCursor as a panel scrolling up would. */
async function walkToTop(): Promise<Page[]> {
  let page = await readPage();
  const pages = [page];
  while (page.hasMore) {
    if (pages.length > 20) throw new Error('the cursor never reached the first message');
    expect(page.nextCursor).toEqual(expect.any(String));
    page = await readPage({ before: page.nextCursor });
    pages.push(page);
  }
  return pages;
}

describe('the four shapes a record really comes in', () => {
  it('a string is something a person typed, kept as written', async () => {
    const said = typed('Fix the login redirect, it drops the query string.');
    writeTranscript([said]);

    expect(await read()).toStrictEqual({
      available: true,
      sessionId: SESSION,
      hasMore: false,
      messages: [{ id: said.uuid, role: 'user', timestamp: said.timestamp, text: 'Fix the login redirect, it drops the query string.' }],
    });
  });

  it('an array of tool_result is a tool answering, marked as one whatever shape its body takes', async () => {
    const shell = toolAnswer('toolu_shell', 'On branch main\nnothing to commit');
    const blocks = toolAnswer('toolu_task', [{ type: 'text', text: 'Found 3 call sites.' }, { type: 'text', text: 'All in src/auth.' }]);
    const failed = toolAnswer('toolu_read', 'File does not exist.', true);
    writeTranscript([shell, blocks, failed]);

    expect((await readPage()).messages).toStrictEqual([
      { id: shell.uuid, role: 'user', timestamp: shell.timestamp, text: 'On branch main\nnothing to commit', toolResult: { toolUseId: 'toolu_shell', isError: false } },
      { id: blocks.uuid, role: 'user', timestamp: blocks.timestamp, text: 'Found 3 call sites.\nAll in src/auth.', toolResult: { toolUseId: 'toolu_task', isError: false } },
      { id: failed.uuid, role: 'user', timestamp: failed.timestamp, text: 'File does not exist.', toolResult: { toolUseId: 'toolu_read', isError: true } },
    ]);
  });

  it('text plus tool_use is one assistant message carrying its words, its model and every call', async () => {
    const turn = assistant([
      { type: 'text', text: 'Reading the handler first.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/repo/src/auth.ts' } },
      { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'git log --oneline -5', description: 'Recent commits' } },
    ]);
    writeTranscript([turn]);

    expect((await readPage()).messages).toStrictEqual([{
      id: turn.uuid,
      role: 'assistant',
      timestamp: turn.timestamp,
      text: 'Reading the handler first.',
      model: 'claude-opus-5',
      toolCalls: [
        { id: 'toolu_1', name: 'Read', summary: '/repo/src/auth.ts' },
        { id: 'toolu_2', name: 'Bash', summary: 'git log --oneline -5' },
      ],
    }]);
  });

  it('an empty thinking block, the only kind Claude Code writes, adds nothing to the page', async () => {
    const ask = typed('Go.');
    const onlyThinking = assistant([emptyThinking()]);
    const thinkingThenWords = assistant([emptyThinking(), { type: 'text', text: 'Done.' }]);
    writeTranscript([ask, onlyThinking, thinkingThenWords]);

    const { messages } = await readPage();

    // A record that is nothing but the empty block is not a message...
    expect(messages.map(m => m.id)).toEqual([ask.uuid, thinkingThenWords.uuid]);
    // ...and no empty `thinking` key rides along on the one that has words.
    expect(messages[1]).not.toHaveProperty('thinking');
  });

  it('thinking that does say something is kept, apart from the text', async () => {
    writeTranscript([assistant([{ type: 'thinking', thinking: 'The redirect drops the query.', signature: 'EqQB' }, { type: 'text', text: 'Found it.' }])]);

    expect((await readPage()).messages).toMatchObject([{ text: 'Found it.', thinking: 'The redirect drops the query.' }]);
  });

  it('records that are not conversation never reach the reader', async () => {
    const said = typed('Ship it.');
    writeTranscript([
      attachment(),
      record('system', { subtype: 'turn_duration', durationMs: 5321 }),
      record('user', { isMeta: true, message: { role: 'user', content: 'Context Tars injected at session start.' } }),
      { type: 'summary', summary: 'Login redirect fix', leafUuid: randomUUID() },
      said,
    ]);

    expect(idsOf(await readPage())).toEqual([said.uuid]);
  });
});

describe('paging up through a conversation', () => {
  it.each([
    { count: 120, sizes: [50, 50, 20] },
    { count: 100, sizes: [50, 50] },
    { count: 50, sizes: [50] },
    { count: 7, sizes: [7] },
  ])('$count messages read as pages of $sizes: no overlap, no gap, up to the first', async ({ count, sizes }) => {
    const { records, ids } = conversation(count);
    writeTranscript(records);

    const pages = await walkToTop();

    expect(pages.map(p => p.messages.length)).toEqual(sizes);
    // Newest page first, each page oldest first. Laid top to bottom they are the
    // whole conversation: a message on two pages, one lost between two, or a
    // walk that stops short of the first message all break this equality.
    expect([...pages].reverse().flatMap(idsOf)).toEqual(ids);
    expect(pages[pages.length - 1]).toMatchObject({ hasMore: false });
    expect(pages[pages.length - 1]).not.toHaveProperty('nextCursor');
  });

  it('a transcript that grows between two reads does not shift the page above', async () => {
    const earlier = conversation(120, 'earlier');
    writeTranscript(earlier.records);
    const onScreen = await readPage();
    expect(idsOf(onScreen)).toEqual(earlier.ids.slice(70));

    // The agent keeps working while its panel is open: thirty more messages, and
    // a last record still half written when the next read comes in.
    const later = conversation(30, 'later');
    appendToTranscript(jsonl(later.records) + JSON.stringify(typed('half written')).slice(0, 40));

    const above = await readPage({ before: onScreen.nextCursor });

    // Exactly the fifty directly above what is on screen. An offset counted from
    // the end would have slid thirty messages down and shown them twice.
    expect(idsOf(above)).toEqual(earlier.ids.slice(20, 70));
    // And the growth did land: a fresh read ends on the new tail.
    expect(idsOf(await readPage()).slice(-1)).toEqual(later.ids.slice(-1));
  });
});

describe('ceilings', () => {
  it('a page is 50 messages unless the reader asks for fewer', async () => {
    const { records, ids } = conversation(60);
    writeTranscript(records);

    expect(idsOf(await readPage())).toEqual(ids.slice(10));
    expect(idsOf(await readPage({ limit: 10 }))).toEqual(ids.slice(50));
  });

  it.each([1000, Infinity])('no page holds more than 200 messages, even when %s are asked for', async limit => {
    const { records, ids } = conversation(250);
    writeTranscript(records);

    const page = await readPage({ limit });

    expect(idsOf(page)).toEqual(ids.slice(50));
    expect(page.hasMore).toBe(true);
  });

  it('a limit that is not a number asks for nothing in particular: the default 50, never the whole transcript', async () => {
    const { records, ids } = conversation(250);
    writeTranscript(records);

    const page = await readPage({ limit: NaN });

    expect(idsOf(page)).toEqual(ids.slice(200));
    expect(page.hasMore).toBe(true);
  });

  it('a typed message longer than 4000 characters is cut there, and says so', async () => {
    const long = `Here is the whole log:\n${'x'.repeat(10_000)}`;
    writeTranscript([typed(long)]);

    expect((await readPage()).messages).toMatchObject([{ text: long.slice(0, 4000), truncated: true }]);
  });

  it('a tool answer the size of the largest block measured, 568 KB, is cut to 4000 as well', async () => {
    const output = 'compiling module graph\n'.repeat(24_700);
    writeTranscript([toolAnswer('toolu_build', [{ type: 'text', text: output }])]);

    expect((await readPage()).messages).toMatchObject([
      { text: output.slice(0, 4000), truncated: true, toolResult: { toolUseId: 'toolu_build', isError: false } },
    ]);
  });

  it('a message of exactly 4000 characters arrives whole and unmarked', async () => {
    const exact = 'y'.repeat(4000);
    writeTranscript([typed(exact)]);

    const { messages } = await readPage();

    expect(messages).toMatchObject([{ text: exact }]);
    expect(messages[0]).not.toHaveProperty('truncated');
  });
});

describe('security: a session id cannot point the read at another file', () => {
  // The id is spliced into a path, and it reaches the reader from an agent
  // record rather than from Tars itself. Each id below lands on a real
  // transcript planted where it points, so a guard that let one through would
  // be caught reading it, not merely failing to find anything.
  const OTHER_PROJECT = '/Users/someone/private/project';
  const OTHER_PROJECT_DIR = '-Users-someone-private-project';
  const OTHER_SESSION = '0d9b8c7a-6f5e-4d3c-8b2a-1f0e9d8c7b6a';
  const SECRET = 'rotate the production deploy key on friday';

  beforeEach(() => {
    writeTranscript(conversation(3).records);
    writeTranscript([typed(SECRET)], OTHER_PROJECT_DIR, OTHER_SESSION);
    fs.writeFileSync(path.join(home, 'planted.jsonl'), jsonl([typed(SECRET)]));
  });

  it('the planted transcript reads fine when addressed as itself, so each refusal below is the guard at work', async () => {
    const own = await readAgentTranscript({ sessionId: OTHER_SESSION, projectPath: OTHER_PROJECT, homeDir: home });

    expect(JSON.stringify(own)).toContain(SECRET);
  });

  it.each([
    ['sideways into another project', `../${OTHER_PROJECT_DIR}/${OTHER_SESSION}`],
    ['up and out of ~/.claude/projects', '../../../planted'],
    ['hidden behind a genuine session id', `${SESSION}/../../${OTHER_PROJECT_DIR}/${OTHER_SESSION}`],
  ])('refuses a traversal %s as no session id at all', async (_where, sessionId) => {
    const result = await read({ sessionId });

    expect(result).toMatchObject({ available: false, reason: 'no-session' });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
