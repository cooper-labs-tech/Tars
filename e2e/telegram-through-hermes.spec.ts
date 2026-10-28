import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';
import { startFakeRelay, type FakeRelay } from '../__tests__/fixtures/fake-tars-relay';
import { BOT_TOKEN, OWNER_ID, startFakeTelegram } from '../__tests__/fixtures/fake-telegram';

/**
 * Tars's own Telegram bot is gone, and Telegram goes through Hermes only (2.0.5; JeanBrasse's decision of 2026-10-01,
 * "le bot Telegram de Tars est SUPPRIMÉ (pas de secours), Hermes seule voix sur Telegram"; the DB brief
 * remove-telegram-bot-2810.md), in the real app.
 *
 * The sandbox holds what the maintainer's Mac held on 28/10: the bot on, his chat authorized, its token and its /auth
 * token in ~/.tars-private/settings-secrets.json, the relay off. Telegram is a stand-in of its Bot API on the loopback
 * (DOROTHY_TELEGRAM_API_URL, which 2.0.4's bot reads under DOROTHY_E2E), counting every call; Hermes a stand-in of the
 * gateway with the tars-relay plugin's routes. One orchestrator, "Lead", with no CLI running.
 *
 * Asserted, in order:
 * 1. Nothing asks Telegram's Bot API anything for 15 s after the window is up (no getMe, no getUpdates);
 * 2. app-settings.json holds none of the bot's fields, and says it was retired with a token to revoke; the private
 *    file holds neither token, and the other secret it held stays;
 * 3. send_telegram from the orchestrator (POST /api/telegram/send, its own token), the relay off: 409, the reason
 *    names Settings, Hermes; nothing reaches either stand-in;
 * 4. the relay turned on: the same send goes through the relay's stand-in under the project, and Telegram's stand-in
 *    is still never asked.
 * Run once with the classic interface and once with the new one. The artefact: values.json (the files, each answer,
 * what each stand-in received), and a screenshot of the window at each step.
 */

for (const newInterface of [false, true]) {
  test(`with the old bot's settings, nothing polls Telegram, and send_telegram goes through Hermes or says how (${newInterface ? 'new' : 'classic'} interface)`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-telegram-hermes-'));
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    const priv = path.join(home, '.tars-private');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(priv, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([{
      id: 'o1', name: 'Lead', character: 'robot', provider: 'claude', status: 'idle', role: 'orchestrator', permissionMode: 'normal',
      projectPath: project, skills: [], createdAt: '2026-10-28T08:00:00.000Z', lastActivity: '2026-10-28T08:00:00.000Z',
    }], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    const settingsFile = path.join(dir, 'app-settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({
      autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface, hermesRelayEnabled: false,
      telegramEnabled: true, telegramChatId: String(OWNER_ID), telegramAuthorizedChatIds: [String(OWNER_ID)], telegramRequireMention: false,
    }, null, 2));
    const secretsFile = path.join(priv, 'settings-secrets.json');
    fs.writeFileSync(secretsFile, JSON.stringify({ telegramBotToken: BOT_TOKEN, telegramAuthToken: 'e2e-auth-token', slackBotToken: 'xoxb-e2e' }, null, 2), { mode: 0o600 });

    const telegram = await startFakeTelegram();
    const hermes: FakeRelay = await startFakeRelay('e2e-hermes-token');
    const port = apiPort(31512);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { home, newInterface };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

    const app: ElectronApplication = await launchSandboxed(electron, home, {
      env: {
        NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1', TARS_CHAT_RAM_GB: '20',
        DOROTHY_TELEGRAM_API_URL: telegram.url,
      },
    });
    try {
      const page: Page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
      await app.evaluate((_e, { dist, port, token }) => {
        const req = process.mainModule!.require;
        req(`${dist}/services/hermes-config.js`).writeHermesConnection({ mode: 'local', localPort: port, authMode: 'token', token });
      }, { dist, port: hermes.port, token: hermes.token });
      const token = await app.evaluate((_e, { dist }) => {
        const req = process.mainModule!.require;
        return req(`${dist}/core/agent-tokens.js`).mintAgentToken('o1') as string;
      }, { dist });
      const send = async (message: string) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/telegram/send`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ message, chat_id: String(OWNER_ID) }),
        });
        return { status: res.status, body: await res.json() as Record<string, unknown> };
      };

      // 1. Nothing asks Telegram anything.
      await page.waitForTimeout(15_000);
      keep({ telegramCallsAtStart: [...telegram.calls] });
      await stepShot(page, '1-started');
      expect(telegram.calls).toEqual([]);

      // 2. The files.
      const settings = read(settingsFile);
      const secrets = read(secretsFile);
      keep({ settings, secretKeys: Object.keys(secrets) });
      for (const f of ['telegramEnabled', 'telegramBotToken', 'telegramChatId', 'telegramAuthToken', 'telegramAuthorizedChatIds', 'telegramRequireMention']) {
        expect(settings, f).not.toHaveProperty(f);
      }
      expect(settings.telegramBotRetired).toMatchObject({ hadToken: true });
      expect(secrets).toEqual({ slackBotToken: 'xoxb-e2e' });

      // 3. send_telegram, the relay off.
      const off = await send('OFF>> a report');
      keep({ off });
      expect(off.status).toBe(409);
      expect(off.body).toMatchObject({ error: 'telegram_through_hermes' });
      expect(String(off.body.reason)).toContain('Settings, Hermes');
      expect(telegram.sent).toEqual([]);
      expect(hermes.sends).toEqual([]);

      // 4. The relay on.
      const saved = await page.evaluate(() => (window as unknown as { electronAPI: { appSettings: { save(s: unknown): Promise<unknown> } } }).electronAPI.appSettings.save({ hermesRelayEnabled: true }));
      keep({ saved });
      const relayStatus = () => page.evaluate(() => (window as unknown as { electronAPI: { hermes: { relayStatus(): Promise<{ state: string }> } } }).electronAPI.hermes.relayStatus());
      await expect.poll(async () => (await relayStatus()).state, { timeout: 30_000 }).toBe('ready');
      const on = await send('ON>> a report through Hermes');
      keep({ on, hermesSends: hermes.sends, telegramCalls: [...telegram.calls], telegramSent: telegram.sent });
      await stepShot(page, '4-relay-on');
      expect(on.status).toBeLessThan(300);
      expect(hermes.sends).toEqual([expect.objectContaining({ kind: 'report', project: 'demo', text: expect.stringContaining('ON>> a report through Hermes') })]);
      expect(telegram.calls).toEqual([]);
    } finally {
      await app.close();
      await telegram.close();
      await hermes.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
