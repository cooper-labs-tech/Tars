import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { format } from 'util';
import { hasPosixModes } from '../../setup/platform-limits';

/**
 * JeanBrasse's conversation with the super chat leaves the directory the agents are
 * handed, and no message is lost on the way.
 *
 * Measured on b17db0f: `~/.tars/overseer.json`, 148,654 bytes, 344 message
 * objects, mode 0644. Every agent is started with `--add-dir ~/.tars`, so
 * reading it took no API call, no token and no permission prompt: an `ls` of
 * the directory it was pointed at, and a `cat`. It now lives in
 * `~/.tars-private/`, which is handed to nothing.
 *
 * That is a smaller claim than it sounds, and the tests do not pretend
 * otherwise: an agent whose Bash can read $HOME can still read the new path if
 * it goes looking for it, and 37 of the 42 agents on this machine run with
 * `--dangerously-skip-permissions`. What moves is the file being *in* the
 * directory the agent is given, on the listing it gets for free. Closing the
 * rest takes a sandbox.
 *
 * So what is tested here is the migration, because it handles JeanBrasse's own data:
 * it moves, it verifies before it deletes, it leaves the old file alone when
 * it cannot finish, it does not run twice, and the Chat keeps reading the
 * history throughout.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-overseer-move-'));
const LEGACY = path.join(tmp, 'overseer.json');
const PRIVATE_DIR = path.join(tmp, 'private');
const PRIVATE = path.join(PRIVATE_DIR, 'overseer.json');

vi.mock('../../../electron/constants', () => ({
  DATA_DIR: tmp,
  API_PORT: 31974,
  dataPath: (...s: string[]) => path.join(tmp, ...s),
  privatePath: (...s: string[]) => path.join(PRIVATE_DIR, ...s),
  OVERSEER_FILE: PRIVATE,
  OVERSEER_LEGACY_FILE: LEGACY,
}));
/** Set for one write: the next copy of the private file lands truncated, the
 *  shape of a full disk or a filesystem that says yes and does not. A spy is
 *  no use here, because each start re-imports the module it would be set on. */
let truncateNextPrivateWrite = false;
vi.mock('../../../electron/utils/secret-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/utils/secret-file')>();
  return {
    ...actual,
    writeSecretFileSync: (file: string, contents: string) => {
      const half = truncateNextPrivateWrite && file === PRIVATE;
      if (half) truncateNextPrivateWrite = false;
      return actual.writeSecretFileSync(file, half ? contents.slice(0, 40) : contents);
    },
  };
});
vi.mock('../../../electron/core/agent-manager', () => ({ agents: new Map() }));
vi.mock('../../../electron/services/git-review', () => ({ repoSummary: async () => ({ success: false }) }));
vi.mock('../../../electron/services/hermes-config', () => ({
  usableHermesConnection: () => ({ url: 'http://gateway.test', token: 't' }),
}));
vi.mock('../../../electron/services/hermes-client', () => ({
  probeHermes: async () => ({ reachable: false }),
  createHermesCron: async () => ({ success: false }),
  updateHermesCron: async () => ({ success: false }),
  hermesCronAction: async () => ({ success: false }),
  fetchHermesCronRuns: async () => ({ success: false, runs: [] }),
  fetchHermesSessionMessages: async () => ({ success: false, messages: [] }),
  fetchHermesModelOptions: async () => ({ success: false, providers: [] }),
  setHermesModel: async () => ({ success: false }),
}));
vi.mock('../../../electron/services/hermes-session', () => ({
  liveTransportAvailable: () => false,
  conversationRefused: () => false,
  openConversation: async () => { throw new Error('no live transport in tests'); },
}));

type Overseer = typeof import('../../../electron/services/overseer');

/**
 * A start of the app: the module is loaded afresh and the migration runs, the
 * way `app.whenReady()` runs it in main.ts. Calling it there rather than on
 * the first read is the difference between moving the file at launch and
 * leaving it in place for the whole of a run in which the Chat is never
 * opened; the last test in this file holds main.ts to that call.
 */
async function start(): Promise<Overseer> {
  vi.resetModules();
  const overseer = await import('../../../electron/services/overseer');
  overseer.migrateOverseerOutOfAgentReach();
  return overseer;
}

