import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * OSC 7501, the Program Status Protocol, in the real app (services/program-status, 2.0.5).
 *
 * The CLI is a stand-in, faithful to what was measured on 22/10: claude 2.1.308 sends `OSC 7501 ; ?` then a DA1
 * query at start and reports only once the probe is answered (a real claude in a sandbox HOME is signed out and
 * stops at its onboarding, which reports nothing). It runs as a grok agent, a CLI with no hooks, so its reports
 * are what moves the agent.
 *
 * Asserted, with the classic shell and with the new interface:
 * 1. Tars answers the probe, from the main process, with the states and kinds it reads (the stand-in logs what
 *    reached it, and goes silent without an answer).
 * 2. The agent follows the reports: running, then waiting on a question with its message kept for the window,
 *    then idle once the CLI says done.
 * Red on main (acb8d2f4): no answer, so the stand-in reports nothing, and the agent never leaves idle.
 * The artefact: values.json (what the stand-in received, every status and record seen).
 */

const STAND_IN = `#!${process.execPath}
const fs = require('fs');
const log = process.argv[2];
const note = (line) => fs.appendFileSync(log, line + '\\n');
const b64 = (t) => Buffer.from(t, 'utf8').toString('base64');
const osc = (body) => process.stdout.write('\\x1b]7501;' + body + '\\x1b\\\\');
process.stdin.setRawMode && process.stdin.setRawMode(true);
let got = '';
process.stdin.on('data', (d) => { got += d.toString('latin1'); });
process.stdout.write('stand-in ready\\r\\n');
process.stdout.write('\\x1b]7501;?\\x1b\\\\\\x1b[c');
setTimeout(() => {
  const answered = got.includes('\\x1b]7501;?:');
  note(JSON.stringify({ answered, reply: answered ? got.slice(got.indexOf('\\x1b]7501;?:')).split('\\x1b\\\\')[0] : null }));
  if (!answered) { process.stdout.write('no 7501 answer\\r\\n'); return; }
  const steps = [
    () => osc('state=working:app=stand-in'),
    () => osc('state=blocked:kind=question:app=stand-in:msg=' + b64('Which branch?')),
    () => osc('state=working:app=stand-in'),
    () => osc('state=done:app=stand-in'),
  ];
  steps.forEach((s, i) => setTimeout(s, i * 2500));
}, 1500);
setInterval(() => {}, 1 << 30);
`;

for (const newInterface of [false, true]) {
  const shell = newInterface ? ' (new interface)' : '';
  test(`a cli's osc 7501 probe is answered and its reports move an agent tars cannot follow otherwise${shell}`, async () => {
    test.setTimeout(360_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-program-status-${newInterface ? 'ni' : 'classic'}-`));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
    const cli = path.join(home, 'bin', 'grok');
    const log = path.join(home, 'stand-in.log');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    // The stand-in takes its log as its first argument, whatever grok's own flags follow.
    fs.writeFileSync(cli, STAND_IN.replace("process.argv[2]", JSON.stringify(log)), { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{ id: 'x-grok', name: 'Grok Agent', character: 'robot', provider: 'grok', status: 'idle', role: 'worker', projectPath: project, skills: [], permissionMode: 'bypass', cliPath: cli, createdAt: '2026-10-22T08:00:00.000Z', lastActivity: '2026-10-22T08:00:00.000Z' }]));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface, grokEnabled: true, cliPaths: { grok: cli } }));
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31506 + (newInterface ? 1 : 0)), DOROTHY_E2E: '1' },
    });
    const values: Record<string, unknown> = { newInterface, home };
    const errors: string[] = [];
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI, undefined, { timeout: 60_000 });
      type Seen = { status: string; waitingReason?: string; programStatus?: { state: string; kind?: string; msg?: string } } | null;
      const read = () => page.evaluate(() => (window as unknown as { electronAPI: { agent: { get(id: string): Promise<unknown> } } }).electronAPI.agent.get('x-grok')) as Promise<Seen>;
      await page.evaluate(() => (window as unknown as { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } }).electronAPI.agent.start({ id: 'x-grok', prompt: 'go' }));

      const seen: string[] = [];
      let blocked: Seen = null;
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline) {
        const a = await read();
        const key = `${a?.status}/${a?.waitingReason ?? ''}/${a?.programStatus?.state ?? '-'}`;
        if (seen.at(-1) !== key) seen.push(key);
        if (a?.programStatus?.state === 'blocked') blocked = a;
        if (a?.programStatus?.state === 'done') break;
        await page.waitForTimeout(150);
      }
      values.statesSeen = seen;
      values.blocked = blocked;
      values.standIn = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : null;
      values.final = await read();
      recordValues(values);

      expect(values.standIn, 'what reached the stand-in').toEqual([{ answered: true, reply: '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth' }]);
      expect(seen).toContain('running//working');
      expect(blocked).toMatchObject({ status: 'waiting', waitingReason: 'permission', programStatus: { state: 'blocked', kind: 'question', msg: 'Which branch?' } });
      expect(values.final).toMatchObject({ status: 'idle', programStatus: { state: 'done' } });
      expect(errors).toEqual([]);
    } finally {
      recordValues(values);
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
