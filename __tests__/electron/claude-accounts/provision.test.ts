/**
 * Setting an account's directory up (electron/services/claude-accounts/provision.ts).
 *
 * Measured on claude 2.1.283 (DESIGN-COMPTES-CLAUDE.md, A): with CLAUDE_CONFIG_DIR
 * set, transcripts, the agents' memory, CLAUDE.md, skills and agents are read
 * from that directory, symbolic links followed; settings.json (hooks, status
 * line) and .claude.json (MCP servers, trust, onboarding) too.
 *
 * What goes wrong if it is wrong, first:
 * - transcripts split per account: Usage, the Chat, resume and every agent's
 *   memory read ~/.claude/projects, and `--resume` from another account says
 *   "No conversation found" unless projects/ is shared. So projects/ is a link to
 *   ~/.claude/projects, created even when that folder does not exist yet;
 * - an account without Tars's hooks or status line: its agents never report a
 *   status. settings.json is a copy of ~/.claude/settings.json, the source;
 * - an account without the MCP servers the user and Tars registered in
 *   ~/.claude.json, or stopped on first-run screens;
 * - Tars reading a credential: nothing here opens .credentials.json, lists the
 *   directory, or touches any key of the account's .claude.json but the ones it
 *   mirrors (oauthAccount is the account's own);
 * - user data destroyed: something real where a link should be is left alone
 *   and reported, never removed;
 * - an account's usage lost (the Audit's gap 5, AUDIT-USAGE-COMPTES.md): a
 *   projects/ that is a folder of its own (Claude Code run in that folder
 *   before Tars) keeps what its agents write out of ~/.claude/projects, where
 *   Usage, resume and the Chat read. An empty one is made the link (rmdir
 *   removes only an empty folder, so nothing is listed to find out); one that
 *   holds something stays, and projectsProblem says why no agent starts there;
 * - a folder that is not Tars's own (the Audit's B2): a link, a folder open to
 *   other users (Linux keeps the credential in it), one owned by somebody
 *   else, or anything that is not ~/.claude-accounts/<id>. Refused before any
 *   write, and never repaired: Tars does not chmod or replace what it finds;
 * - a switched agent stopped on a dialog (the Audit's B1, measured with the real
 *   binary): `--dangerously-skip-permissions` in a folder without
 *   bypassPermissionsModeAccepted stops on "Bypass Permissions mode" with
 *   "No, exit" preselected, and a project's approvals (its .mcp.json servers,
 *   CLAUDE.md imports) live in its projects[] entry. Both are copied from
 *   ~/.claude.json, the entry whole;
 * - a credential copied (the Audit's B3): ~/.claude/settings.json can hold
 *   apiKeyHelper or ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
 *   CLAUDE_CODE_OAUTH_TOKEN in its env, and a Bedrock, Vertex or Foundry
 *   setup (a CLAUDE_CODE_USE_* switch and its AWS_* or Google credentials,
 *   the Audit's gate of #263). The copy leaves them all out, and
 *   claudeCredentialOverrides names the ones Claude Code would sign in with,
 *   from the file and from Tars's own environment, so the option can refuse
 *   to turn on while every account would in fact run on that one credential.
 */
import '../../setup/home-guard';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { claudeAccountsNotPorted } from '../../setup/platform-limits';

// Every path the code under test hands to fs, while `watch.on`: a namespace
// cannot be spied on in ESM, so the module is wrapped instead.
const watch = vi.hoisted(() => ({ on: false, touched: [] as { fn: string; p: string }[] }));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const wrapped: Record<string, unknown> = { ...real };
  for (const fn of ['readFileSync', 'openSync', 'readdirSync', 'statSync', 'lstatSync', 'existsSync', 'copyFileSync', 'createReadStream', 'readlinkSync', 'realpathSync', 'opendirSync'] as const) {
    const original = (real as unknown as Record<string, (...a: unknown[]) => unknown>)[fn];
    wrapped[fn] = (...args: unknown[]) => {
      if (watch.on && typeof args[0] === 'string') watch.touched.push({ fn, p: args[0] });
      return original(...args);
    };
  }
  return { ...wrapped, default: wrapped };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { provisionAccountDir, accountDirProblem, claudeCredentialOverrides, projectsProblem, SHARED_ENTRIES } from '../../../electron/services/claude-accounts/provision';

