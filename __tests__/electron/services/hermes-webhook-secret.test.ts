import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hasPosixModes } from '../../setup/platform-limits';

/**
 * The Hermes webhook secret lives where the agents are not pointed.
 *
 * It opens the one route that dispatches to any agent of any project, which is
 * the reach of JeanBrasse's own chat. Until lot 4 it sat in `~/.dorothy`, the
 * directory every agent is started with, next to the shared token that the
 * webhook also accepted: closing the second and leaving the first there would
 * only have changed which file an agent reads to drive the fleet.
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-hermes-data-'));
const privateDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-hermes-private-')), 'private');
const SECRET_FILE = path.join(privateDir, 'hermes-webhook-secret');
const LEGACY_FILE = path.join(dataDir, 'hermes-webhook-secret');

vi.mock('../../../electron/constants', () => ({
  HERMES_WEBHOOK_SECRET_FILE: SECRET_FILE,
  HERMES_WEBHOOK_SECRET_LEGACY_FILE: LEGACY_FILE,
}));
/** Set for one write: the next copy into the private directory lands cut
 *  short, the shape of a full disk or a filesystem that says yes and does not.
 *  A spy is no use here, because each start re-imports the module it would be
 *  set on. */
let truncateNextPrivateWrite = false;
vi.mock('../../../electron/utils/secret-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../electron/utils/secret-file')>();
  return {
    ...actual,
    writeSecretFileSync: (file: string, contents: string) => {
      const cut = truncateNextPrivateWrite && file === SECRET_FILE;
      if (cut) truncateNextPrivateWrite = false;
      return actual.writeSecretFileSync(file, cut ? contents.slice(0, 40) : contents);
    },
  };
});

type SecretModule = typeof import('../../../electron/services/hermes-webhook-secret');

/** A start of the app: the module is loaded afresh, as main.ts loads it. */
async function load(): Promise<SecretModule> {
  vi.resetModules();
  return import('../../../electron/services/hermes-webhook-secret');
}

/** Every file under the data directory that holds `value`. */
function filesHolding(dir: string, value: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesHolding(full, value));
    else if (fs.readFileSync(full, 'utf-8').includes(value)) found.push(path.relative(dataDir, full));
  }
  return found;
}

