import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * What Tars before 2.0.4 left of a key provider's key, cleaned once, at load (the Audit's M2 on #458).
 *
 * Every launch on a key provider showed Claude Code's question, which prints the key's last 20 characters under its
 * own masking (`sk-ant-...<20>`: the bytes below are Claude Code 2.1.302's, measured), and an agent's terminal output
 * is kept in agents.json and agents.backup.json, which every agent is handed (--add-dir). After a No, Claude Code
 * keeps the same 20 characters, `key.trim().slice(-20)`, in `customApiKeyResponses.rejected` of the .claude.json of
 * the folder it ran on: ~/.claude.json, or an account folder's.
 *
 * The ways it fails:
 * 1. The masked key still in an agent's kept output, in agents.json or in agents.backup.json, after the load.
 * 2. Half of it left where the output was cut between two chunks; or a key of Tars's, whole or its tail, printed
 *    elsewhere in the output, kept.
 * 3. More than the fragment lost: other chunks, or the rest of the chunk that held it.
 * 4. A rejected entry of a key Tars hands Claude Code kept, in ~/.claude.json or in an account folder's copy.
 * 5. The user's own entries touched: another key's rejected entry, an approved one, any other field; or a file with
 *    nothing to remove rewritten, or written without its 0600 mode.
 * 6. Done at every load, rewriting the user's files again and again: once, for an agents.json from before this.
 * 7. A fragment written where the cleaning reports: it says how many, never what.
 * 8. The tail kept in the copies Claude Code makes of each file: its backups, `.claude.json.backup.<ms>` in the
 *    folder's `backups/` (`~/.claude/backups/` for ~/.claude.json; five kept, 0600, measured on 2.1.302), and what a
 *    write of its own it never finished left beside the file, `.claude.json.tmp.<pid>.<hex>` (five in a real home,
 *    two of them empty); or one of those, empty or cut short, rewritten.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => os.tmpdir(), getVersion: () => '2.0.4' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined, on: () => undefined },
}));

const HOME = os.homedir();
const DATA = path.join(HOME, '.dorothy');
const AGENTS = path.join(DATA, 'agents.json');
const BACKUP = path.join(DATA, 'agents.backup.json');
const CLAUDE_JSON = path.join(HOME, '.claude.json');
const ACCOUNT = 'acct-0a1b2c';
const ACCOUNT_JSON = () => path.join(fs.realpathSync(HOME), '.claude-accounts', ACCOUNT, '.claude.json');

// Built, not written: a literal of a DeepSeek key's shape is refused by GitHub's push protection.
const DEEPSEEK = `sk-${'0123456789abcdef'.repeat(2)}`;
const OPENROUTER = 'sk-or-v1-fedcba9876543210fedcba9876543210';
const ROTATED = 'sk-old-key-gone-from-settings-0000aaaa';
const USERS_OWN = 'sk-ant-api03-the-users-own-key-1234567890';
const tail = (key: string) => key.trim().slice(-20);

/** Claude Code 2.1.302's question as its PTY wrote it, the key's tail in it (measured: q01-question-raw.raw). */
const question = (key: string) => '\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?25l\x1b[?2004h\r\r\n\x1b[38;5;220m'
  + '─'.repeat(120) + '\x1b[39m\r\r\n\x1b[3G\x1b[38;5;220m\x1b[1mDetected\x1b[12Ga\x1b[14Gcustom\x1b[21GAPI\x1b[25Gkey\x1b[29Gin'
  + '\x1b[32Gyour\x1b[37Genvironment\x1b[22m\x1b[39m\r\r\n\r\r\n\x1b[3G\x1b[1mANTHROPIC_API_KEY\x1b[22m:\x1b[22Gsk-ant-...'
  + tail(key) + '\r\r\n\r\r\n\x1b[3GDo\x1b[6Gyou\x1b[10Gwant\x1b[15Gto\x1b[18Guse\x1b[22Gthis\x1b[27GAPI\x1b[31Gkey?\r\r\n';

function agent(id: string, output: string[]) {
  return { id, name: id, status: 'idle', projectPath: HOME, output, lastActivity: '2026-10-18T08:00:00.000Z', provider: 'deepseek', skills: [] };
}
const writeAgents = (file: string, version: number, agents: unknown[]) =>
  fs.writeFileSync(file, JSON.stringify({ version, savedAt: '2026-10-18T08:00:00.000Z', agents }, null, 2));
const outputOf = (file: string, id: string) =>
  (JSON.parse(fs.readFileSync(file, 'utf8')).agents as Array<{ id: string; output: string[] }>).find(a => a.id === id)!.output;