let home: string;
let claudeDir: string;
let dir: string;
let n = 0;

beforeEach(() => {
  home = fs.realpathSync(os.homedir());
  claudeDir = path.join(home, '.claude');
  dir = path.join(home, '.claude-accounts', `acct-${(n++).toString(16).padStart(6, '0')}`);
});

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

describe.skipIf(claudeAccountsNotPorted())('the directory', () => {
  it('is created owner-only, under a root that is owner-only too', () => {
    provisionAccountDir(dir, home);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(dir)).mode & 0o777).toBe(0o700);
    expect(accountDirProblem(dir)).toBeNull();
  });

  it('refuses a folder open to other users, and leaves it as it is', () => {
    provisionAccountDir(dir, home);
    fs.chmodSync(dir, 0o755);
    expect(accountDirProblem(dir)).toMatch(/other users/);
    expect(() => provisionAccountDir(dir, home)).toThrow(/other users/);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
  });

  it('refuses a link in place of the folder, and writes nothing through it', () => {
    const elsewhere = fs.mkdtempSync(path.join(home, 'documents-'));
    fs.chmodSync(elsewhere, 0o700);
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    fs.symlinkSync(elsewhere, dir);
    expect(accountDirProblem(dir)).toMatch(/link/);
    expect(() => provisionAccountDir(dir, home)).toThrow(/link/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a root that is a link, or open to others', () => {
    const root = path.join(home, '.claude-accounts');
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true });
    const elsewhere = fs.mkdtempSync(path.join(home, 'root-'));
    fs.chmodSync(elsewhere, 0o700);
    fs.symlinkSync(elsewhere, root);
    expect(() => provisionAccountDir(dir, home)).toThrow(/link/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    fs.unlinkSync(root);
    fs.mkdirSync(root, { mode: 0o755 });
    fs.chmodSync(root, 0o755);
    expect(() => provisionAccountDir(dir, home)).toThrow(/other users/);
    fs.chmodSync(root, 0o700);
  });

  it('reports a folder whose root was opened to others as not ours', () => {
    provisionAccountDir(dir, home);
    const root = path.dirname(dir);
    fs.chmodSync(root, 0o755);
    try {
      expect(accountDirProblem(dir)).toMatch(/~\/\.claude-accounts is open to other users/);
    } finally {
      fs.chmodSync(root, 0o700);
    }
    expect(accountDirProblem(dir)).toBeNull();
  });

  it('refuses anything that is not ~/.claude-accounts/<id>', () => {
    for (const bad of ['relative/acct', path.join(home, 'Documents'), path.join(home, '.claude'), path.join(home, '.claude-accounts', 'default'), path.join(home, '.claude-accounts', 'acct-1a2b3c', 'deeper')]) {
      expect(() => provisionAccountDir(bad, home)).toThrow();
      expect(accountDirProblem(bad)).not.toBeNull();
    }
    expect(fs.existsSync(path.join(home, 'Documents', 'settings.json'))).toBe(false);
  });
});