function conversation(texts: string[]): string {
  return JSON.stringify({
    jobId: 'job-1',
    messages: texts.map((text, i) => ({
      id: `m-${i}`, role: i % 2 ? 'overseer' : 'user', text, action: null,
      timestamp: new Date(Date.parse('2026-09-01T10:00:00Z') + i * 1000).toISOString(),
    })),
    previousSnapshot: null, longRunningReported: [], paused: false,
  }, null, 2);
}

const USER_SAID = ['what is the fleet doing', 'three agents are running', 'ship it'];

function textsOf(o: Overseer): string[] {
  return o.getOverseerHistory().map(m => m.text);
}

beforeEach(() => {
  truncateNextPrivateWrite = false;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
});

describe('a conversation still in the directory the agents are handed', () => {
  it('moves out of it, whole, and the Chat reads it where it lands', async () => {
    fs.writeFileSync(LEGACY, conversation(USER_SAID), { mode: 0o644 });

    const overseer = await start();
    const history = textsOf(overseer);

    expect(history).toEqual(USER_SAID);
    expect(fs.existsSync(PRIVATE), 'the conversation never reached the private directory').toBe(true);
    expect(fs.existsSync(LEGACY), 'it is still readable in the directory every agent is given').toBe(false);
    // Byte for byte: a migration that reserialised could drop a field the
    // state file carries and nothing here would notice.
    expect(fs.readFileSync(PRIVATE, 'utf-8')).toBe(conversation(USER_SAID));
  });

  it.skipIf(!hasPosixModes())('lands at 0600, where it used to sit at 0644 for every account on the machine', async () => {
    fs.writeFileSync(LEGACY, conversation(USER_SAID), { mode: 0o644 });

    await start();

    expect(fs.statSync(PRIVATE).mode & 0o777).toBe(0o600);
    // Not a defence against the agents, which run as JeanBrasse. It is the other
    // accounts on the machine, and it costs nothing.
    expect(fs.statSync(PRIVATE_DIR).mode & 0o077).toBe(0);
  });

  it('does not run again on the next start, and writes nothing back into the old place', async () => {
    fs.writeFileSync(LEGACY, conversation(USER_SAID));
    await start();

    const second = await start();
    second.setOverseerSettings({ watchIntervalMs: 120000 });

    expect(textsOf(second)).toEqual(USER_SAID);
    expect(fs.existsSync(LEGACY), 'a save put the conversation back where the agents are').toBe(false);
    expect(fs.readdirSync(tmp).filter(f => f !== 'private')).toEqual([]);
  });
});

describe('a migration that could not be made', () => {
  it('keeps reading the old file rather than starting JeanBrasse an empty chat', async () => {
    fs.writeFileSync(LEGACY, conversation(USER_SAID));
    // The private directory cannot be created: a file already holds the name.
    fs.writeFileSync(PRIVATE_DIR, 'not a directory');

    const overseer = await start();

    expect(textsOf(overseer)).toEqual(USER_SAID);
    expect(fs.existsSync(LEGACY), 'the only copy was deleted').toBe(true);
    expect(fs.readFileSync(LEGACY, 'utf-8')).toBe(conversation(USER_SAID));
  });

  it('leaves an unreadable old file exactly where it is, and starts fresh', async () => {
    // Half a file from a process that died mid-write, back when this was not
    // written atomically. Copying it would only move the problem.
    fs.writeFileSync(LEGACY, '{"jobId": "job-1", "messages": [{"text": "cut off here');

    const overseer = await start();

    expect(textsOf(overseer)).toEqual([]);
    expect(fs.existsSync(PRIVATE), 'something that is not the state was copied across').toBe(false);
    expect(fs.readFileSync(LEGACY, 'utf-8')).toContain('cut off here');
  });

  it('never deletes the old file against a copy that did not land', async () => {
    fs.writeFileSync(LEGACY, conversation(USER_SAID));
    // The write says it succeeded and put down something else.
    truncateNextPrivateWrite = true;

    const overseer = await start();

    expect(fs.existsSync(LEGACY), "JeanBrasse's conversation was deleted against a half copy").toBe(true);
    expect(fs.existsSync(PRIVATE), 'a half file was left for the next start to adopt').toBe(false);
    expect(textsOf(overseer)).toEqual(USER_SAID);
  });

  it('gets the conversation across on the start after that one', async () => {
    fs.writeFileSync(LEGACY, conversation(USER_SAID));
    truncateNextPrivateWrite = true;
    await start();

    const second = await start();

    expect(textsOf(second)).toEqual(USER_SAID);
    expect(fs.existsSync(PRIVATE)).toBe(true);
    expect(fs.existsSync(LEGACY)).toBe(false);
  });
});

