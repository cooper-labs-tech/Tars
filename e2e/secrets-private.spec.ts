import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The secrets leave ~/.tars (2.0.4, the maintainer's decision of 18/10): ~/.tars is every agent's --add-dir,
 * and app-settings.json held every key of the app. They go to ~/.tars-private, which no agent is handed, and the
 * window loses its reach into both folders (the Audit's Holes 1 and 2).
 *
 * The real app on a sandbox HOME seeded as an install before 2.0.4 leaves it: an app-settings.json holding a bot
 * token, a provider's key, a codex key (#459), SocialData's and X's keys, Hermes's gateway token and Honcho's key;
 * a backup of it holding OpenRouter's key, and a temp file a write left; api-token, hermes-connection.json and
 * hermes-session.json in ~/.tars. Two agents whose CLIs are stand-ins that record the NAMES of the key variables
 * they got and a sha256 of each value, so no key is written down.
 *
 * Asserted, once with the classic shell and once with the new interface:
 * 1. the move: no file under the HOME but ~/.tars-private holds a seeded key, the window's profile included; the
 *    copies of the settings are gone; api-token and the Hermes files are in ~/.tars-private and not in ~/.tars;
 *    settings-secrets.json is 0600 in a 0700 folder;
 * 2. every feature finds its secret: the window is told each is set; the deepseek agent gets DeepSeek's key, the
 *    codex agent codex's; the local API takes the token now in ~/.tars-private; Hermes reads its connection there;
 * 3. the window gets no secret: appSettings.get carries none, a set one is a mask; a save of what it got erases none;
 *    secrets.set sets and clears one and never answers the value;
 * 4. the window reads no secret: fs.readTextFile of app-settings.json, settings-secrets.json and api-token, and
 *    local-file:// of the first two, are refused, while local-file:// still serves a vault attachment;
 * 5. the window writes no hook: fs.writeTextFile of statusline.sh, bin/tars-mcp-node, a hook, ~/.claude/settings.json
 *    and a project's git hook is refused and the files are unchanged; a project's CLAUDE.md is still written;
 * 6. (the Audit's L1 on 06a46bcb) no folder of credentials is a project: fs.addCustomProject(~/.kube) is refused, and
 *    ~/.kube/config is not read even once an agent has written ~/.kube into the projects' list; nor is a project's
 *    .env.local, while its source still is;
 * 7. (the Audit's M1) with ~/.tars-private not writable and a key still in app-settings.json, Tars starts, its
 *    window opens, and the key reads as set: it stopped on Electron's error box at its first 2.0.4 launch.
 * Red on main f53cef0c: the keys stay in app-settings.json, which appSettings.get returns, and fs.readTextFile reads.
 * The artefact: values.json (what each call answered, the files scanned, the stand-ins' records), with E2E_TRACE=on
 * the app's trace.
 */

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const argv = process.argv.slice(2);
if (['mcp', '--version', 'version', 'login', 'auth', 'config'].includes(argv[0])) { process.stdout.write('ok\n'); process.exit(0); }
const keys = Object.keys(process.env).filter((k) => /(_API_KEY|_KEY|_AUTH_TOKEN)$/.test(k) && process.env[k]).sort();
const hashes = Object.fromEntries(keys.map((k) => [k, crypto.createHash('sha256').update(process.env[k]).digest('hex')]));
fs.appendFileSync(path.join(process.env.HOME, 'stand-in.jsonl'), JSON.stringify({ agent: process.env.CLAUDE_AGENT_ID || null, keys, hashes }) + '\n');
process.stdout.write('stand-in ready\n');
process.stdin.resume();
`;

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const SECRETS = {
  discordBotToken: 'e2e-discord-bot-token-0000', deepSeekApiKey: 'sk-e2e-deepseek-1111', socialDataApiKey: 'e2e-socialdata-2222',
  xApiKey: 'e2e-x-key-3333', xApiSecret: 'e2e-x-secret-4444', xAccessToken: 'e2e-x-access-5555', xAccessTokenSecret: 'e2e-x-access-secret-6666',
  hermesGatewayToken: 'e2e-hermes-gateway-7777', memoryHonchoApiKey: 'e2e-honcho-8888', slackBotToken: 'xoxb-e2e-slack-9999',
};
const CODEX_KEY = 'sk-e2e-codex-aaaa';
const BACKUP_KEY = 'sk-or-e2e-backup-bbbb';
const TEMP_KEY = 'e2e-in-a-temp-file-cccc';
const API_TOKEN = 'e2e-shared-token-'.padEnd(64, 'd');
const HERMES_COOKIE = 'e2e-hermes-cookie-eeee';
const ALL = [...Object.values(SECRETS), CODEX_KEY, BACKUP_KEY, TEMP_KEY, API_TOKEN, HERMES_COOKIE];

type Rec = { agent: string | null; keys: string[]; hashes: Record<string, string> };
type Api = { electronAPI: {
  appSettings: { get(): Promise<Record<string, unknown>>; save(s: unknown): Promise<unknown> };
  secrets: { set(field: string, value: string | null): Promise<{ success: boolean; set?: boolean; error?: string }> };
  fs: {
    readTextFile(p: string): Promise<{ content: string; error?: string }>; writeTextFile(p: { filePath: string; content: string }): Promise<{ success: boolean; error?: string }>;
    addCustomProject(p: string): Promise<{ success: boolean; error?: string }>;
  };
  agent: { start(p: { id: string; prompt: string }): Promise<unknown> };
  hermes: { getConnection(): Promise<{ connection: Record<string, unknown> }> };
} };

function filesHolding(dir: string, needles: string[], out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) { if (!['node_modules', 'Cache', 'Code Cache', 'GPUCache'].includes(e.name)) filesHolding(p, needles, out); continue; }
    try {
      if (fs.statSync(p).size > 20_000_000) continue;
      const text = fs.readFileSync(p).toString('latin1');
      if (needles.some((n) => text.includes(n))) out.push(p);
    } catch { /* gone meanwhile */ }
  }
  return out;
}

for (const newInterface of [false, true]) {
  test(`the secrets leave ~/.tars, every feature finds them, and the window reads and writes none${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-secrets-'));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    const priv = path.join(home, '.tars-private');
    const bin = path.join(home, 'bin');
    for (const d of [project, dir, bin, path.join(project, '.git', 'hooks'), path.join(dir, 'vault', 'attachments')]) fs.mkdirSync(d, { recursive: true });
    const cliPath = path.join(bin, 'claude-stand-in');
    fs.writeFileSync(cliPath, `#!${process.execPath}\n${STAND_IN}`, { mode: 0o755 });
    const codexPath = path.join(bin, 'codex');
    fs.writeFileSync(codexPath, `#!${process.execPath}\n${STAND_IN}`, { mode: 0o755 });
    const agent = (id: string, provider: string, cli: string) => ({
      id, name: `${provider} agent`, character: 'robot', provider, status: 'idle', role: 'worker', projectPath: project, skills: [],
      permissionMode: 'normal', cliPath: cli, createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([agent('a-deepseek', 'deepseek', cliPath), agent('a-codex', 'codex', codexPath)], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    // An install before 2.0.4: every key in app-settings.json, and copies of it beside it.
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface, deepSeekEnabled: true, codexEnabled: true,
      cliPaths: { claude: cliPath, codex: codexPath, additionalPaths: [bin] }, discordEnabled: false, xPostingEnabled: false,
      cliApiKeys: { codex: { key: CODEX_KEY } }, ...SECRETS,
    }));
    fs.writeFileSync(path.join(dir, 'app-settings.json.avant-node-22.bak'), JSON.stringify({ openRouterApiKey: BACKUP_KEY }));
    fs.writeFileSync(path.join(dir, 'app-settings.json.tmp'), `{"slackAppToken": "${TEMP_KEY}", "half`);
    fs.writeFileSync(path.join(dir, 'api-token'), API_TOKEN);
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'hermes-session.json'), JSON.stringify({ 'http://127.0.0.1:9': { session: HERMES_COOKIE } }));
    const attachment = path.join(dir, 'vault', 'attachments', 'a-picture.png');
    fs.writeFileSync(attachment, 'PNG');
    const port = apiPort(newInterface ? 31972 : 31971);
    const values: Record<string, unknown> = { newInterface, home };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const records = () => (fs.existsSync(path.join(home, 'stand-in.jsonl'))
      ? fs.readFileSync(path.join(home, 'stand-in.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec) : []);

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });
      const api = <T>(fn: (api: Api['electronAPI'], arg: unknown) => Promise<T>, arg?: unknown) =>
        page.evaluate(([src, a]) => (new Function('api', 'arg', `return (${src})(api, arg)`))((window as unknown as Api).electronAPI, a), [fn.toString(), arg] as const) as Promise<T>;

      // 1. The move.
      const left = ['app-settings.json.avant-node-22.bak', 'app-settings.json.tmp', 'api-token', 'hermes-connection.json', 'hermes-session.json']
        .filter((f) => fs.existsSync(path.join(dir, f)));
      const moved = ['settings-secrets.json', 'api-token', 'hermes-connection.json', 'hermes-session.json'].filter((f) => fs.existsSync(path.join(priv, f)));
      // Read softly, so that on a Tars without the move (the red witness) every check below still runs.
      const modeOf = (p: string) => (fs.existsSync(p) ? fs.statSync(p).mode & 0o777 : null);
      const modes = { file: modeOf(path.join(priv, 'settings-secrets.json')), dir: modeOf(priv) };
      const outside = filesHolding(home, ALL).map((p) => path.relative(home, p)).filter((p) => !p.startsWith('.tars-private'));
      keep({ left, moved, modes, outside });
      expect.soft(left).toEqual([]);
      expect.soft(moved).toEqual(['settings-secrets.json', 'api-token', 'hermes-connection.json', 'hermes-session.json']);
      expect.soft(modes).toEqual({ file: 0o600, dir: 0o700 });
      expect.soft(outside, 'files outside ~/.tars-private holding a key').toEqual([]);
      const readPrivate = () => (fs.existsSync(path.join(priv, 'settings-secrets.json')) ? fs.readFileSync(path.join(priv, 'settings-secrets.json'), 'utf8') : '');
      const privateFile = readPrivate();
      for (const k of [...Object.values(SECRETS), CODEX_KEY, BACKUP_KEY]) expect.soft(privateFile.includes(k), `the private file holds ${k.slice(0, 12)}`).toBe(true);

      // 2, 3. What the window gets: whether each is set, never a value.
      const shown = await api((a) => a.appSettings.get());
      keep({ shown: { ...shown, cliPaths: undefined } });
      expect.soft(JSON.stringify(shown)).not.toMatch(new RegExp(ALL.join('|')));
      for (const f of Object.keys(SECRETS)) expect.soft((shown.secretsSet as Record<string, boolean>)?.[f], `${f} is set`).toBe(true);
      expect.soft(String(shown.deepSeekApiKey)).toMatch(/^•+$/);
      await api((a) => a.appSettings.get().then((s) => a.appSettings.save(s)));
      const afterSave = readPrivate();
      for (const k of Object.values(SECRETS)) expect.soft(afterSave.includes(k), 'a save from the window keeps every key').toBe(true);
      const setOne = await api((a) => a.secrets?.set('jiraApiToken', 'e2e-jira-ffff') ?? Promise.resolve('no secrets channel'));
      const clearOne = await api((a) => a.secrets?.set('slackBotToken', null) ?? Promise.resolve('no secrets channel'));
      const refused = await api((a) => a.secrets?.set('discordEnabled', 'true') ?? Promise.resolve('no secrets channel'));
      keep({ setOne, clearOne, refused });
      expect.soft(setOne).toEqual({ success: true, set: true });
      expect.soft(clearOne).toEqual({ success: true, set: false });
      expect.soft(refused).toMatchObject({ success: false });
      const afterSet = readPrivate();
      expect.soft(afterSet.includes('e2e-jira-ffff') && !afterSet.includes(SECRETS.slackBotToken)).toBe(true);
      expect.soft(fs.readFileSync(path.join(dir, 'app-settings.json'), 'utf8')).not.toContain('e2e-jira-ffff');

      // 2. Every feature finds its secret.
      for (const id of ['a-deepseek', 'a-codex']) await api((a, x) => a.agent.start({ id: x as string, prompt: '' }), id);
      await expect.poll(() => new Set(records().map((r) => r.agent)).size, { timeout: 60_000, message: 'both stand-ins started' }).toBe(2);
      const recs = records();
      keep({ recs });
      const deepseek = recs.find((r) => r.agent === 'a-deepseek')!;
      expect.soft(Object.values(deepseek.hashes), 'the deepseek agent got its key').toContain(sha(SECRETS.deepSeekApiKey));
      expect.soft(recs.find((r) => r.agent === 'a-codex')!.hashes.CODEX_API_KEY, 'the codex agent got its key').toBe(sha(CODEX_KEY));
      const withToken = await fetch(`http://127.0.0.1:${port}/api/agents`, { headers: { Authorization: `Bearer ${API_TOKEN}` } });
      const hermes = await api((a) => a.hermes.getConnection());
      keep({ apiWithToken: withToken.status, hermes: hermes.connection });
      expect.soft(withToken.status, 'the local API takes the token now in ~/.tars-private').toBe(200);
      expect.soft(hermes.connection).toMatchObject({ mode: 'local', localPort: 9 });

      // 4. The window reads no secret; local-file:// serves an attachment and no secret.
      const reads: Record<string, unknown> = {};
      for (const f of [path.join(dir, 'app-settings.json'), path.join(priv, 'settings-secrets.json'), path.join(priv, 'api-token')]) {
        reads[f] = await api((a, p) => a.fs.readTextFile(p as string), f);
      }
      const served: Record<string, number> = {};
      for (const f of [attachment, path.join(dir, 'app-settings.json'), path.join(priv, 'settings-secrets.json')]) {
        // With a host: local-file is a standard scheme, so Chromium reads local-file:///var/... as the host
        // `var` and the path /folders/..., and the empty-host form serves nothing at all. Any host keeps the
        // path whole, which is how a page reached ~/.tars through it.
        served[f] = await app.evaluate(async ({ net }, url) => (await net.fetch(url)).status, `local-file://h${f}`);
      }
      keep({ reads, served });
      for (const [f, r] of Object.entries(reads)) expect.soft((r as { content: string }).content, `read ${f}`).toBe('');
      expect.soft(served[attachment]).toBe(200);
      expect.soft(served[path.join(dir, 'app-settings.json')]).toBe(403);
      expect.soft(served[path.join(priv, 'settings-secrets.json')]).toBe(403);

      // 5. The window writes no hook, and still an instruction file.
      const targets = [path.join(dir, 'statusline.sh'), path.join(dir, 'bin', 'tars-mcp-node'), path.join(dir, 'hooks', 'on-stop.sh'),
        path.join(home, '.claude', 'settings.json'), path.join(project, '.git', 'hooks', 'pre-commit')];
      const before = Object.fromEntries(targets.map((t) => [t, fs.existsSync(t) ? sha(fs.readFileSync(t, 'utf8')) : null]));
      const writes: Record<string, unknown> = {};
      for (const t of targets) writes[t] = await api((a, p) => a.fs.writeTextFile({ filePath: p as string, content: '#!/bin/sh\ntouch "$HOME/pwned"\n' }), t);
      const after = Object.fromEntries(targets.map((t) => [t, fs.existsSync(t) ? sha(fs.readFileSync(t, 'utf8')) : null]));
      const instructions = await api((a, p) => a.fs.writeTextFile({ filePath: p as string, content: '# Demo\n' }), path.join(project, 'CLAUDE.md'));
      keep({ writes, before, after, instructions });
      for (const [t, r] of Object.entries(writes)) expect.soft((r as { success: boolean }).success, `write ${t}`).toBe(false);
      expect.soft(after).toEqual(before);
      expect.soft(instructions).toMatchObject({ success: true });
      expect.soft(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8')).toBe('# Demo\n');

      // 6. No folder of credentials, as a project or through one; no .env of any kind.
      const kube = path.join(home, '.kube');
      fs.mkdirSync(kube, { recursive: true });
      fs.writeFileSync(path.join(kube, 'config'), 'token: e2e-kube-token-ffff');
      fs.writeFileSync(path.join(project, '.env.local'), 'KEY=e2e-env-local-gggg');
      fs.mkdirSync(path.join(project, 'src'), { recursive: true });
      fs.writeFileSync(path.join(project, 'src', 'a.ts'), 'export const a = 1;\n');
      const added = await api((a, p) => a.fs.addCustomProject(p as string), kube);
      // As an agent could: the projects' list lives in ~/.tars (projects.json).
      fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project, kube]));
      const reads6 = {
        kube: await api((a, p) => a.fs.readTextFile(p as string), path.join(kube, 'config')),
        envLocal: await api((a, p) => a.fs.readTextFile(p as string), path.join(project, '.env.local')),
        source: await api((a, p) => a.fs.readTextFile(p as string), path.join(project, 'src', 'a.ts')),
      };
      keep({ added, reads6 });
      expect.soft(added.success, 'a folder of credentials added as a project').toBe(false);
      expect.soft(reads6.kube.content).not.toContain('e2e-kube-token');
      expect.soft(reads6.envLocal.content).not.toContain('e2e-env-local');
    } finally {
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}

for (const newInterface of [false, true]) {
  test(`Tars starts when the secrets cannot leave ~/.tars yet${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    test.skip(process.platform === 'win32', 'a folder made read-only by its mode');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-secrets-locked-'));
    const dir = path.join(home, '.tars');
    const priv = path.join(home, '.tars-private');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface, deepSeekApiKey: SECRETS.deepSeekApiKey,
    }));
    fs.writeFileSync(path.join(dir, 'app-settings.json.bak'), JSON.stringify({ openRouterApiKey: BACKUP_KEY }));
    // A private folder Tars may not write: EACCES on the move, as a full disk gives ENOSPC.
    fs.mkdirSync(priv, { recursive: true, mode: 0o700 });
    fs.chmodSync(priv, 0o500);
    const port = apiPort(newInterface ? 31974 : 31973);
    const values: Record<string, unknown> = { newInterface, home };
    let app: ElectronApplication | undefined;
    try {
      app = await launchSandboxed(electron, home, {
        env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
      });
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
      const got = await page.evaluate(() => (window as unknown as Api).electronAPI.appSettings.get());
      const secretsSet = (got.secretsSet ?? {}) as Record<string, boolean>;
      Object.assign(values, { started: true, secretsSet, backupKept: fs.existsSync(path.join(dir, 'app-settings.json.bak')) });
      recordValues(values);
      expect.soft(secretsSet.deepSeekApiKey, 'the key, read where it is').toBe(true);
      expect.soft(secretsSet.openRouterApiKey === true || fs.existsSync(path.join(dir, 'app-settings.json.bak')), 'the key a backup alone holds, kept').toBe(true);
      expect.soft(JSON.stringify(got)).not.toContain(SECRETS.deepSeekApiKey);
    } finally {
      recordValues({ ...values, started: values.started ?? false });
      await app?.close().catch(() => undefined);
      fs.chmodSync(priv, 0o700);
      await removeHome(home);
    }
  });
}