describe.skipIf(claudeAccountsNotPorted())('what is shared through links', () => {
  it('links projects/ to ~/.claude/projects, creating it when it is missing', () => {
    if (fs.existsSync(path.join(claudeDir, 'projects'))) fs.rmSync(path.join(claudeDir, 'projects'), { recursive: true });
    provisionAccountDir(dir, home);
    const link = path.join(dir, 'projects');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(link)).toBe(path.join(claudeDir, 'projects'));
    expect(fs.statSync(path.join(claudeDir, 'projects')).isDirectory()).toBe(true);
  });

  it('a transcript written through the account lands in ~/.claude/projects', () => {
    provisionAccountDir(dir, home);
    const rel = path.join('projects', '-Users-someone-app', 'abc.jsonl');
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), '{}\n');
    expect(fs.readFileSync(path.join(claudeDir, rel), 'utf-8')).toBe('{}\n');
  });

  it("links history.jsonl and sessions/, creating them in ~/.claude, so Tars's stats count every account (N3)", () => {
    for (const p of [path.join(claudeDir, 'history.jsonl'), path.join(claudeDir, 'sessions')]) if (fs.existsSync(p)) fs.rmSync(p, { recursive: true });
    provisionAccountDir(dir, home);
    expect(fs.readlinkSync(path.join(dir, 'history.jsonl'))).toBe(path.join(claudeDir, 'history.jsonl'));
    expect(fs.readlinkSync(path.join(dir, 'sessions'))).toBe(path.join(claudeDir, 'sessions'));
    expect(fs.statSync(path.join(claudeDir, 'sessions')).isDirectory()).toBe(true);
    expect(fs.statSync(path.join(claudeDir, 'history.jsonl')).mode & 0o777).toBe(0o600);
    // Measured on 2.1.283: a prompt is appended through the link, which stays a link.
    fs.appendFileSync(path.join(dir, 'history.jsonl'), '{"display":"x"}\n');
    expect(fs.readFileSync(path.join(claudeDir, 'history.jsonl'), 'utf-8')).toContain('"display":"x"');
  });

  it('does not touch a history.jsonl account 1 already has', () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'history.jsonl'), '{"display":"kept"}\n', { mode: 0o600 });
    provisionAccountDir(dir, home);
    expect(fs.readFileSync(path.join(claudeDir, 'history.jsonl'), 'utf-8')).toBe('{"display":"kept"}\n');
  });

  it('links CLAUDE.md, skills, agents, commands, plugins and output-styles when ~/.claude has them', () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'CLAUDE.md'), 'mine');
    for (const d of ['skills', 'agents', 'commands', 'plugins', 'output-styles', 'sessions']) fs.mkdirSync(path.join(claudeDir, d), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'history.jsonl'), '');
    provisionAccountDir(dir, home);
    for (const name of SHARED_ENTRIES) {
      expect(fs.readlinkSync(path.join(dir, name))).toBe(path.join(claudeDir, name));
    }
    expect(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf-8')).toBe('mine');
  });

  it('adds a link later, once ~/.claude has the thing', () => {
    const skills = path.join(claudeDir, 'skills');
    if (fs.existsSync(skills)) fs.rmSync(skills, { recursive: true });
    provisionAccountDir(dir, home);
    expect(fs.existsSync(path.join(dir, 'skills'))).toBe(false);
    fs.mkdirSync(skills, { recursive: true });
    provisionAccountDir(dir, home);
    expect(fs.readlinkSync(path.join(dir, 'skills'))).toBe(skills);
  });

  it('leaves something real where a link should be, and reports it', () => {
    fs.mkdirSync(path.join(claudeDir, 'agents'), { recursive: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents', 'keep.md'), 'keep');
    const report = provisionAccountDir(dir, home);
    expect(fs.readFileSync(path.join(dir, 'agents', 'keep.md'), 'utf-8')).toBe('keep');
    expect(report.conflicts).toContain('agents');
  });

  it('repoints a link of its own that points elsewhere', () => {
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.symlinkSync('/nowhere', path.join(dir, 'projects'));
    provisionAccountDir(dir, home);
    expect(fs.readlinkSync(path.join(dir, 'projects'))).toBe(path.join(claudeDir, 'projects'));
  });
});

