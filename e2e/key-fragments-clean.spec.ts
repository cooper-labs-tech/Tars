import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * What Tars before 2.0.4 left of a key provider's key is gone after the first start of 2.0.4, and so are the run
 * token folders a crash left (the Audit's M2 and L1 on #458).
 *
 * Seeded as an install of 2.0.3 left it: an agent on deepseek whose kept output holds Claude Code's question (its
 * bytes as 2.1.302 wrote them, measured, the key's last 20 characters in them), in agents.json at version 3 and in its
 * backup; those 20 characters in the rejected list of ~/.claude.json, beside the user's own, and of an account
 * folder's, and in the copies Claude Code keeps of both (a backup in each `backups/`, a write it never finished beside
 * ~/.claude.json); a run token folder of a Tars that is gone, and one of a Tars still running. Then Tars starts on
 * that home.
 *
 * Asserted, both shells: no file of the home holds the key's 20 characters but app-settings.json, where the key is;
 * the agent's kept output keeps everything else; ~/.claude.json keeps the user's own entry and its other fields, in
 * 0600, and the account folder's its own; agents.json is at version 4; the gone Tars's run token folder is removed,
 * and the running one's is kept. The artefact: values.json (where the tail was found, before and after) and the
 * screenshot.
 *
 * The other fields seeded are none of Claude Code's defaults: Tars runs `claude auth status` for each account at
 * start, and Claude Code drops a key at its default value when it saves the file, `theme: "dark"` and an emptied
 * `customApiKeyResponses` among them (measured, 2.1.302).
 */

const tail = (key: string) => key.trim().slice(-20);
const question = (key: string) => '\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?25l\x1b[?2004h\r\r\n\x1b[38;5;220m'
  + '─'.repeat(120) + '\x1b[39m\r\r\n\x1b[3G\x1b[38;5;220m\x1b[1mDetected\x1b[12Ga\x1b[14Gcustom\x1b[21GAPI\x1b[25Gkey\x1b[29Gin'
  + '\x1b[32Gyour\x1b[37Genvironment\x1b[22m\x1b[39m\r\r\n\r\r\n\x1b[3G\x1b[1mANTHROPIC_API_KEY\x1b[22m:\x1b[22Gsk-ant-...'
  + tail(key) + '\r\r\n\r\r\n\x1b[3GDo\x1b[6Gyou\x1b[10Gwant\x1b[15Gto\x1b[18Guse\x1b[22Gthis\x1b[27GAPI\x1b[31Gkey?\r\r\n';

/** Every file under `root` that holds `needle`, relative to it. */
function holding(root: string, needle: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try { if (fs.statSync(p).size < 20_000_000 && fs.readFileSync(p).includes(needle)) found.push(path.relative(root, p)); } catch { /* gone */ }
      }
    }
  };
  walk(root);
  return found.sort();
}

