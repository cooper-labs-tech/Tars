/**
 * The registry of Claude accounts (electron/services/claude-accounts/registry.ts).
 *
 * What goes wrong if it is wrong, first:
 * - the option turns itself on: a missing, empty or broken file must read as
 *   the option off, with the one account everybody has today;
 * - account 1 disappears: `default` (today's ~/.claude, launched without
 *   CLAUDE_CONFIG_DIR) is always in the list, can be renamed and disabled but
 *   never removed, and a file without it gets it back;
 * - a sixth account: JeanBrasse's ceiling is five at once;
 * - an id is reused: an account's directory names its keychain item, so a new
 *   account given a removed one's id would sign in as whoever that was if the
 *   logout had failed. Ids are random, not the next free number;
 * - the folder taken from the file: every agent can write ~/.dorothy, and one
 *   that pointed an account at ~/Documents would have Tars write links there
 *   and Remove trash it (the Audit's B2). The folder is derived from the id,
 *   under ~/.claude-accounts, whatever the file says, and the file itself
 *   lives in ~/.tars-private, which no agent is handed;
 * - the folder string moves: Claude Code hashes the path exactly as given
 *   (measured: /tmp/x, /private/tmp/x and x/ are three logins), so it is the
 *   same string every time, the home resolved once;
 * - a label a person cannot read (empty, over 40 characters, control or bidi
 *   characters) reaches the Settings page and the agent cards;
 * - thresholds out of range (a 0 % threshold would switch every agent at once);
 * - a reorder that loses or invents an account;
 * - a file written half-way, or readable by other users;
 * - a file that does not parse, overwritten: it reads as account 1 alone, and
 *   the next change would write that over it, the other accounts gone from
 *   Tars while their folders stay signed in (the Audit's gate of #263). No
 *   write while it does not parse.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { claudeAccountsNotPorted } from '../../setup/platform-limits';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_ACCOUNT_ID,
  MAX_ACCOUNTS,
  defaultAccountsSettings,
  normalizeAccountsSettings,
  readAccountsSettings,
  writeAccountsSettings,
  accountsFile,
  accountsRoot,
  addAccount,
  renameAccount,
  setAccountEnabled,
  reorderAccounts,
  removeAccount,
  setThresholds,
  setEnabled,
  validateLabel,
  registryProblem,
} from '../../../electron/services/claude-accounts/registry';

const ROOT = accountsRoot();

describe('defaults', () => {
  it('is the option off, account 1 alone, thresholds 90 and 95', () => {
    const s = defaultAccountsSettings();
    expect(s.enabled).toBe(false);
    expect(s.accounts).toEqual([{ id: DEFAULT_ACCOUNT_ID, label: 'Account 1', configDir: null, enabled: true }]);
    expect(s.fiveHourThreshold).toBe(90);
    expect(s.weeklyThreshold).toBe(95);
  });

  it.each([undefined, null, 42, 'x', [], {}, { enabled: 'yes' }])('reads %j as the defaults', (raw) => {
    expect(normalizeAccountsSettings(raw)).toEqual(defaultAccountsSettings());
  });

  it('turns the option on only for a literal true', () => {
    expect(normalizeAccountsSettings({ enabled: 1 }).enabled).toBe(false);
    expect(normalizeAccountsSettings({ enabled: 'true' }).enabled).toBe(false);
    expect(normalizeAccountsSettings({ enabled: true }).enabled).toBe(true);
  });
});

describe('normalizing what the file holds', () => {
  const other = { id: 'acct-1a2b3c', label: 'Max two', configDir: `${ROOT}/acct-1a2b3c`, enabled: true };

  it('puts account 1 back when the file lost it, in first place', () => {
    const s = normalizeAccountsSettings({ enabled: true, accounts: [other] });
    expect(s.accounts.map(a => a.id)).toEqual([DEFAULT_ACCOUNT_ID, other.id]);
  });

  it('keeps the order the file has, account 1 included', () => {
    const def = { id: 'default', label: 'Mine', configDir: null, enabled: true };
    const s = normalizeAccountsSettings({ accounts: [other, def] });
    expect(s.accounts.map(a => a.id)).toEqual([other.id, 'default']);
    expect(s.accounts[1].label).toBe('Mine');
  });

  it('forces account 1 to have no directory: it runs without CLAUDE_CONFIG_DIR', () => {
    const s = normalizeAccountsSettings({ accounts: [{ id: 'default', label: 'Mine', configDir: '/Users/someone/.claude', enabled: true }] });
    expect(s.accounts[0].configDir).toBeNull();
  });

  it('drops entries that are not accounts: bad id, duplicate id', () => {
    const s = normalizeAccountsSettings({
      accounts: [
        other,
        { ...other },
        { id: '../../etc', label: 'x', configDir: `${ROOT}/x`, enabled: true },
        { id: 'acct-1A2B3C', label: 'upper', enabled: true },
        { id: 'acct-00001', label: 'short', enabled: true },
        'nonsense',
      ],
    });
    expect(s.accounts.map(a => a.id)).toEqual(['default', other.id]);
  });

  it('derives the folder from the id under ~/.claude-accounts, whatever the file says', () => {
    for (const written of ['/Users/someone/Documents', path.join(os.homedir(), '.claude'), 'relative/dir', `${ROOT}/../Documents`, undefined]) {
      const s = normalizeAccountsSettings({ accounts: [{ ...other, configDir: written }] });
      expect(s.accounts[1].configDir).toBe(path.join(ROOT, other.id));
    }
  });

  it('gives the same folder string at every read, the home resolved once', () => {
    const a = normalizeAccountsSettings({ accounts: [other] }).accounts[1].configDir;
    const b = normalizeAccountsSettings({ accounts: [other] }).accounts[1].configDir;
    expect(a).toBe(b);
    expect(a).toBe(path.join(fs.realpathSync(os.homedir()), '.claude-accounts', other.id));
  });

  it('keeps five accounts at most, account 1 among them', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ ...other, id: `acct-00000${i}`, configDir: `${ROOT}/acct-00000${i}` }));
    const s = normalizeAccountsSettings({ accounts: many });
    expect(s.accounts).toHaveLength(MAX_ACCOUNTS);
    expect(s.accounts.some(a => a.id === 'default')).toBe(true);
  });

  it('replaces a threshold out of range or not a whole number by its default', () => {
    expect(normalizeAccountsSettings({ fiveHourThreshold: 0, weeklyThreshold: 101 })).toMatchObject({ fiveHourThreshold: 90, weeklyThreshold: 95 });
    expect(normalizeAccountsSettings({ fiveHourThreshold: 80.5, weeklyThreshold: 'x' })).toMatchObject({ fiveHourThreshold: 90, weeklyThreshold: 95 });
    expect(normalizeAccountsSettings({ fiveHourThreshold: 50, weeklyThreshold: 100 })).toMatchObject({ fiveHourThreshold: 50, weeklyThreshold: 100 });
  });

  it('reads an invalid label as a readable one instead of dropping the account', () => {
    const s = normalizeAccountsSettings({ accounts: [{ ...other, label: '' }] });
    expect(s.accounts[1].label.length).toBeGreaterThan(0);
  });
});

describe('labels', () => {
  it('trims and accepts 1 to 40 characters', () => {
    expect(validateLabel('  Max two  ')).toBe('Max two');
    expect(validateLabel('x'.repeat(40))).toBe('x'.repeat(40));
  });

  it.each(['', '   ', 'x'.repeat(41), 'a\nb', 'a\u0007b', 'abc\u202eevil', 'a\u2066b', 42, null])('refuses %j with a sentence', (label) => {
    expect(() => validateLabel(label)).toThrow(/label/i);
  });
});

describe('adding', () => {
  it('gives a random id, a directory under the root named by it, enabled, not reusing ids', () => {
    let s = defaultAccountsSettings();
    const seen = new Set<string>();
    for (let i = 0; i < MAX_ACCOUNTS - 1; i++) {
      const r = addAccount(s, `Max ${i + 2}`, ROOT);
      s = r.settings;
      expect(r.account.id).toMatch(/^acct-[0-9a-f]{6}$/);
      expect(seen.has(r.account.id)).toBe(false);
      seen.add(r.account.id);
      expect(r.account.configDir).toBe(path.join(ROOT, r.account.id));
      expect(r.account.enabled).toBe(true);
    }
    expect(s.accounts).toHaveLength(MAX_ACCOUNTS);
    expect(() => addAccount(s, 'Sixth', ROOT)).toThrow(/5/);
  });

  it("does not hand a removed account's id to the next one, as a next free number would", () => {
    const first = addAccount(defaultAccountsSettings(), 'Max two', ROOT);
    const removed = first.account.id;
    let s = removeAccount(first.settings, removed);
    for (let i = 0; i < 20; i++) {
      const r = addAccount(s, `Again ${i}`, ROOT);
      expect(r.account.id).not.toBe(removed);
      s = removeAccount(r.settings, r.account.id);
    }
  });

  it('refuses a relative root', () => {
    expect(() => addAccount(defaultAccountsSettings(), 'Max two', 'relative')).toThrow();
  });

  it('refuses a label another account already has', () => {
    const s = addAccount(defaultAccountsSettings(), 'Max two', ROOT).settings;
    expect(() => addAccount(s, 'max two', ROOT)).toThrow(/label/i);
    expect(() => addAccount(s, 'Account 1', ROOT)).toThrow(/label/i);
  });

  it('does not change the settings it was given', () => {
    const s = defaultAccountsSettings();
    addAccount(s, 'Max two', ROOT);
    expect(s).toEqual(defaultAccountsSettings());
  });
});

describe('changing', () => {
  let s: ReturnType<typeof defaultAccountsSettings>;
  let id: string;
  beforeEach(() => {
    const r = addAccount(defaultAccountsSettings(), 'Max two', ROOT);
    s = r.settings;
    id = r.account.id;
  });

  it('renames, account 1 included', () => {
    expect(renameAccount(s, 'default', 'Mine').accounts[0].label).toBe('Mine');
    expect(renameAccount(s, id, 'Work').accounts[1].label).toBe('Work');
    expect(() => renameAccount(s, 'acct-ffffff', 'x')).toThrow();
    expect(() => renameAccount(s, id, 'Account 1')).toThrow(/label/i);
  });

  it('enables and disables', () => {
    expect(setAccountEnabled(s, id, false).accounts[1].enabled).toBe(false);
    expect(() => setAccountEnabled(s, 'acct-ffffff', false)).toThrow();
  });

  it('reorders only by a permutation of the ids it has', () => {
    expect(reorderAccounts(s, [id, 'default']).accounts.map(a => a.id)).toEqual([id, 'default']);
    expect(() => reorderAccounts(s, [id])).toThrow();
    expect(() => reorderAccounts(s, [id, 'default', 'acct-ffffff'])).toThrow();
    expect(() => reorderAccounts(s, [id, id])).toThrow();
  });

  it('removes any account but account 1', () => {
    expect(removeAccount(s, id).accounts.map(a => a.id)).toEqual(['default']);
    expect(() => removeAccount(s, 'default')).toThrow();
    expect(() => removeAccount(s, 'acct-ffffff')).toThrow();
  });

  it('sets thresholds between 50 and 100, whole numbers', () => {
    expect(setThresholds(s, 80, 97)).toMatchObject({ fiveHourThreshold: 80, weeklyThreshold: 97 });
    for (const bad of [[49, 95], [90, 101], [90.5, 95], [Number.NaN, 95]]) {
      expect(() => setThresholds(s, bad[0], bad[1])).toThrow();
    }
  });

  it('turns the option on and off', () => {
    expect(setEnabled(s, true).enabled).toBe(true);
    expect(setEnabled(setEnabled(s, true), false).enabled).toBe(false);
  });
});

describe('the file', () => {
  it('lives in ~/.tars-private, which no agent is handed, and its absence reads as the defaults', () => {
    expect(accountsFile()).toBe(path.join(os.homedir(), '.tars-private', 'claude-accounts.json'));
    if (fs.existsSync(accountsFile())) fs.unlinkSync(accountsFile());
    expect(readAccountsSettings()).toEqual(defaultAccountsSettings());
  });

  it('reads a file that does not parse as the defaults, and leaves it alone', () => {
    fs.mkdirSync(path.dirname(accountsFile()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(accountsFile(), '{ not json');
    expect(readAccountsSettings()).toEqual(defaultAccountsSettings());
    expect(fs.readFileSync(accountsFile(), 'utf-8')).toBe('{ not json');
  });

  it.each([['does not parse', '{ not json'], ['is not an object', '[]']])('refuses to write over a file that %s, and says why', (_what, content) => {
    fs.mkdirSync(path.dirname(accountsFile()), { recursive: true, mode: 0o700 });
    fs.writeFileSync(accountsFile(), content);
    expect(registryProblem()).toMatch(/claude-accounts\.json/);
    const { settings } = addAccount(defaultAccountsSettings(), 'Max two', ROOT);
    expect(() => writeAccountsSettings(settings)).toThrow(/claude-accounts\.json/);
    expect(fs.readFileSync(accountsFile(), 'utf-8')).toBe(content);
  });

  it('has no problem with a file that is absent or reads', () => {
    if (fs.existsSync(accountsFile())) fs.unlinkSync(accountsFile());
    expect(registryProblem()).toBeNull();
    writeAccountsSettings(defaultAccountsSettings());
    expect(registryProblem()).toBeNull();
  });

  it.skipIf(claudeAccountsNotPorted())('writes and reads back, readable by its owner only', () => {
    const { settings } = addAccount(setEnabled(defaultAccountsSettings(), true), 'Max two', ROOT);
    writeAccountsSettings(settings);
    expect(readAccountsSettings()).toEqual(settings);
    expect(fs.statSync(accountsFile()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(accountsFile())).mode & 0o777).toBe(0o700);
  });

  it('puts the accounts outside the data directory the agents are given (--add-dir ~/.dorothy)', () => {
    const root = accountsRoot();
    expect(root).toBe(path.join(fs.realpathSync(os.homedir()), '.claude-accounts'));
    expect(root.startsWith(path.join(fs.realpathSync(os.homedir()), '.dorothy'))).toBe(false);
  });
});