describe.skipIf(claudeAccountsNotPorted())("projects/, where an account's usage is read from", () => {
  function accountWithProjectsFolder(): void {
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(dir, 'projects'), { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }

  it('makes an empty projects/ folder the link, without listing anything in the account folder', () => {
    accountWithProjectsFolder();
    watch.touched.length = 0;
    watch.on = true;
    let report;
    try {
      report = provisionAccountDir(dir, home);
    } finally {
      watch.on = false;
    }
    expect(fs.readlinkSync(path.join(dir, 'projects'))).toBe(path.join(claudeDir, 'projects'));
    expect(report.conflicts).not.toContain('projects');
    expect(projectsProblem(dir)).toBeNull();
    expect(watch.touched.filter(t => (t.fn === 'readdirSync' || t.fn === 'opendirSync') && t.p.startsWith(dir))).toEqual([]);
  });

  it('leaves a projects/ folder that holds something, reports it, and says why no agent starts there', () => {
    accountWithProjectsFolder();
    fs.mkdirSync(path.join(dir, 'projects', '-work'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'projects', '-work', 'kept.jsonl'), 'kept');

    const report = provisionAccountDir(dir, home);

    expect(fs.lstatSync(path.join(dir, 'projects')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'projects', '-work', 'kept.jsonl'), 'utf-8')).toBe('kept');
    expect(report.conflicts).toContain('projects');
    expect(projectsProblem(dir)).toMatch(/~\/\.claude\/projects/);
  });

  it('finds nothing wrong with the link, or with an account never provisioned', () => {
    provisionAccountDir(dir, home);
    expect(projectsProblem(dir)).toBeNull();
    expect(projectsProblem(path.join(path.dirname(dir), 'acct-ffffff'))).toBeNull();
  });
});

describe.skipIf(claudeAccountsNotPorted())('settings.json, a copy of ~/.claude/settings.json', () => {
  it('copies it, hooks and status line included, and again when it changes', () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    const first = { hooks: { Stop: [{ hooks: [{ type: 'command', command: '/x/on-stop.sh' }] }] }, statusLine: { type: 'command', command: '/x/statusline.sh' }, skipDangerousModePermissionPrompt: true, env: { FOO: 'bar' } };
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(first));
    provisionAccountDir(dir, home);
    expect(readJson(path.join(dir, 'settings.json'))).toEqual(first);
    expect(fs.lstatSync(path.join(dir, 'settings.json')).isSymbolicLink()).toBe(false);
    expect(fs.statSync(path.join(dir, 'settings.json')).mode & 0o777).toBe(0o600);

    const second = { ...first, statusLine: { type: 'command', command: '/x/statusline-2.sh' } };
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify(second));
    provisionAccountDir(dir, home);
    expect(readJson(path.join(dir, 'settings.json'))).toEqual(second);
  });

  it('leaves out every credential Claude Code would sign in with, keeping the rest', () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      apiKeyHelper: '/usr/local/bin/get-key',
      awsAuthRefresh: 'aws sso login',
      awsCredentialExport: '/x/export',
      env: { ANTHROPIC_API_KEY: 'sk-ant-trap-1', ANTHROPIC_AUTH_TOKEN: 'trap-2', CLAUDE_CODE_OAUTH_TOKEN: 'trap-3', KEEP: 'me' },
      model: 'opus',
    }));
    provisionAccountDir(dir, home);
    const text = fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8');
    expect(text).not.toMatch(/trap|apiKeyHelper|awsAuthRefresh|awsCredentialExport|get-key|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN/);
    expect(JSON.parse(text)).toEqual({ env: { KEEP: 'me' }, model: 'opus' });
  });

  it('leaves out a Bedrock, Vertex or Foundry setup, its switches and its cloud credentials', () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
      env: {
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_BEARER_TOKEN_BEDROCK: 'trap-4',
        AWS_ACCESS_KEY_ID: 'trap-5',
        AWS_SECRET_ACCESS_KEY: 'trap-6',
        AWS_SESSION_TOKEN: 'trap-7',
        AWS_PROFILE: 'trap-8',
        AWS_REGION: 'trap-9',
        CLAUDE_CODE_USE_VERTEX: '1',
        GOOGLE_APPLICATION_CREDENTIALS: '/x/trap-10.json',
        CLAUDE_CODE_USE_FOUNDRY: '1',
        ANTHROPIC_FOUNDRY_API_KEY: 'trap-11',
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'trap-12',
        KEEP: 'me',
      },
    }));
    provisionAccountDir(dir, home);
    const text = fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8');
    expect(text).not.toMatch(/trap|AWS_|GOOGLE_APPLICATION_CREDENTIALS|CLAUDE_CODE_USE_|FOUNDRY|REFRESH_TOKEN/);
    expect(JSON.parse(text)).toEqual({ env: { KEEP: 'me' } });
  });

  it('copies nothing from a settings.json that does not parse, and keeps the copy it had', () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ model: 'opus' }));
    provisionAccountDir(dir, home);
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{ "apiKeyHelper": "/x", broken');
    provisionAccountDir(dir, home);
    expect(readJson(path.join(dir, 'settings.json'))).toEqual({ model: 'opus' });
  });

  it('writes none when ~/.claude/settings.json does not exist', () => {
    const src = path.join(claudeDir, 'settings.json');
    if (fs.existsSync(src)) fs.unlinkSync(src);
    provisionAccountDir(dir, home);
    expect(fs.existsSync(path.join(dir, 'settings.json'))).toBe(false);
  });
});

