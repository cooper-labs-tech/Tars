import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { startFakeHermesGateway, type FakeHermesGateway } from '../__tests__/fixtures/fake-hermes-gateway';

/**
 * The Chat keeps one Hermes session, in the real app (JeanBrasse, 21/10: "dans chat, à chaque cron
 * automatique ça ouvre une nouvelle session et ça ne garde pas la même").
 *
 * The sandbox's connection names a Hermes gateway behind the basic sign-in: the stand-in of
 * __tests__/fixtures/fake-hermes-gateway.ts as a 0.22.2 canary answers (JeanBrasse's gateway is one),
 * its terminals reaped after a second instead of thirty minutes. Or, with TARS_HERMES_LIVE_URL,
 * TARS_HERMES_LIVE_PASSWORD and TARS_HERMES_LIVE_DB, a real Hermes of the bench, whose state database
 * is read for the count; its fake model answers "Bench check-in number N".
 *
 * In each shell, with a home of its own, signed in through the window:
 * 1. a question typed in the Chat is answered in the Chat;
 * 2. two automatic check-ins (a fleet change, then watchTick, the watch's own look), a second apart,
 *    are answered and listed in the Chat;
 * 3. Tars quits and starts again: a question is answered;
 * 4. (stand-in) the gateway restarts, then the socket drops as a sleep drops it: a question each,
 *    answered;
 * and the gateway holds one session of this Tars from the first answer to the last: no terminal ever
 * opened on it, no cron job made or run.
 *
 * The artefact: values.json (the sessions after each step, the answers, what the gateway saw) and a
 * picture of the Chat at the end, for each shell.
 */

const LIVE = process.env.TARS_HERMES_LIVE_URL;
const LIVE_DB = process.env.TARS_HERMES_LIVE_DB;
const LIVE_PASSWORD = process.env.TARS_HERMES_LIVE_PASSWORD ?? '';

type Api = { electronAPI: { hermes: { signIn(p: { connection: Record<string, unknown>; username: string; password: string }): Promise<{ success: boolean; error?: string }> } } };

interface Counted { total: number; tui: number; cron: number; ids: string[] }

/** The sessions the gateway holds that this run made. */
function counter(gateway: FakeHermesGateway | null, since: number): () => Counted {
  if (gateway) {
    return () => {
      const rows = gateway.rows();
      return { total: rows.length, tui: rows.filter(r => r.source === 'tui').length, cron: rows.filter(r => r.source === 'cron').length, ids: rows.map(r => r.id) };
    };
  }
  return () => {
    const out = execFileSync('sqlite3', ['-readonly', '-separator', '|', LIVE_DB!, `select id, source from sessions where started_at >= ${since / 1000} order by started_at`], { encoding: 'utf8' });
    const rows = out.split('\n').filter(Boolean).map(l => { const [id, source] = l.split('|'); return { id, source }; });
    return { total: rows.length, tui: rows.filter(r => r.source === 'tui').length, cron: rows.filter(r => r.source === 'cron').length, ids: rows.map(r => r.id) };
  };
}