for (const newInterface of [false, true]) {
  test(`the first start of 2.0.4 removes what 2.0.3 left of a key provider's key${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(2 * 60_000);
    const home = fs.mkdtempSync('/tmp/dorothy-e2e-key-fragments-');
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.dorothy');
    for (const d of [project, dir, path.join(home, '.tars-private')]) fs.mkdirSync(d, { recursive: true });
    const key = `sk-${randomBytes(16).toString('hex')}`;
    const users = `sk-ant-api03-${randomBytes(20).toString('hex')}`;

    const output = ['the session began\r\n', question(key), 'and went on\r\n'];
    const agents = [{ id: 'dddd1111-0000-4000-8000-0000000000d1', name: 'Dee', character: 'robot', provider: 'deepseek', status: 'idle', role: 'worker',
      permissionMode: 'normal', projectPath: project, skills: [], output, createdAt: '2026-10-17T08:00:00.000Z', lastActivity: '2026-10-17T08:00:00.000Z' }];
    for (const file of ['agents.json', 'agents.backup.json']) {
      fs.writeFileSync(path.join(dir, file), JSON.stringify({ version: 3, savedAt: '2026-10-17T08:00:00.000Z', agents }, null, 2));
    }
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', deepSeekApiKey: key, newInterface }, null, 2));
    const claudeJson = path.join(home, '.claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({ numStartups: 3, theme: 'light', customApiKeyResponses: { approved: [], rejected: [tail(key), tail(users)] } }, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(home, '.tars-private', 'claude-accounts.json'), JSON.stringify({ enabled: true, accounts: [{ id: 'default' }, { id: 'acct-0a1b2c', label: 'Account 2' }] }));
    const accountJson = path.join(home, '.claude-accounts', 'acct-0a1b2c', '.claude.json');
    fs.mkdirSync(path.dirname(accountJson), { recursive: true });
    fs.writeFileSync(accountJson, JSON.stringify({ numStartups: 5, customApiKeyResponses: { approved: [], rejected: [tail(key)] } }, null, 2), { mode: 0o600 });
    // Claude Code's copies, named as it names them (2.1.302): a backup in each config home's backups/, and a leftover.
    const homeBackup = path.join(home, '.claude', 'backups', '.claude.json.backup.1792350644690');
    const copies: Array<[string, string[]]> = [[homeBackup, [tail(key), tail(users)]], [path.join(home, '.claude.json.tmp.78791.84efb0c4c9ae'), [tail(key)]],
      [path.join(path.dirname(accountJson), 'backups', '.claude.json.backup.1792350644614'), [tail(key)]]];
    for (const [file, rejected] of copies) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ numStartups: 2, customApiKeyResponses: { approved: [], rejected } }, null, 2), { mode: 0o600 });
    }

    // Run token folders where the app makes them, its temporary folder, which it inherits from here.
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid!;
    const runner: ChildProcess = spawn('/bin/sleep', ['120']);
    const gone = path.join(os.tmpdir(), `tars-run-${deadPid}-${randomBytes(3).toString('hex')}`);
    const running = path.join(os.tmpdir(), `tars-run-${runner.pid}-${randomBytes(3).toString('hex')}`);
    for (const d of [gone, running]) {
      fs.mkdirSync(d, { mode: 0o700 });
      fs.writeFileSync(path.join(d, 'token'), 'a dead run token', { mode: 0o600 });
    }

    const values: Record<string, unknown> = { newInterface, before: holding(home, tail(key)) };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    keep({});
    let app: ElectronApplication | undefined;
    try {
      app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31325 : 31324), DOROTHY_E2E: '1' } });
      const appLog = test.info().outputPath('app.log');
      app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
      app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
      const page = await app.firstWindow();
      // The cleaning's end, which a build without it never reaches: soft, so that its values.json says what was left.
      await expect.soft.poll(() => holding(home, tail(key)), { message: 'the key\'s 20 characters, left anywhere but in the settings', timeout: 30_000 })
        .toEqual(['.dorothy/app-settings.json']);
      await stepShot(page, newInterface ? 'cleaned-new-interface' : 'cleaned');

      const saved = (file: string) => (JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).agents as Array<{ output: string[] }>)[0].output.join('');
      const config = JSON.parse(fs.readFileSync(claudeJson, 'utf8'));
      const account = JSON.parse(fs.readFileSync(accountJson, 'utf8'));
      const agentsVersion = JSON.parse(fs.readFileSync(path.join(dir, 'agents.json'), 'utf8')).version;
      keep({
        after: holding(home, tail(key)), agentsVersion,
        rejected: (config.customApiKeyResponses?.rejected ?? []).map((t: string) => (t === tail(users) ? 'the user\'s own' : 'another')),
        claudeJsonMode: (fs.statSync(claudeJson).mode & 0o777).toString(8), goneFolder: fs.existsSync(gone), runningFolder: fs.existsSync(running),
      });
      expect(values.before, 'the seed').toEqual(expect.arrayContaining(['.dorothy/agents.json', '.dorothy/agents.backup.json', '.claude.json',
        '.claude/backups/.claude.json.backup.1792350644690', '.claude.json.tmp.78791.84efb0c4c9ae', '.claude-accounts/acct-0a1b2c/backups/.claude.json.backup.1792350644614']));
      expect.soft(JSON.parse(fs.readFileSync(homeBackup, 'utf8')).customApiKeyResponses?.rejected, "Claude Code's backup: the user's own entry").toEqual([tail(users)]);
      expect.soft(agentsVersion, 'agents.json').toBe(4);
      for (const file of ['agents.json', 'agents.backup.json']) {
        expect.soft(saved(file), `${file}: the rest of the output`).toContain('the session began');
        expect.soft(saved(file), file).toContain('and went on');
        expect.soft(saved(file), file).toContain('\x1b[1mDetected\x1b[12Ga');
      }
      expect.soft(config.customApiKeyResponses?.rejected, "~/.claude.json: the user's own entry").toEqual([tail(users)]);
      expect.soft(config, '~/.claude.json: its other fields').toMatchObject({ numStartups: 3, theme: 'light' });
      expect.soft(fs.statSync(claudeJson).mode & 0o777).toBe(0o600);
      // Emptied, the list is Claude Code's default, which its next save of the file leaves out.
      expect.soft(account.customApiKeyResponses?.rejected ?? [], "the account folder's").toEqual([]);
      expect.soft(account, "the account folder's other fields").toMatchObject({ numStartups: 5 });
      expect.soft(fs.existsSync(gone), 'the run token folder of a Tars gone').toBe(false);
      expect.soft(fs.existsSync(path.join(running, 'token')), 'the run token folder of a Tars running').toBe(true);
    } finally {
      runner.kill();
      await app?.close();
      for (const d of [gone, running]) fs.rmSync(d, { recursive: true, force: true });
      await removeHome(home);
    }
  });
}