describe.skipIf(claudeAccountsNotPorted())(".claude.json, the account's own", () => {
  it('gets onboarding done, and mcpServers, theme and the bypass acceptance mirrored from ~/.claude.json', () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
      mcpServers: { mem: { type: 'http', url: 'http://127.0.0.1:1/mcp' } },
      theme: 'dark',
      bypassPermissionsModeAccepted: true,
      oauthAccount: { emailAddress: 'someone@example.com' },
      projects: { '/p': { hasTrustDialogAccepted: true } },
    }));
    provisionAccountDir(dir, home);
    const own = readJson(path.join(dir, '.claude.json'));
    expect(own.hasCompletedOnboarding).toBe(true);
    expect(own.mcpServers).toEqual({ mem: { type: 'http', url: 'http://127.0.0.1:1/mcp' } });
    expect(own.theme).toBe('dark');
    expect(own.bypassPermissionsModeAccepted).toBe(true);
    // Account 1's identity and trust are not the account's: never carried over.
    expect(own.oauthAccount).toBeUndefined();
    expect(own.projects).toBeUndefined();
    expect(fs.statSync(path.join(dir, '.claude.json')).mode & 0o777).toBe(0o600);
  });

  it("copies the launched project's whole entry, approvals included, and no other project", () => {
    const entry = { hasTrustDialogAccepted: true, enabledMcpjsonServers: ['repo-server'], hasClaudeMdExternalIncludesApproved: true, allowedTools: ['Bash(ls)'] };
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ projects: { '/work/app': entry, '/work/other': { hasTrustDialogAccepted: true } } }));
    provisionAccountDir(dir, home, { projectPath: '/work/app' });
    expect(readJson(path.join(dir, '.claude.json')).projects).toEqual({ '/work/app': entry });

    // A later launch of another project adds it, and keeps what the account wrote into the first.
    const file = path.join(dir, '.claude.json');
    const own = readJson(file);
    (own.projects as Record<string, Record<string, unknown>>)['/work/app'].lastSessionId = 'mine';
    fs.writeFileSync(file, JSON.stringify(own));
    provisionAccountDir(dir, home, { projectPath: '/work/other' });
    const after = readJson(file).projects as Record<string, Record<string, unknown>>;
    expect(after['/work/other']).toEqual({ hasTrustDialogAccepted: true });
    expect(after['/work/app'].lastSessionId).toBe('mine');
  });

  it("keeps every key of the account's own it does not mirror, and follows a removed server", () => {
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { a: { command: 'a' }, b: { command: 'b' } } }));
    provisionAccountDir(dir, home);
    const file = path.join(dir, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({ ...readJson(file), oauthAccount: { emailAddress: 'two@example.com' }, userID: 'u2' }));
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { a: { command: 'a' } } }));
    provisionAccountDir(dir, home);
    const own = readJson(file);
    expect(own.oauthAccount).toEqual({ emailAddress: 'two@example.com' });
    expect(own.userID).toBe('u2');
    expect(own.mcpServers).toEqual({ a: { command: 'a' } });
  });

  it("leaves the account's file alone when ~/.claude.json does not parse", () => {
    provisionAccountDir(dir, home);
    const file = path.join(dir, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { keep: { command: 'k' } }, hasCompletedOnboarding: true }));
    fs.writeFileSync(path.join(home, '.claude.json'), '{ broken');
    provisionAccountDir(dir, home);
    expect(readJson(file).mcpServers).toEqual({ keep: { command: 'k' } });
  });
});