const config = (rejected: string[], approved: string[] = []) =>
  ({ numStartups: 7, theme: 'dark', projects: { '/p': { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved, rejected } });

let manager: typeof import('../../../electron/core/agent-manager');
let logged: string[];

beforeEach(async () => {
  for (const p of [DATA, path.join(HOME, '.tars-private'), path.join(HOME, '.claude-accounts'), path.join(HOME, '.claude'), CLAUDE_JSON]) fs.rmSync(p, { recursive: true, force: true });
  for (const name of fs.readdirSync(HOME)) if (name.startsWith('.claude.json.tmp.')) fs.rmSync(path.join(HOME, name));
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'app-settings.json'), JSON.stringify({ deepSeekApiKey: DEEPSEEK, openRouterApiKey: OPENROUTER }));
  logged = [];
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  }
  vi.resetModules();
  manager = await import('../../../electron/core/agent-manager');
});

afterEach(() => {
  manager.stopAgentAutosave();
  vi.restoreAllMocks();
});

describe("an agent's kept output, at the first load of a file from before 2.0.4", () => {
  it("1, 3. loses the question's key in agents.json and in its backup, and nothing else", () => {
    const output = ['the session began\r\n', question(DEEPSEEK), 'Do you want to use this API key?\r\n', 'and went on\r\n'];
    writeAgents(AGENTS, 3, [agent('a1', output), agent('a2', ['nothing of a key\r\n'])]);
    writeAgents(BACKUP, 3, [agent('a1', output)]);

    manager.loadAgents();

    for (const file of [AGENTS, BACKUP]) {
      const kept = outputOf(file, 'a1');
      expect(kept.join(''), file).not.toContain(tail(DEEPSEEK));
      expect(kept.join(''), file).toContain('sk-ant-...');
      expect(kept).toHaveLength(output.length);
      expect(kept[0]).toBe(output[0]);
      expect(kept[2]).toBe(output[2]);
      expect(kept[1]).toContain('\x1b[1mDetected\x1b[12Ga');
    }
    expect(outputOf(AGENTS, 'a2')).toEqual(['nothing of a key\r\n']);
    expect(manager.agents.get('a1')!.output.join('')).not.toContain(tail(DEEPSEEK));
  });

  it("2. loses a key cut between two chunks, a rotated key's tail, and a key of Tars's printed whole", () => {
    const shown = question(ROTATED);
    const cut = shown.indexOf(tail(ROTATED)) + 8;
    const output = [shown.slice(0, cut), shown.slice(cut), `env: OPENROUTER=${OPENROUTER}\r\n`];
    writeAgents(AGENTS, 3, [agent('a1', output)]);

    manager.loadAgents();

    const kept = outputOf(AGENTS, 'a1').join('');
    expect(kept).not.toContain(tail(ROTATED).slice(0, 8));
    expect(kept).not.toContain(tail(ROTATED).slice(8));
    expect(kept).not.toContain(OPENROUTER.slice(0, 12));
    expect(kept).not.toContain(tail(OPENROUTER));
    expect(kept).toContain('env: OPENROUTER=');
  });

  it('6. is cleaned once: a file already written since is read as it is', () => {
    writeAgents(AGENTS, 4, [agent('a1', [question(DEEPSEEK)])]);
    manager.loadAgents();
    expect(manager.agents.get('a1')!.output.join('')).toContain(tail(DEEPSEEK));
  });
});

