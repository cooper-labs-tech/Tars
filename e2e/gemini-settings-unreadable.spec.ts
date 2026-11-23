import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Gemini's own settings file, ~/.gemini/settings.json, which Tars writes its hooks into at every start and its MCP
 * servers into when `gemini mcp add` fails (the Audit's P-1 on #633), in the real app on a sandbox HOME.
 *
 * 1. A settings file gemini could not read either (a trailing comma), holding the user's own server and auth: Tars
 *    starts, then the window starts a gemini agent. The file must be byte for byte what the user wrote, and the agent's
 *    output must say it runs without Tars's hooks, so unheard, until the file is fixed; the log says it at the start.
 * 2. A settings file with comments, which gemini reads: Tars's hooks and the token's allow-list must be written into
 *    it, the user's comments, server and auth kept.
 * Red on main 58f2863b4: Tars's start replaces the first file with its hooks and servers alone, and the second loses
 * its comments.
 *
 * No gemini on the sandbox's PATH, so Tars's start registers its servers through the settings file itself; the
 * agent's CLI is a stand-in under another name, its `cliPath`, which records its launch and waits.
 * The artefact: values.json (the files before and after, the agent's kept output, the log's lines), agents.png, and
 * with E2E_TRACE=on the app's trace.
 */

type Agent = { id: string; status: string; output?: string[]; cliRunning?: boolean };
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; get(id: string): Promise<Agent | null>; list(): Promise<Agent[]> } } };

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path');
fs.appendFileSync(path.join(process.env.HOME, 'gemini-launches.jsonl'), JSON.stringify({ argv: process.argv.slice(2), at: Date.now() }) + '\n');
process.stdout.write('\r\n> Type your message or @path/to/file\r\n');
process.stdin.resume();
`;

const UNREADABLE = '{\n  "mcpServers": { "mine": { "command": "my-own-server" } },\n  "security": { "auth": { "selectedType": "oauth-personal" } },\n}\n';
const COMMENTED = [
  '// My gemini settings, kept by hand.',
  '{',
  '  /* the servers I use */',
  '  "mcpServers": { "mine": { "command": "my-own-server" } }, // mine',
  '  "security": { "auth": { "selectedType": "oauth-personal" } }',
  '}',
  '',
].join('\n');

/** As gemini 0.70.0 reads it: its comments out, then strict JSON. */
function asGeminiReads(text: string): Record<string, unknown> {
  return JSON.parse(text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => (str ? m : ' '.repeat(m.length))));
}

async function run(label: string, settings: string, port: number) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-gemini-${label}-`));
  const project = path.join(home, 'projects', 'demo');
  const dir = path.join(home, '.tars');
  const bin = path.join(home, 'bin');
  for (const d of [project, dir, bin, path.join(home, '.gemini')]) fs.mkdirSync(d, { recursive: true });
  const settingsFile = path.join(home, '.gemini', 'settings.json');
  fs.writeFileSync(settingsFile, settings);
  const standIn = path.join(bin, 'gemini-stand-in');
  fs.writeFileSync(standIn, `#!${process.execPath}\n${STAND_IN}`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
    id: 'g1', name: 'Gemini Worker', character: 'robot', provider: 'gemini', status: 'idle', role: 'worker', projectPath: project,
    skills: [], permissionMode: 'normal', cliPath: standIn, createdAt: '2026-11-23T08:00:00.000Z', lastActivity: '2026-11-23T08:00:00.000Z',
  }], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', geminiEnabled: true }));

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(port), DOROTHY_E2E: '1' },
  });
  const log: string[] = [];
  app.process().stdout?.on('data', (d) => log.push(String(d)));
  app.process().stderr?.on('data', (d) => log.push(String(d)));
  const pageErrors: string[] = [];
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!(window as unknown as Partial<Api>).electronAPI);
    // Tars's start has written, or left, the file: its hooks are set before the window can start an agent (main.ts).
    await page.evaluate(() => (window as unknown as Api).electronAPI.agent.start({ id: 'g1', prompt: '' }));
    const launches = path.join(home, 'gemini-launches.jsonl');
    await expect.poll(() => fs.existsSync(launches), { timeout: 30_000, message: 'the gemini agent never launched' }).toBe(true);
    // The agent's kept output, where Tars's notices go (agentNotice): what /api/agents/:id/output and get_agent_output
    // serve, and Logs once its terminal ends. While it runs, the window's pane shows its terminal's screen instead,
    // which a notice of Tars's does not reach on main (the notices channel of #624 draws them there); recorded too.
    const output = await app.evaluate((_e, { dist }) => ((process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get('g1')?.output ?? []) as string[]).join(''), { dist: path.resolve('electron', 'dist') });
    const screen = ((await page.evaluate(() => (window as unknown as Api).electronAPI.agent.get('g1')))?.output ?? []).join('');
    await stepShot(page, `agents-${label}`);
    const after = fs.readFileSync(settingsFile, 'utf8');
    const notices = output.split(/\r?\n/).filter((l) => l.includes('[Tars]'));
    const logLines = log.join('').split('\n').filter((l) => /\[gemini\]/.test(l));
    return { home, before: settings, after, notices, noticesOnScreen: screen.split(/\r?\n/).filter((l) => l.includes('[Tars]')), logLines, pageErrors };
  } finally {
    await app.close().catch(() => { /* gone */ });
    await removeHome(home);
  }
}

test.describe("gemini's settings file", () => {
  test.setTimeout(180_000);

  test('1. one gemini could not read either is left byte for byte, and the agent says it runs without Tars\'s hooks', async () => {
    const r = await run('unreadable', UNREADABLE, 31372);
    recordValues({ unreadable: r });
    expect(r.after, 'the user\'s settings file was replaced').toBe(UNREADABLE);
    expect(r.notices.join('\n'), 'the agent was not told it runs without Tars\'s hooks').toMatch(/settings\.json.*turns/);
    expect(r.notices.join('\n')).not.toMatch(/[\u2013\u2014]/);
    expect(r.logLines.join('\n'), 'the log said nothing').toMatch(/hooks not written/);
    expect(r.pageErrors).toEqual([]);
  });

  test("2. one with comments gets Tars's hooks, its comments and the user's settings kept", async () => {
    const r = await run('commented', COMMENTED, 31373);
    recordValues({ commented: r });
    for (const comment of ['// My gemini settings, kept by hand.', '/* the servers I use */', '// mine']) expect(r.after, comment).toContain(comment);
    const settings = asGeminiReads(r.after) as { mcpServers: Record<string, unknown>; security: { auth: unknown; environmentVariableRedaction?: { allowed?: string[] } }; hooks?: unknown };
    expect(settings.mcpServers.mine).toEqual({ command: 'my-own-server' });
    expect(settings.security.auth).toEqual({ selectedType: 'oauth-personal' });
    expect(JSON.stringify(settings.hooks ?? {})).toMatch(/session-start/);
    expect(settings.security.environmentVariableRedaction?.allowed).toContain('CLAUDE_MGR_API_TOKEN');
    expect(r.notices).toEqual([]);
    expect(r.pageErrors).toEqual([]);
  });
});