describe('a save the private directory cannot take', () => {
  // Found by the QA's gate of this lot (24f1889): the fallback write could be
  // deleted, and the read that takes the file out again could lose its
  // migration, with every test in this file still green.

  it('goes back to the old place rather than lose what JeanBrasse just set', async () => {
    // The private directory cannot be created: a file already holds the name.
    fs.writeFileSync(PRIVATE_DIR, 'not a directory');
    const overseer = await start();

    overseer.setOverseerSettings({ watchIntervalMs: 120000 });

    const next = await start();
    expect(next.getOverseerSettings().watchIntervalMs, 'the setting was lost with the write').toBe(120000);
    if (hasPosixModes()) expect(fs.statSync(LEGACY).mode & 0o777).toBe(0o600);
  });

  it('is taken out of the agents\' directory by the next read, once the private one can be written', async () => {
    // After a save that fell back, the next read or write of this run tries
    // the move again, rather than leave the conversation in ~/.tars until
    // the next start. A read that skipped the move left it there until
    // something happened to write.
    fs.writeFileSync(PRIVATE_DIR, 'not a directory');
    const overseer = await start();
    overseer.setOverseerSettings({ watchIntervalMs: 120000 });
    expect(fs.existsSync(LEGACY), 'the save that fell back wrote nothing').toBe(true);
    // Whatever held the private directory's name is gone.
    fs.rmSync(PRIVATE_DIR, { force: true });

    const settings = overseer.getOverseerSettings();

    expect(settings.watchIntervalMs).toBe(120000);
    expect(fs.existsSync(LEGACY), 'a read left the conversation in the directory every agent is handed').toBe(false);
    expect(JSON.parse(fs.readFileSync(PRIVATE, 'utf-8')).settings.watchIntervalMs).toBe(120000);
  });
});

describe('a conversation file that does not parse', () => {
  it('starts fresh without quoting a word of it into the log', async () => {
    // Node's JSON.parse quotes the start of its input in its message, and the
    // input here is JeanBrasse's conversation: logging the error itself, rather
    // than what kind it is, put his words in a log that is not 0600. The QA's
    // gate of this lot made that change with every test green (24f1889). The
    // witness first: these bytes are quoted by the parser, so a log line that
    // carried the error would carry them. It quotes ten characters: the words
    // fit in them.
    const said = 'Sam told the chat: ship it';
    let parserSays = '';
    try { JSON.parse(said); } catch (err) { parserSays = String(err); }
    expect(parserSays, 'the parser does not quote this input, so nothing below could fail').toContain('Sam told');

    fs.mkdirSync(PRIVATE_DIR, { recursive: true });
    fs.writeFileSync(PRIVATE, said);
    const logged: string[] = [];
    const spies = (['error', 'warn', 'log', 'info'] as const).map(level =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(format(...args)); }));
    let history: string[] | undefined;
    try {
      history = textsOf(await start());
    } finally {
      spies.forEach(spy => spy.mockRestore());
    }

    expect(history).toEqual([]);
    expect(logged.some(line => line.includes('could not read the conversation')), 'the read never failed').toBe(true);
    expect(logged.filter(line => line.includes('Sam told'))).toEqual([]);
  });
});

describe('both files at once', () => {
  it('keeps the private one and takes the old one out of the agents\' reach without deleting it', async () => {
    // A migration interrupted between the copy and the delete, or an older
    // build run after the move, which would have started a fresh file in the
    // old place and written JeanBrasse's next lines into it.
    fs.mkdirSync(PRIVATE_DIR, { recursive: true });
    fs.writeFileSync(PRIVATE, conversation(USER_SAID));
    fs.writeFileSync(LEGACY, conversation(['said to an older build']));

    const overseer = await start();

    expect(textsOf(overseer), 'the few lines of the old file hid the whole history').toEqual(USER_SAID);
    expect(fs.existsSync(LEGACY), 'the old conversation stayed where the agents are').toBe(false);
    const kept = fs.readdirSync(PRIVATE_DIR).filter(f => f.startsWith('overseer.superseded-'));
    expect(kept, 'the old file was deleted rather than kept').toHaveLength(1);
    expect(fs.readFileSync(path.join(PRIVATE_DIR, kept[0]), 'utf-8')).toContain('said to an older build');
  });
});

