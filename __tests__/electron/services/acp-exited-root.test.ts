import '../../setup/home-guard';
import { describe, it, expect, vi, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A delegated run whose agent has already exited is not ended by its id on
 * Windows (audit A21, win-reviewer's gate of 2026-09-25).
 *
 * Windows reuses a process id once nothing holds the process's handle, and
 * Node lets go of it when it has read the exit. taskkill /PID <id> /T then
 * ends whatever took that id, and everything under it. So stop() and the
 * quit end a tree only while the agent that leads it still runs.
 *
 * How it fails, written before the code (2026-09-25):
 * 1. stop() of a session whose agent's exit was read runs taskkill on its id.
 * 2. releaseForQuit() of that session hands its id to the quit, which runs
 *    taskkill on it.
 * 3. (the control) stop() of a session whose agent still runs does not run
 *    taskkill, and the guards above prove nothing.
 */

/** Every taskkill the product ran, by its argv. */
const taskkills: string[][] = [];
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: ((file: string, ...rest: unknown[]) => {
      if (/[\\/]taskkill\.exe$/i.test(file)) taskkills.push(rest[0] as string[]);
      return (actual.execFile as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof actual.execFile,
  };
});

import { AcpSession } from '../../../electron/services/acp/client';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-acp-exited-'));
afterAll(() => fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

/** Answers the handshake; asked for a turn, exits without answering, or holds on. */
const agent = path.join(tmp, 'agent.cjs');
fs.writeFileSync(agent, `
let buf = '';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const msg = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
    if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
    if (msg.method === 'session/prompt' && process.argv[2] === 'exit') process.exit(0);
  }
});
`);

/** A started session whose agent has exited, and whose exit Node has read. */
async function exitedSession(): Promise<AcpSession> {
  const session = new AcpSession({ command: process.execPath, args: [agent, 'exit'] }, { cwd: tmp });
  const exited = new Promise(resolve => session.once('exit', resolve));
  await session.start();
  await session.prompt('go', 10_000).catch(() => undefined);
  await exited;
  return session;
}

const settle = (ms = 500) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(process.platform !== 'win32')('a run whose agent has exited, on Windows', { timeout: 30_000 }, () => {
  it('1. is stopped without a taskkill on its id', async () => {
    const session = await exitedSession();
    taskkills.length = 0;

    session.stop();
    await settle();

    expect(taskkills).toEqual([]);
  });

  it('2. hands the quit no id to end', async () => {
    const session = await exitedSession();

    expect(session.releaseForQuit()).toBeUndefined();
  });

  it('3. (control) a run whose agent still runs is ended by taskkill on its id', async () => {
    const session = new AcpSession({ command: process.execPath, args: [agent, 'hold'] }, { cwd: tmp });
    const exited = new Promise(resolve => session.once('exit', resolve));
    await session.start();
    taskkills.length = 0;

    session.stop();
    await exited;

    expect(taskkills).toHaveLength(1);
    expect(taskkills[0]).toEqual(['/PID', expect.stringMatching(/^\d+$/), '/T', '/F']);
  });
});