beforeEach(() => {
  truncateNextPrivateWrite = false;
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.rmSync(privateDir, { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(path.dirname(privateDir), { recursive: true, force: true });
});

describe('a new install', () => {
  it('mints the secret in the private directory, and nothing of it in the data directory', async () => {
    const { provisionWebhookSecret } = await load();

    const secret = provisionWebhookSecret();

    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(SECRET_FILE, 'utf-8')).toBe(secret);
    if (hasPosixModes()) {
      expect(fs.statSync(SECRET_FILE).mode & 0o777).toBe(0o600);
      expect(fs.statSync(privateDir).mode & 0o777).toBe(0o700);
    }
    // The witness that the walk reads files at all.
    fs.writeFileSync(path.join(dataDir, 'api-token'), secret.slice(0, 16));
    expect(filesHolding(dataDir, secret.slice(0, 16))).toEqual(['api-token']);
    expect(filesHolding(dataDir, secret)).toEqual([]);
  });

  it('hands out the same secret every time it is asked', async () => {
    const { provisionWebhookSecret, isWebhookSecret } = await load();

    const first = provisionWebhookSecret();

    expect(provisionWebhookSecret()).toBe(first);
    expect(isWebhookSecret(first)).toBe(true);
  });

  it('matches nothing while none is configured', async () => {
    // An absent secret was an absent check. It is a shut door now: nothing,
    // the empty string included, is taken for a secret that does not exist.
    const { isWebhookSecret } = await load();

    expect(isWebhookSecret('')).toBe(false);
    expect(isWebhookSecret('f'.repeat(64))).toBe(false);
    expect(fs.existsSync(SECRET_FILE), 'asking created one').toBe(false);
  });
});

describe('an install that has it in ~/.dorothy', () => {
  const HELD_BY_HERMES = 'c'.repeat(64);

  it('moves it out when it starts, with the value Hermes holds', async () => {
    fs.writeFileSync(LEGACY_FILE, `${HELD_BY_HERMES}\n`, { mode: 0o600 });
    const { migrateWebhookSecretOutOfAgentReach, isWebhookSecret } = await load();

    migrateWebhookSecretOutOfAgentReach();

    expect(fs.existsSync(LEGACY_FILE), 'still in the directory every agent is handed').toBe(false);
    expect(fs.readFileSync(SECRET_FILE, 'utf-8')).toBe(HELD_BY_HERMES);
    if (hasPosixModes()) expect(fs.statSync(SECRET_FILE).mode & 0o777).toBe(0o600);
    expect(isWebhookSecret(HELD_BY_HERMES), 'Hermes was locked out by the move').toBe(true);
  });

  it('opens to nobody when it cannot be moved, rather than go on honouring the old place', async () => {
    fs.writeFileSync(LEGACY_FILE, HELD_BY_HERMES, { mode: 0o600 });
    // The private directory cannot be made: a file already holds its name.
    fs.mkdirSync(path.dirname(privateDir), { recursive: true });
    fs.writeFileSync(privateDir, 'not a directory');
    const { isWebhookSecret } = await load();

    expect(isWebhookSecret(HELD_BY_HERMES)).toBe(false);
    expect(fs.readFileSync(LEGACY_FILE, 'utf-8'), 'the only copy was lost').toBe(HELD_BY_HERMES);
    fs.rmSync(privateDir, { force: true });
  });

  it('never deletes the copy Hermes holds against a private one that did not land', async () => {
    // Copied, read back, and only then deleted. Here the write says it
    // succeeded and put down something else. Without the read-back the old
    // file went, and the webhook opened to the first 40 characters of the
    // secret while refusing Hermes the whole of it; no test noticed the
    // read-back gone (the QA's gate of this lot, on 24f1889).
    fs.writeFileSync(LEGACY_FILE, HELD_BY_HERMES, { mode: 0o600 });
    truncateNextPrivateWrite = true;
    const { migrateWebhookSecretOutOfAgentReach } = await load();

    migrateWebhookSecretOutOfAgentReach();

    expect(fs.readFileSync(LEGACY_FILE, 'utf-8'), 'the secret was deleted against a half copy').toBe(HELD_BY_HERMES);
    expect(fs.existsSync(SECRET_FILE), 'a half secret was left in the private directory').toBe(false);
  });

  it('gets it across on the next attempt, with the value Hermes holds', async () => {
    fs.writeFileSync(LEGACY_FILE, HELD_BY_HERMES, { mode: 0o600 });
    truncateNextPrivateWrite = true;
    (await load()).migrateWebhookSecretOutOfAgentReach();

    const { isWebhookSecret } = await load();

    expect(isWebhookSecret(HELD_BY_HERMES), 'Hermes was locked out').toBe(true);
    expect(fs.existsSync(LEGACY_FILE), 'still in the directory every agent is handed').toBe(false);
  });

  it('is moved from main.ts when the app starts, not when something first asks for it', () => {
    // A run in which nobody opens Settings > Hermes and no webhook arrives
    // reads no secret, so a move made only on the first read would leave it in
    // ~/.dorothy for that whole run.
    const main = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.ts'), 'utf-8');
    const ready = main.slice(main.indexOf('app.whenReady()'));
    const body = ready.slice(0, ready.indexOf('\n});') + 4);

    expect(body, 'the move is not called from whenReady').toContain('migrateWebhookSecretOutOfAgentReach()');
  });
});

describe('the app itself', () => {
  it('keeps the secret out of the directory the agents are handed', async () => {
    const real = await vi.importActual<typeof import('../../../electron/constants')>('../../../electron/constants');

    expect(real.HERMES_WEBHOOK_SECRET_FILE.startsWith(real.PRIVATE_DIR + path.sep)).toBe(true);
    expect(real.HERMES_WEBHOOK_SECRET_FILE.startsWith(real.DATA_DIR + path.sep)).toBe(false);
    expect(real.HERMES_WEBHOOK_SECRET_LEGACY_FILE.startsWith(real.DATA_DIR + path.sep)).toBe(true);
  });
});