describe('the rejected keys Claude Code kept, at the same load', () => {
  it("4, 5. lose the tails of Tars's keys in ~/.claude.json and in each account folder's, and only them", () => {
    writeAgents(AGENTS, 3, [agent('a1', [])]);
    fs.writeFileSync(CLAUDE_JSON, JSON.stringify(config([tail(DEEPSEEK), tail(USERS_OWN), tail(OPENROUTER)], [tail(OPENROUTER)]), null, 2), { mode: 0o600 });
    fs.mkdirSync(path.join(HOME, '.tars-private'), { recursive: true });
    fs.writeFileSync(path.join(HOME, '.tars-private', 'claude-accounts.json'), JSON.stringify({ enabled: true, accounts: [{ id: 'default' }, { id: ACCOUNT, label: 'Account 2' }] }));
    fs.mkdirSync(path.dirname(ACCOUNT_JSON()), { recursive: true });
    fs.writeFileSync(ACCOUNT_JSON(), JSON.stringify(config([tail(DEEPSEEK)]), null, 2), { mode: 0o600 });

    manager.loadAgents();

    const home = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'));
    expect(home.customApiKeyResponses).toEqual({ approved: [tail(OPENROUTER)], rejected: [tail(USERS_OWN)] });
    expect(home).toMatchObject({ numStartups: 7, theme: 'dark', projects: { '/p': { hasTrustDialogAccepted: true } } });
    expect(fs.statSync(CLAUDE_JSON).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(ACCOUNT_JSON(), 'utf8')).customApiKeyResponses.rejected).toEqual([]);
    expect(fs.statSync(ACCOUNT_JSON()).mode & 0o777).toBe(0o600);
  });

  it("8. lose them in the copies Claude Code keeps of each file, and a copy it left empty or cut short stays as it is", () => {
    writeAgents(AGENTS, 3, [agent('a1', [])]);
    fs.writeFileSync(CLAUDE_JSON, JSON.stringify(config([]), null, 2), { mode: 0o600 });
    fs.mkdirSync(path.join(HOME, '.tars-private'), { recursive: true });
    fs.writeFileSync(path.join(HOME, '.tars-private', 'claude-accounts.json'), JSON.stringify({ enabled: true, accounts: [{ id: 'default' }, { id: ACCOUNT, label: 'Account 2' }] }));
    fs.mkdirSync(path.dirname(ACCOUNT_JSON()), { recursive: true });
    fs.writeFileSync(ACCOUNT_JSON(), JSON.stringify(config([]), null, 2), { mode: 0o600 });
    const homeBackup = path.join(HOME, '.claude', 'backups', '.claude.json.backup.1792350644690');
    const accountBackup = path.join(path.dirname(ACCOUNT_JSON()), 'backups', '.claude.json.backup.1792350644614');
    const leftover = path.join(HOME, '.claude.json.tmp.78791.84efb0c4c9ae');
    const accountLeftover = path.join(path.dirname(ACCOUNT_JSON()), '.claude.json.tmp.87662.f6a3bbbb8772');
    const copies: Array<[string, string[]]> = [[homeBackup, [tail(DEEPSEEK), tail(USERS_OWN)]], [accountBackup, [tail(OPENROUTER)]],
      [leftover, [tail(DEEPSEEK)]], [accountLeftover, [tail(DEEPSEEK)]]];
    for (const [file, rejected] of copies) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(config(rejected), null, 2), { mode: 0o600 });
    }
    const empty = path.join(HOME, '.claude.json.tmp.45327.de5af454b2b8');
    const cutShort = path.join(HOME, '.claude.json.tmp.81815.427406b7e72f');
    const cut = JSON.stringify(config([tail(DEEPSEEK)]), null, 2).slice(0, -3);
    fs.writeFileSync(empty, '', { mode: 0o600 });
    fs.writeFileSync(cutShort, cut, { mode: 0o600 });

    manager.loadAgents();

    expect(JSON.parse(fs.readFileSync(homeBackup, 'utf8')).customApiKeyResponses.rejected).toEqual([tail(USERS_OWN)]);
    for (const [file] of copies.slice(1)) expect(JSON.parse(fs.readFileSync(file, 'utf8')).customApiKeyResponses.rejected, file).toEqual([]);
    for (const [file] of copies) {
      expect(JSON.parse(fs.readFileSync(file, 'utf8')), file).toMatchObject({ numStartups: 7, theme: 'dark' });
      expect(fs.statSync(file).mode & 0o777, file).toBe(0o600);
    }
    expect(fs.readFileSync(empty, 'utf8')).toBe('');
    expect(fs.readFileSync(cutShort, 'utf8')).toBe(cut);
  });

  it('5. a file with nothing to remove is not written', () => {
    writeAgents(AGENTS, 3, [agent('a1', [])]);
    fs.writeFileSync(CLAUDE_JSON, JSON.stringify(config([tail(USERS_OWN)]), null, 2), { mode: 0o600 });
    const before = fs.statSync(CLAUDE_JSON, { bigint: true });
    manager.loadAgents();
    const after = fs.statSync(CLAUDE_JSON, { bigint: true });
    expect([after.ino, after.mtimeNs]).toEqual([before.ino, before.mtimeNs]);
  });

  it('7. says how many it removed, and never what', () => {
    writeAgents(AGENTS, 3, [agent('a1', [question(DEEPSEEK)])]);
    fs.writeFileSync(CLAUDE_JSON, JSON.stringify(config([tail(DEEPSEEK)]), null, 2), { mode: 0o600 });
    manager.loadAgents();
    const said = logged.join('\n');
    expect(said).toMatch(/key/i);
    for (const secret of [DEEPSEEK, OPENROUTER, tail(DEEPSEEK), tail(OPENROUTER)]) expect(said).not.toContain(secret);
  });
});