describe.skipIf(claudeAccountsNotPorted())('credentials Claude Code would use instead of the account', () => {
  const vars = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

  it('finds none in a plain setup', () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: { FOO: 'x' } }));
    expect(claudeCredentialOverrides(home, { PATH: '/usr/bin' })).toEqual([]);
  });

  it.each(vars)('names %s in the settings env, and in Tars\'s own environment, never its value', (name) => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: { [name]: 'secret-value-1' } }));
    const found = claudeCredentialOverrides(home, { [name]: 'secret-value-2' });
    expect(found).toHaveLength(2);
    expect(found.join(' ')).toContain(name);
    expect(found.join(' ')).not.toMatch(/secret-value/);
  });

  const switches = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_OAUTH_REFRESH_TOKEN'];

  it.each(switches)('names %s turned on in the settings env and in Tars\'s own environment, never its value', (name) => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: { [name]: 'true', AWS_SECRET_ACCESS_KEY: 'secret-value-3' } }));
    const found = claudeCredentialOverrides(home, { [name]: '1', GOOGLE_APPLICATION_CREDENTIALS: '/secret-value-4' });
    expect(found).toHaveLength(2);
    expect(found.join(' ')).toContain(name);
    expect(found.join(' ')).not.toMatch(/secret-value/);
  });

  it('does not name a provider switch that is turned off, as Claude Code reads it', () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: 'false' } }));
    expect(claudeCredentialOverrides(home, { CLAUDE_CODE_USE_FOUNDRY: '' })).toEqual([]);
  });

  it('does not name cloud credentials alone: without a switch Claude Code does not use them', () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: { AWS_ACCESS_KEY_ID: 'x' } }));
    expect(claudeCredentialOverrides(home, { AWS_PROFILE: 'work', GOOGLE_APPLICATION_CREDENTIALS: '/x.json' })).toEqual([]);
  });

  it('names apiKeyHelper, and reads nothing it cannot parse as clean', () => {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ apiKeyHelper: '/x/key' }));
    expect(claudeCredentialOverrides(home, {}).join(' ')).toContain('apiKeyHelper');
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{ broken');
    expect(claudeCredentialOverrides(home, {}).join(' ')).toMatch(/settings.json/);
  });
});

describe.skipIf(claudeAccountsNotPorted())('credentials', () => {
  it('never opens, stats or lists anything in the directory but the files it owns', () => {
    provisionAccountDir(dir, home);
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"trap"}}', { mode: 0o600 });
    watch.touched.length = 0;
    watch.on = true;
    try {
      provisionAccountDir(dir, home);
    } finally {
      watch.on = false;
    }
    expect(watch.touched.length).toBeGreaterThan(0);
    expect(watch.touched.filter(t => t.p.includes('.credentials'))).toEqual([]);
    expect(watch.touched.filter(t => (t.fn === 'readdirSync' || t.fn === 'opendirSync') && t.p.startsWith(dir))).toEqual([]);
  });
});