describe('the app itself', () => {
  it('puts the conversation outside the directory the agents are handed', async () => {
    // The paths every test above works with are this file's own, so nothing in
    // it would notice the real constant pointing back into ~/.tars. These
    // are the real ones.
    const real = await vi.importActual<typeof import('../../../electron/constants')>('../../../electron/constants');

    expect(real.OVERSEER_LEGACY_FILE.startsWith(real.DATA_DIR + path.sep), 'the old path is not in the data directory').toBe(true);
    expect(real.OVERSEER_FILE.startsWith(real.DATA_DIR + path.sep)).toBe(false);
    expect(real.OVERSEER_FILE.startsWith(real.PRIVATE_DIR + path.sep)).toBe(true);
    expect(real.PRIVATE_DIR.startsWith(real.DATA_DIR + path.sep)).toBe(false);
  });

  it('moves the file when it starts, not when something first reads it', () => {
    // A run in which JeanBrasse never opens the Chat reads no state, so a migration
    // that only happens on the first read never happens at all, and the file
    // stays in ~/.tars for the length of that run. The call belongs in
    // whenReady, which is the one place that runs once per start.
    const main = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.ts'), 'utf-8');
    const ready = main.slice(main.indexOf('app.whenReady()'));
    const body = ready.slice(0, ready.indexOf('\n});') + 4);

    expect(main, 'main.ts does not import the migration at all').toContain('migrateOverseerOutOfAgentReach');
    expect(body, 'the migration is not called from whenReady').toContain('migrateOverseerOutOfAgentReach()');
  });
});

describe('nothing to migrate', () => {
  it('creates no private file for a Tars that never had a conversation', async () => {
    const overseer = await start();

    expect(textsOf(overseer)).toEqual([]);
    expect(fs.existsSync(PRIVATE)).toBe(false);
    expect(fs.existsSync(LEGACY)).toBe(false);
  });

  it('writes the first message straight into the private directory, at 0600', async () => {
    const overseer = await start();

    overseer.setOverseerSettings({ watchIntervalMs: 120000 });

    expect(fs.existsSync(PRIVATE)).toBe(true);
    expect(fs.existsSync(LEGACY), 'a fresh install still writes into the agents\' directory').toBe(false);
    // Every save, not only the one the migration makes: the mode a file is
    // created with is the mode it keeps.
    if (hasPosixModes()) expect(fs.statSync(PRIVATE).mode & 0o777).toBe(0o600);
  });

  it('creates the private directory at 0700 on an install that had nothing to migrate', async () => {
    // Found by the audit of lot 4: only the migration made the directory 0700,
    // and it has nothing to do on a new install, so the first save made it
    // with the default mode, 0755 here. The witness first: a directory made
    // the ordinary way in this run is open to the other accounts.
    const probe = path.join(tmp, 'probe');
    fs.mkdirSync(probe);
    const ordinary = fs.statSync(probe).mode & 0o077;
    fs.rmdirSync(probe);
    if (hasPosixModes()) expect(ordinary, 'this umask would hide the defect').not.toBe(0);

    const overseer = await start();
    overseer.setOverseerSettings({ watchIntervalMs: 120000 });

    expect(fs.existsSync(LEGACY), 'there was something to migrate after all').toBe(false);
    if (hasPosixModes()) expect(fs.statSync(PRIVATE_DIR).mode & 0o777).toBe(0o700);
  });

  it('does not migrate a second time in the same run, and reads the private file when both exist', async () => {
    const overseer = await start();
    overseer.setOverseerSettings({ watchIntervalMs: 120000 });
    fs.writeFileSync(PRIVATE, conversation(USER_SAID));
    // An older build running beside this one, writing where it always did.
    fs.writeFileSync(LEGACY, conversation(['said to an older build']));

    expect(textsOf(overseer), 'the old file was preferred to the private one').toEqual(USER_SAID);
    expect(fs.existsSync(LEGACY), 'the migration ran a second time in the same run').toBe(true);
  });
});
