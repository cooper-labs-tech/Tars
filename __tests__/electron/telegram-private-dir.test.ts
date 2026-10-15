import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What Tars keeps out of the agents' directory cannot be sent to Telegram
 * either, by either of the two ways an agent has of sending a file.
 *
 * Found by the audit of lot 4: JeanBrasse's conversation with the super chat moved
 * from `~/.dorothy` to `~/.tars-private`, and both Telegram guards refuse
 * `~/.dorothy` by name, so the move took the file out of the only list that
 * kept it from being sent. One call to `send_telegram_document` with the new
 * path, and the conversation was in a chat. The webhook secret moved there in
 * the same lot.
 *
 * Both guards are the real ones: `isSafeTelegramPath`, which the app's three
 * `/api/telegram/send-*` routes call, and the MCP server's own three tools,
 * loaded from `mcp-telegram/src/index.ts` with the MCP SDK replaced by a fake
 * that keeps the handlers. No file named here exists, so a path the guard lets
 * through stops at "File not found", before any network: that is the witness
 * that a refusal came from the guard and not from something after it.
 */

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
const tools = new Map<string, Handler>();

/** The SDK the server gets: a McpServer that keeps the handlers, and a transport that connects to nothing. */
const FAKE_SDK: Record<string, () => unknown> = {
  '@modelcontextprotocol/sdk/server/mcp.js': () => ({
    McpServer: class {
      tool(name: string, _description: string, _schema: unknown, handler: Handler) { tools.set(name, handler); }
      async connect() {}
    },
  }),
  '@modelcontextprotocol/sdk/server/stdio.js': () => ({ StdioServerTransport: class {} }),
};

const SERVER_DIR = path.join(__dirname, '..', '..', 'mcp-telegram');

/**
 * The file the server's own import of `specifier` lands on, or the bare name
 * when nothing there provides it.
 *
 * vitest keys a mock by the file an import resolves to, and resolves each
 * import from the file that makes it. The root does not depend on the SDK, so
 * a `vi.mock('@modelcontextprotocol/sdk/...')` written in this file is keyed by
 * the bare name, and it met the server's import only where the server finds no
 * SDK either: a worktree, whose mcp-telegram has no node_modules. In the main
 * checkout the server's import lands in mcp-telegram/node_modules, the mock
 * missed it, and the real SDK took the three tools, and the worker's stdin
 * with them. Measured on 24f1889: green in the worktree the test was written
 * in, "was never registered" three times in the main checkout.
 *
 * Node's own ESM resolver, run from the server's directory, says where that
 * import lands, `import` condition and all. When it finds nothing, vitest
 * keys the server's unresolved import by the bare name, which is what is
 * returned then. A wrong answer cannot pass for a right one: the mock misses,
 * and the tests below find no tool registered.
 */
