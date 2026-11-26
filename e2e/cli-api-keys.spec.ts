import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An API key per CLI (2.0.4): kept by Tars, handed to that CLI's agents only, through their terminal's environment,
 * under the variable that CLI reads; never in an argument (ps), never in the CLI's own files, never back to the window.
 *
 * The real app on a sandbox HOME. The CLIs are stand-ins named codex, gemini, grok, amp, opencode and pi, each the
 * cliPath of an agent of that provider: launched in the agent's terminal, each records its argv and the NAMES of the
 * key variables it got, with a sha256 of each value so the test can tell whose key it is without writing one down.
 *
 * Asserted:
 * 1. keys set from the window (cliKeys.set) for codex, gemini, grok, amp, opencode (under OPENROUTER_API_KEY, its
 *    choice) and pi (MISTRAL_API_KEY); a variable name that is not one, and a key with a line break, are refused;
 * 2. cliKeys.list names every CLI with its variable and hasKey, and carries no key; appSettings.get carries none;
 *    a settings save from the window, which holds none, erases none;
 * 3. each agent started from the window gets its own CLI's key, under its CLI's variable, and no other CLI's key;
 * 4. no argv carries a key; codex's carries the provider that names CODEX_API_KEY (its TUI reads no key otherwise,
 *    measured on 0.163);
 * 5. no file under the sandbox HOME but ~/.tars-private/settings-secrets.json holds a key (the CLIs' own folders,
 *    the window's profile; since 2.0.4 the keys are out of ~/.tars, secrets-private.spec.ts);
 * 6. codex's key cleared, and its CLI ended by itself (its shell stays, as when a CLI exits on its own): started
 *    again in that shell's place, it gets no CODEX_API_KEY and no provider of Tars's, its own login (the Audit's L1
 *    on #459: the reused shell kept the key it was spawned with).
 * Red on main 42fe71d8: there is no cliKeys channel, and codex's agent gets no key.
 * The artefact: values.json (the lists, the stand-ins' records, the files scanned), with E2E_TRACE=on the app's trace.
 */

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const name = path.basename(process.argv[1]);
const argv = process.argv.slice(2);
// Registration calls (mcp add, --version...) answer and leave: only a session records.
if (['mcp', '--version', 'version', 'login', 'auth', 'config'].includes(argv[0])) { process.stdout.write('ok\n'); process.exit(0); }
const keys = Object.keys(process.env).filter((k) => /_(API_KEY|KEY)$/.test(k)).sort();
const hashes = Object.fromEntries(keys.map((k) => [k, crypto.createHash('sha256').update(process.env[k]).digest('hex')]));
fs.appendFileSync(path.join(process.env.HOME, 'stand-in.jsonl'), JSON.stringify({ name, pid: process.pid, agent: process.env.CLAUDE_AGENT_ID || null, argv, keys, hashes }) + '\n');
process.stdout.write(name + ' stand-in ready\n');
process.stdin.on('data', () => {});
process.stdin.resume();
`;

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
/** Test keys, one per CLI: what each agent must get, and nobody else. */
const KEYS: Record<string, { key: string; envVar: string; set?: string }> = {
  codex: { key: 'sk-e2e-codex-1111', envVar: 'CODEX_API_KEY' },
  gemini: { key: 'e2e-gemini-2222', envVar: 'GEMINI_API_KEY' },
  grok: { key: 'xai-e2e-grok-3333', envVar: 'GROK_API_KEY' },
  amp: { key: 'sgamp-e2e-amp-4444', envVar: 'AMP_API_KEY' },
  opencode: { key: 'sk-or-e2e-opencode-5555', envVar: 'OPENROUTER_API_KEY', set: 'OPENROUTER_API_KEY' },
  pi: { key: 'e2e-pi-mistral-6666', envVar: 'MISTRAL_API_KEY', set: 'MISTRAL_API_KEY' },
};

type Rec = { name: string; pid: number; agent: string | null; argv: string[]; keys: string[]; hashes: Record<string, string> };
type KeyState = { id: string; envVar: string | null; hasKey: boolean };
type Api = { electronAPI: {
  cliKeys: { list(): Promise<KeyState[]>; set(id: string, patch: { key?: string | null; envVar?: string | null }): Promise<{ success: boolean; error?: string }> };
  appSettings: { get(): Promise<unknown>; save(s: unknown): Promise<unknown> };
  agent: { start(p: { id: string; prompt: string }): Promise<unknown>; stop(id: string, reason?: string): Promise<unknown>; list(): Promise<Array<{ id: string; cliRunning?: boolean }>> };
} };

/** Every file under `dir` that holds one of `needles`, skipping the folders that only grow. */
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

test(`an api key per cli reaches that cli's agents only, by its variable, never an argument, a file or the window`, async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-cli-keys-'));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin]) fs.mkdirSync(d, { recursive: true });
  const cliPaths: Record<string, string> = {};
  for (const cli of Object.keys(KEYS)) {
    cliPaths[cli] = path.join(bin, cli);
    fs.writeFileSync(cliPaths[cli], `#!${process.execPath}\n${STAND_IN}`, { mode: 0o755 });
  }
  const agent = (id: string, provider: string) => ({
    id, name: `${provider} agent`, character: 'robot', provider, status: 'idle', role: 'worker', projectPath: project, skills: [],
    permissionMode: 'normal', cliPath: cliPaths[provider], createdAt: '2026-10-18T08:00:00.000Z', lastActivity: '2026-10-18T08:00:00.000Z',
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(Object.keys(KEYS).map((cli) => agent(`a-${cli}`, cli)), null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { ...cliPaths, additionalPaths: [bin] },
    ...Object.fromEntries(Object.keys(KEYS).map((cli) => [`${cli}Enabled`, true])),
  }));
  const port = apiPort(31422);
  const values: Record<string, unknown> = { home };
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const records = () => (fs.existsSync(path.join(home, 'stand-in.jsonl'))
    ? fs.readFileSync(path.join(home, 'stand-in.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec) : []);
  const allKeys = Object.values(KEYS).map((k) => k.key);

  const app: ElectronApplication = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
  });
  try {
    const page = await app.firstWindow();
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(1, { timeout: 30_000 });
    const api = <T>(fn: (api: Api['electronAPI'], arg: unknown) => Promise<T>, arg?: unknown) =>
      page.evaluate(([src, a]) => (new Function('api', 'arg', `return (${src})(api, arg)`))((window as unknown as Api).electronAPI, a), [fn.toString(), arg] as const) as Promise<T>;

    // 1. Keys set from the window; what is not a key or not a variable name is refused.
    const set: Record<string, unknown> = {};
    for (const [cli, k] of Object.entries(KEYS)) {
      set[cli] = await api((a, arg) => { const [id, patch] = arg as [string, object]; return a.cliKeys.set(id, patch); }, [cli, { key: k.key, ...(k.set ? { envVar: k.set } : {}) }]);
    }
    const badName = await api((a) => a.cliKeys.set('opencode', { envVar: 'NODE_OPTIONS' }));
    const badKey = await api((a) => a.cliKeys.set('gemini', { key: 'line\nOTHER_API_KEY=x' }));
    for (const [cli, r] of Object.entries(set)) expect.soft(r, cli).toMatchObject({ success: true });
    expect.soft(badName).toMatchObject({ success: false });
    expect.soft(badKey).toMatchObject({ success: false });

    // 2. What the window can read carries no key, and a save from the window erases none.
    const list = await api((a) => a.cliKeys.list());
    const settings = await api((a) => a.appSettings.get());
    await api((a) => a.appSettings.get().then((s) => a.appSettings.save(s)));
    const listAfterSave = await api((a) => a.cliKeys.list());
    keep({ set, badName, badKey, list, listAfterSave });
    expect.soft(JSON.stringify(list)).not.toMatch(new RegExp(allKeys.join('|')));
    expect.soft(JSON.stringify(settings)).not.toMatch(new RegExp(allKeys.join('|')));
    expect.soft(list.map((c) => c.id).sort()).toEqual(['amp', 'cline', 'codex', 'gemini', 'grok', 'kilo', 'omp', 'opencode', 'pi', 'qwen-code']);
    for (const [cli, k] of Object.entries(KEYS)) {
      expect.soft(list.find((c) => c.id === cli), cli).toMatchObject({ hasKey: true, envVar: k.envVar });
      expect.soft(listAfterSave.find((c) => c.id === cli)?.hasKey, `${cli} after a save from the window`).toBe(true);
    }

    // 3, 4. Each agent started from the window.
    for (const cli of Object.keys(KEYS)) await api((a, id) => a.agent.start({ id: id as string, prompt: '' }), `a-${cli}`);
    await expect.poll(() => new Set(records().map((r) => r.agent)).size, { timeout: 60_000, message: 'every stand-in started' }).toBe(Object.keys(KEYS).length);
    const first = records();
    keep({ first });
    for (const [cli, k] of Object.entries(KEYS)) {
      const rec = first.find((r) => r.agent === `a-${cli}`)!;
      expect.soft(rec.hashes[k.envVar], `${cli} got its key under ${k.envVar}`).toBe(sha(k.key));
      const others = Object.entries(KEYS).filter(([c]) => c !== cli).map(([, o]) => sha(o.key));
      expect.soft(Object.values(rec.hashes).filter((h) => others.includes(h)), `${cli} got another CLI's key`).toEqual([]);
      expect.soft(rec.argv.join(' '), `${cli}'s argv`).not.toMatch(new RegExp(allKeys.join('|')));
    }
    const codexArgv = first.find((r) => r.agent === 'a-codex')!.argv.join(' ');
    expect.soft(codexArgv).toContain('model_provider=');
    expect.soft(codexArgv).toContain('env_key="CODEX_API_KEY"');

    // 5. No file but Tars's private settings holds a key.
    const holding = filesHolding(home, allKeys).map((p) => path.relative(home, p));
    keep({ holding });
    expect.soft(holding).toEqual([path.join('.tars-private', 'settings-secrets.json')]);

    // 6. Codex's key cleared: started again, it runs on its own login.
    const cleared = await api((a) => a.cliKeys.set('codex', { key: null }));
    // The CLI ends by itself; its shell stays.
    process.kill(first.find((r) => r.agent === 'a-codex')!.pid, 'SIGKILL');
    await expect.poll(async () => (await api((a) => a.agent.list())).find((x) => x.id === 'a-codex')?.cliRunning ?? false, { timeout: 30_000 }).toBe(false);
    await api((a) => a.agent.start({ id: 'a-codex', prompt: '' }));
    await expect.poll(() => records().filter((r) => r.agent === 'a-codex').length, { timeout: 60_000 }).toBe(2);
    const again = records().filter((r) => r.agent === 'a-codex')[1];
    keep({ cleared, again });
    expect.soft(cleared).toMatchObject({ success: true });
    expect.soft(again.keys).not.toContain('CODEX_API_KEY');
    expect.soft(again.argv.join(' ')).not.toContain('model_provider=');
  } finally {
    await app.close().catch(() => undefined);
    await removeHome(home);
  }
});