for (const newInterface of [false, true]) {
  test(`the Chat keeps one Hermes session across check-ins, restarts and wakes (${newInterface ? 'new' : 'classic'} interface)`, async () => {
    test.setTimeout(420_000);
    const since = Date.now();
    const gateway = LIVE ? null : await startFakeHermesGateway({
      flavour: '0.22',
      ptyTtlMs: 1_000,
      reply: (_prompt, n) => JSON.stringify({ say: `Answer number ${n} from Hermes.`, action: null }),
    });
    const url = LIVE ?? gateway!.url;
    const sessions = counter(gateway, since);
    const answered = (text: string) => LIVE ? /^Bench check-in number \d+: nothing to report\.$/.test(text) : /^Answer number \d+ from Hermes\.$/.test(text);

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-hermes-one-session-'));
    const dir = path.join(home, '.tars');
    const project = path.join(home, 'projects', 'alpha');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(home, '.tars-private'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
      id: 'w1', name: 'Wren', character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
      permissionMode: 'normal', projectPath: project, skills: [], output: [], lastActivity: new Date().toISOString(),
    }]));
    const connection = { mode: 'remote', url, authMode: 'oauth' };
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify(connection));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));

    const port = apiPort(newInterface ? 31307 : 31306);
    const launch = () => launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    const errors: string[] = [];
    const steps: Array<Record<string, unknown>> = [];
    const answers: string[] = [];
    let app: ElectronApplication | null = null;

    const openChat = async (): Promise<Page> => {
      const page = await app!.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.goto(`${DEV_URL}/chat`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as Api).electronAPI?.hermes?.signIn, null, { timeout: 60_000 });
      return page;
    };
    const ready = (page: Page) => expect(page.locator('[data-gateway-state="ok"]')).toBeVisible({ timeout: 60_000 });
    const step = (name: string, extra: Record<string, unknown> = {}) => {
      const counted = sessions();
      steps.push({ step: name, ...counted, ...extra });
      return counted;
    };
    /** A question typed in the Chat: the answer is the newest of Hermes's lines once it lands. */
    const askInWindow = async (page: Page, words: string) => {
      const field = page.getByPlaceholder('Ask about any project, or tell Hermes what to do.');
      await field.fill(words);
      await field.press('Enter');
      await expect(page.getByText(words, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
      const reply = await page.evaluate(async (asked) => {
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          const { messages } = await (window as unknown as { electronAPI: { overseer: { history(): Promise<{ messages: Array<{ role: string; text: string }> }> } } }).electronAPI.overseer.history();
          const at = messages.map(m => m.text).lastIndexOf(asked);
          const after = at >= 0 ? messages.slice(at + 1).find(m => m.role === 'overseer') : undefined;
          if (after) return after.text;
          await new Promise(r => setTimeout(r, 250));
        }
        return null;
      }, words);
      expect(reply, `the answer to "${words}"`).not.toBeNull();
      await expect(page.getByText(reply!, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
      answers.push(reply!);
      return reply!;
    };
    /** The watch's own look after Wren moves, as the timer runs it: watchTick, then its briefing. */
    const checkIn = async (status: string) => {
      const said = await app!.evaluate(async (_electron, [dist, s]) => {
        const req = process.mainModule!.require;
        const fleet = req(`${dist}/core/agent-manager.js`).agents as Map<string, { status: string }>;
        const overseer = req(`${dist}/services/overseer.js`) as { watchTick(): Promise<{ text: string } | null>; getLastWatchFailure(): unknown };
        fleet.get('w1')!.status = s;
        const message = await overseer.watchTick();
        return { text: message?.text ?? null, failure: overseer.getLastWatchFailure() };
      }, [path.resolve('electron', 'dist'), status] as const);
      return said;
    };

    try {
      app = await launch();
      let page = await openChat();
      const signed = await page.evaluate(([c, pw]) => (window as unknown as Api).electronAPI.hermes.signIn({ connection: c, username: 'bench', password: pw }), [connection, LIVE ? LIVE_PASSWORD : 'pw'] as const);
      expect(signed, JSON.stringify(signed)).toMatchObject({ success: true });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await ready(page);
      step('signed in');

      // 1. A question typed in the Chat.
      expect(answered(await askInWindow(page, 'What is everyone doing?'))).toBe(true);
      const first = step('first question');
      expect(first.total, 'the first answer made one session').toBe(1);

      // 2. Two automatic check-ins, a second apart: a terminal is reaped meanwhile.
      expect(await checkIn('running')).toMatchObject({ text: null }); // the first look only records the fleet
      for (const status of ['error', 'waiting']) {
        await new Promise(r => setTimeout(r, 1_500));
        const said = await checkIn(status);
        expect(said.text, JSON.stringify(said)).not.toBeNull();
        expect(answered(said.text!), said.text!).toBe(true);
        answers.push(said.text!);
        expect(step(`check-in, Wren ${status}`).total, `after the check-in on ${status}`).toBe(1);
      }
      await page.reload({ waitUntil: 'domcontentloaded' });
      await ready(page);
      for (const text of answers) await expect(page.getByText(text, { exact: true }).first()).toBeVisible({ timeout: 30_000 });

      // 3. Tars quits and starts again.
      await app.close();
      app = await launch();
      page = await openChat();
      await ready(page);
      expect(answered(await askInWindow(page, 'Back again: anything new?'))).toBe(true);
      expect(step('after a restart of Tars').total, 'after a restart of Tars').toBe(1);

      if (gateway) {
        // 4. The gateway restarts; then the socket drops, as a sleep drops it.
        gateway.restart();
        expect(answered(await askInWindow(page, 'After the gateway restarted?'))).toBe(true);
        expect(step('after a gateway restart').total, 'after a gateway restart').toBe(1);
        gateway.dropSockets();
        expect(answered(await askInWindow(page, 'After the wake?'))).toBe(true);
        expect(step('after a dropped socket').total, 'after a dropped socket').toBe(1);
      }

      const end = sessions();
      expect(end, JSON.stringify(end)).toMatchObject({ total: 1, tui: 0, cron: 0 });
      if (gateway) {
        expect(gateway.events.filter(e => e.kind === 'pty'), 'no terminal opened on the gateway').toEqual([]);
        expect(gateway.events.filter(e => e.kind === 'cron'), 'no cron job made or run').toEqual([]);
      }
      expect(new Set(answers).size, 'every answer its own').toBe(answers.length);
      await stepShot(page, `chat-${newInterface ? 'new' : 'classic'}-interface`);
      expect(errors).toEqual([]);
    } finally {
      recordValues({
        [newInterface ? 'newInterface' : 'classicInterface']: {
          gateway: LIVE ? `live ${LIVE}` : 'stand-in, 0.22 canary',
          steps,
          answers,
          errors,
          seen: gateway ? gateway.events.map(e => ({ kind: e.kind, ...(e.detail?.method ? { method: e.detail.method } : {}), ...(e.detail?.path ? { path: e.detail.path } : {}) })) : undefined,
        },
      });
      await app?.close().catch(() => {});
      await gateway?.close();
      await removeHome(home);
    }
  });
}