function whereTheServerFinds(specifier: string): string {
  try {
    const url = execFileSync(process.execPath, [
      '--input-type=module', '--eval', 'process.stdout.write(import.meta.resolve(process.env.SPECIFIER))',
    ], { cwd: SERVER_DIR, env: { ...process.env, SPECIFIER: specifier }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    return fileURLToPath(url);
  } catch {
    return specifier;
  }
}

// Nothing here may reach Telegram, whatever a guard lets through.
vi.mock('https', () => {
  const refuse = () => { throw new Error('a test reached the network'); };
  return { default: { get: refuse, request: refuse }, get: refuse, request: refuse };
});

import { isSafeTelegramPath } from '../../electron/services/api-routes/utils';
import * as constants from '../../electron/constants';
import { moveTestHome } from '../setup/test-home';

const home = os.homedir();
const PRIVATE_FILES = [
  path.join(home, '.tars-private', 'overseer.json'),
  path.join(home, '.tars-private', 'hermes-webhook-secret'),
];
const DATA_FILES = [
  path.join(home, '.dorothy', 'overseer.json'),
  path.join(home, '.dorothy', 'app-settings.json'),
];
const ORDINARY = path.join(home, 'Documents', 'not-there-report.pdf');

/**
 * Runs `body` as on a volume whose file ids are 64 bits wide, such as NTFS,
 * or a share whose client passes the server's ids through, as Linux's CIFS
 * does by default. Above 2^53 a
 * Number holds only some of the integers (every 256th near 2^60), so two ids
 * a few apart are two BigInts and one Number. Node's plain stat reports the
 * id as a Number, rounded; `{ bigint: true }` reports it whole.
 *
 * Every file keeps its real metadata, and its id is renumbered from 2^60 up,
 * far apart, except each pair in `twins`, whose ids are one apart. Only the
 * width of the id is made up: no volume the suite runs on (APFS, ext4) hands
 * out ids that wide, and mounting one takes root. The files, the hard links,
 * the real paths and the directory walks are the file system's own.
 */
async function onWideIds<T>(twins: Array<[string, string]>, body: () => T | Promise<T>): Promise<T> {
  // The CommonJS object, which a spy can replace, and every ESM view of it
  // brought up to date, the guards' included.
  const cjsFs = createRequire(import.meta.url)('fs') as typeof fs;
  const { statSync, lstatSync } = cjsFs;
  const ids = new Map<string, bigint>();
  let count = BigInt(0);
  const fresh = () => WIDE_IDS_FROM + WIDE_IDS_APART * count++;
  const keyOf = (whole: fs.BigIntStats) => `${whole.dev}:${whole.ino}`;
  for (const [a, b] of twins) {
    const id = fresh();
    ids.set(keyOf(statSync(a, { bigint: true })), id);
    ids.set(keyOf(statSync(b, { bigint: true })), id + BigInt(1));
  }
  const widen = (real: typeof fs.statSync) => (target: fs.PathLike, options?: fs.StatSyncOptions) => {
    const whole = real(target, { ...options, bigint: true });
    if (!whole) return whole;
    let id = ids.get(keyOf(whole));
    if (id === undefined) ids.set(keyOf(whole), id = fresh());
    if (options?.bigint) return Object.assign(whole, { ino: id });
    return Object.assign(real(target, options) as fs.Stats, { ino: Number(id) });
  };
  const spies = [
    vi.spyOn(cjsFs, 'statSync').mockImplementation(widen(statSync) as typeof fs.statSync),
    vi.spyOn(cjsFs, 'lstatSync').mockImplementation(widen(lstatSync) as typeof fs.lstatSync),
  ];
  syncBuiltinESMExports();
  try {
    return await body();
  } finally {
    for (const spy of spies) spy.mockRestore();
    syncBuiltinESMExports();
  }
}
const WIDE_IDS_FROM = BigInt(2) ** BigInt(60);
const WIDE_IDS_APART = BigInt(2) ** BigInt(20);

/** `a` and `b` are two files whose ids read as one Number: what the test that calls it is about. */
function expectTwoIdsOneNumber(a: string, b: string) {
  expect(fs.statSync(a, { bigint: true }).ino, `${a} and ${b} are one file, so this proves nothing`)
    .not.toBe(fs.statSync(b, { bigint: true }).ino);
  expect(fs.statSync(a).ino, `${a} and ${b} read as two numbers, so this proves nothing`)
    .toBe(fs.statSync(b).ino);
}

describe('the guard of the app\'s own Telegram routes', () => {
  it('refuses the private directory as it refuses the data directory', () => {
    for (const file of [...PRIVATE_FILES, ...DATA_FILES]) {
      expect(isSafeTelegramPath(file), file).toBe(false);
    }
    expect(isSafeTelegramPath(path.join(home, '.tars-private'))).toBe(false);
    // The witness: the guard is not simply refusing everything.
    expect(isSafeTelegramPath(ORDINARY)).toBe(true);
  });

  it('refuses them under the other names the file system gives them (case, Data volume, symlink)', () => {
    // The audit's lead #21 on the vault, the same prefix test here: an existing
    // key or secret, named another way, passed. Files that exist, since only
    // an existing file has another name.
    const ssh = path.join(home, '.ssh');
    fs.mkdirSync(ssh, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ssh, 'id_rsa'), 'a private key', { mode: 0o600 });
    fs.mkdirSync(path.join(home, '.tars-private'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(PRIVATE_FILES[1], 'the webhook secret', { mode: 0o600 });
    const aliases: string[] = [];
    const upper = path.join(home, '.SSH', 'id_rsa');
    if (fs.existsSync(upper)) aliases.push(upper, path.join(home, '.TARS-PRIVATE', 'hermes-webhook-secret'));
    const data = path.join('/System/Volumes/Data', fs.realpathSync(path.join(ssh, 'id_rsa')));
    if (fs.existsSync(data)) aliases.push(data);
    const link = path.join(home, 'Documents', 'keys');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.rmSync(link, { force: true });
    // A junction: Windows lets any account make one, where a symlink needs a privilege; the type is ignored off Windows.
    fs.symlinkSync(ssh, link, 'junction');
    aliases.push(path.join(link, 'id_rsa'));
    for (const alias of aliases) expect(isSafeTelegramPath(alias), alias).toBe(false);
    // The witness: an ordinary file that exists still goes.
    const report = path.join(home, 'Documents', 'report.pdf');
    fs.writeFileSync(report, 'a report');
    expect(isSafeTelegramPath(report)).toBe(true);
  });

  /**
   * A hard link is a second name for the file with no path back to the first,
   * so a check that follows paths finds it inside nothing (the audit's gate of
   * #137). How the check for it can fail, written before it:
   * 1. a hard link made outside, to a file in the private directory or in ~/.ssh, is sent;
   * 2. every file with a second name is refused: a pnpm store is made of them;
   * 3. a copy, which is another file with the same bytes, is refused;
   * 4. the search leaves a protected directory through a symlink inside it.
   */
  it('refuses a hard link to a file in the private directory or in ~/.ssh, and nothing else with two names', () => {
    const docs = path.join(home, 'Documents');
    fs.mkdirSync(docs, { recursive: true });
    fs.mkdirSync(path.join(home, '.tars-private'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(PRIVATE_FILES[1], 'the webhook secret', { mode: 0o600 });
    const key = path.join(home, '.ssh', 'id_ed25519');
    fs.mkdirSync(path.dirname(key), { recursive: true, mode: 0o700 });
    fs.writeFileSync(key, 'a private key', { mode: 0o600 });
    const link = (target: string, name: string) => {
      const at = path.join(docs, name);
      fs.rmSync(at, { force: true });
      fs.linkSync(target, at);
      return at;
    };

    expect(isSafeTelegramPath(link(PRIVATE_FILES[1], 'notes.txt'))).toBe(false);
    expect(isSafeTelegramPath(link(key, 'key-backup.txt'))).toBe(false);

    const first = path.join(docs, 'store-first.pdf');
    fs.writeFileSync(first, 'one file, two names');
    const second = link(first, 'store-second.pdf');
    const copy = path.join(docs, 'copy-of-the-secret.txt');
    fs.copyFileSync(PRIVATE_FILES[1], copy);
    const exit = path.join(home, '.tars-private', 'to-documents');
    fs.rmSync(exit, { force: true });
    fs.symlinkSync(docs, exit, 'junction');
    try {
      expect(isSafeTelegramPath(second), 'a file with two ordinary names').toBe(true);
      expect(isSafeTelegramPath(copy), 'a copy is another file').toBe(true);
    } finally {
      fs.rmSync(exit, { force: true });
    }
  });

  /**
   * A file is told from another by its whole id. On a volume whose ids are 64
   * bits wide, two ids a few apart read as one Number (onWideIds says where).
   * How the guard can fail there, written before the fix:
   * 1. an ordinary file with two names is refused, because a file in the
   *    private directory reads as the same Number;
   * 2. a file in an ordinary folder is refused, because the folder reads as
   *    the same Number as ~/.ssh;
   * 3. a file outside the home is sent, because the folder it is in reads as
   *    the same Number as the home;
   * 4. once ids are compared whole, a real second name for the secret, a key
   *    in ~/.ssh or a file in the home is judged the wrong way round.
   */
  it('does not take a file with two names for one in the private directory because their ids read as one Number', async () => {
    const docs = path.join(home, 'Documents');
    fs.mkdirSync(docs, { recursive: true });
    const secret = path.join(home, '.tars-private', 'wide-ids-secret');
    fs.mkdirSync(path.dirname(secret), { recursive: true, mode: 0o700 });
    fs.writeFileSync(secret, 'the webhook secret', { mode: 0o600 });
    const first = path.join(docs, 'wide-ids-first.pdf');
    const second = path.join(docs, 'wide-ids-second.pdf');
    const notes = path.join(docs, 'wide-ids-notes.txt');
    for (const at of [first, second, notes]) fs.rmSync(at, { force: true });
    fs.writeFileSync(first, 'one file, two names');
    fs.linkSync(first, second);
    fs.linkSync(secret, notes);

    await onWideIds([[second, secret]], () => {
      expectTwoIdsOneNumber(second, secret);
      expect(isSafeTelegramPath(second), 'an ordinary file with two names').toBe(true);
      expect(isSafeTelegramPath(notes), 'a second name for the secret').toBe(false);
    });
  });

  it('does not take a folder for ~/.ssh because their ids read as one Number', async () => {
    const ssh = path.join(home, '.ssh');
    fs.mkdirSync(ssh, { recursive: true, mode: 0o700 });
    const key = path.join(ssh, 'wide-ids-key');
    fs.writeFileSync(key, 'a private key', { mode: 0o600 });
    const folder = path.join(home, 'Documents', 'wide-ids-folder');
    fs.mkdirSync(folder, { recursive: true });
    const report = path.join(folder, 'report.pdf');
    fs.writeFileSync(report, 'a report');

    await onWideIds([[folder, ssh]], () => {
      expectTwoIdsOneNumber(folder, ssh);
      expect(isSafeTelegramPath(report), 'a file in an ordinary folder').toBe(true);
      expect(isSafeTelegramPath(key), 'a key in ~/.ssh').toBe(false);
    });
  });

  it('does not take a folder outside the home for the home because their ids read as one Number', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wide-ids-outside-'));
    try {
      const report = path.join(outside, 'report.pdf');
      fs.writeFileSync(report, 'a file outside the home');
      expect(report.startsWith(home + path.sep), `${report} is in the home, so this proves nothing`).toBe(false);
      const inside = path.join(home, 'wide-ids-report.pdf');
      fs.writeFileSync(inside, 'a file in the home');

      await onWideIds([[outside, home]], () => {
        expectTwoIdsOneNumber(outside, home);
        expect(isSafeTelegramPath(report), 'a file outside the home').toBe(false);
        expect(isSafeTelegramPath(inside), 'a file in the home').toBe(true);
      });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses the files the app itself puts there, wherever the constants say they are', () => {
    // Held to the constants rather than to a spelling, so a renamed directory
    // cannot quietly leave the guard behind.
    for (const file of [constants.OVERSEER_FILE, constants.HERMES_WEBHOOK_SECRET_FILE, constants.OVERSEER_LEGACY_FILE]) {
      expect(file.startsWith(home + path.sep), `${file} is not under this HOME`).toBe(true);
      expect(isSafeTelegramPath(file), file).toBe(false);
    }
  });
});

describe('the Telegram MCP server, which every agent is given', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-telegram-home-'));
  let restoreHome: () => void;

  beforeAll(async () => {
    // The server reads its settings from the home it starts in.
    restoreHome = moveTestHome(tmpHome);
    fs.mkdirSync(path.join(tmpHome, '.dorothy'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.dorothy', 'app-settings.json'), JSON.stringify({
      telegramBotToken: 'not-a-real-bot', telegramChatId: '1',
    }));
    for (const [specifier, fake] of Object.entries(FAKE_SDK)) vi.doMock(whereTheServerFinds(specifier), fake);
    await import('../../mcp-telegram/src/index');
  });

  afterAll(() => {
    restoreHome();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const SENDERS = [
    ['send_telegram_document', 'document_path'],
    ['send_telegram_photo', 'photo_path'],
    ['send_telegram_video', 'video_path'],
  ] as const;

  for (const [tool, arg] of SENDERS) {
    it(`${tool} refuses a hard link to a file in the private directory or in ~/.ssh, and nothing else with two names`, async () => {
      // The same list as the app's guard above, on this one.
      const docs = path.join(tmpHome, 'Documents');
      fs.mkdirSync(docs, { recursive: true });
      const secret = path.join(tmpHome, '.tars-private', 'hermes-webhook-secret');
      fs.mkdirSync(path.dirname(secret), { recursive: true, mode: 0o700 });
      fs.writeFileSync(secret, 'the webhook secret', { mode: 0o600 });
      const key = path.join(tmpHome, '.ssh', 'id_ed25519');
      fs.mkdirSync(path.dirname(key), { recursive: true, mode: 0o700 });
      fs.writeFileSync(key, 'a private key', { mode: 0o600 });
      const link = (target: string, name: string) => {
        const at = path.join(docs, `${tool}-${name}`);
        fs.rmSync(at, { force: true });
        fs.linkSync(target, at);
        return at;
      };
      const send = tools.get(tool)!;

      for (const linked of [link(secret, 'notes.txt'), link(key, 'key-backup.txt')]) {
        const result = await send({ [arg]: linked });
        expect(result.isError, linked).toBe(true);
        expect(result.content[0].text, linked).toContain('Refused');
      }

      // The witnesses exist, so the guard letting them through takes them to
      // the network, which this file refuses: that refusal, not the guard's.
      const first = path.join(docs, `${tool}-store-first.pdf`);
      fs.writeFileSync(first, 'one file, two names');
      const copy = path.join(docs, `${tool}-copy-of-the-secret.txt`);
      fs.copyFileSync(secret, copy);
      const exit = path.join(tmpHome, '.tars-private', 'to-documents');
      fs.rmSync(exit, { force: true });
      fs.symlinkSync(docs, exit, 'junction');
      try {
        for (const file of [link(first, 'store-second.pdf'), copy]) {
          const result = await send({ [arg]: file });
          expect(result.content[0].text, file).not.toContain('Refused');
          expect(result.content[0].text, file).toContain('a test reached the network');
        }
      } finally {
        fs.rmSync(exit, { force: true });
      }
    });

    it(`${tool} refuses the private directory as it refuses the data directory`, async () => {
      const send = tools.get(tool);
      expect(send, `${tool} was never registered`).toBeDefined();

      for (const dir of ['.tars-private', '.dorothy']) {
        const result = await send!({ [arg]: path.join(tmpHome, dir, 'overseer.json') });
        expect(result.isError).toBe(true);
        expect(result.content[0].text, `${tool} would send ~/${dir}`).toContain(`Refused: ${dir} holds credentials`);
      }

      // The witness: an ordinary path gets past the guard and stops at the
      // file not being there, so the refusals above are the guard's.
      const ordinary = await send!({ [arg]: path.join(tmpHome, 'Documents', 'report.pdf') });
      expect(ordinary.content[0].text).toContain('File not found');
    });

    it(`${tool} refuses the private directory under its other names (case, symlink)`, async () => {
      // The audit's lead #21, on this guard: a segment compared by its exact
      // spelling, and the path as named rather than the file it opens.
      const secret = path.join(tmpHome, '.tars-private', 'hermes-webhook-secret');
      fs.mkdirSync(path.dirname(secret), { recursive: true, mode: 0o700 });
      fs.writeFileSync(secret, 'the webhook secret', { mode: 0o600 });
      const link = path.join(tmpHome, 'Documents', `looks-harmless-${tool}`);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.rmSync(link, { force: true });
      fs.symlinkSync(path.dirname(secret), link, 'junction');
      const aliases = [path.join(link, 'hermes-webhook-secret')];
      const upper = path.join(tmpHome, '.TARS-PRIVATE', 'hermes-webhook-secret');
      if (fs.existsSync(upper)) aliases.push(upper);

      const send = tools.get(tool)!;
      for (const alias of aliases) {
        const result = await send({ [arg]: alias });
        expect(result.isError, alias).toBe(true);
        expect(result.content[0].text, alias).toContain('Refused');
      }
    });
  }

  it('does not take a file with two names for one in the private directory because their ids read as one Number', async () => {
    // The server's own copy of the hard link search, held to the case the
    // app's guard is held to above.
    const docs = path.join(tmpHome, 'Documents');
    fs.mkdirSync(docs, { recursive: true });
    const secret = path.join(tmpHome, '.tars-private', 'wide-ids-secret');
    fs.mkdirSync(path.dirname(secret), { recursive: true, mode: 0o700 });
    fs.writeFileSync(secret, 'the webhook secret', { mode: 0o600 });
    const first = path.join(docs, 'wide-ids-first.pdf');
    const second = path.join(docs, 'wide-ids-second.pdf');
    const notes = path.join(docs, 'wide-ids-notes.txt');
    for (const at of [first, second, notes]) fs.rmSync(at, { force: true });
    fs.writeFileSync(first, 'one file, two names');
    fs.linkSync(first, second);
    fs.linkSync(secret, notes);
    const send = tools.get('send_telegram_document')!;

    await onWideIds([[second, secret]], async () => {
      expectTwoIdsOneNumber(second, secret);
      const ordinary = await send({ document_path: second });
      expect(ordinary.content[0].text, 'an ordinary file with two names').not.toContain('Refused');
      expect(ordinary.content[0].text).toContain('a test reached the network');
      const linked = await send({ document_path: notes });
      expect(linked.content[0].text, 'a second name for the secret').toContain('Refused');
    });
  });
});
