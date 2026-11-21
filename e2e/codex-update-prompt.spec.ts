import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { launchSandboxed, recordValues, removeHome, stepShot } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A task Tars types into a codex agent is never taken by codex's update prompt (2.0.7, the fix of #601's stack for
 * the train).
 *
 * Measured on codex-cli 0.170.0 (21/11, a sandbox): once a start has written version.json in its home and a newer
 * codex exists, codex draws at its start "Update available · 0.170.0 → 0.171.0 ... › 1. Update now (runs `npm install
 * -g @openai/codex`)  2. Skip  3. Skip until next version  enter continue · esc skip". A task on its line waits behind
 * it, and the next one Tars types into its terminal (a bracketed paste, then Enter) answers it: Enter took "Update
 * now", codex installed itself globally with npm, said to restart it and exited 0 (QA's gate of the #601 stack). Both
 * tasks were lost, and the user's machine got a global codex nobody asked for. Every interactive codex line now
 * switches that check off for its own run: `-c check_for_update_on_startup=false` (codex-commands.test.ts 10, 11).
 *
 * codex is e2e/fake-codex.mjs, which draws that prompt from its home's version.json as 0.170 does, and logs whether
 * Enter chose "Update now" (it installs nothing). The sandbox's codex home names 0.171.0 there, as a start of codex
 * would have written it. Asserted, in both shells: the project's orchestrator sends Ula, a codex worker at rest with
 * no terminal, a first message, on her line, then a second, which Tars types into her terminal once codex runs.
 * 1. her line switches the update check off;
 * 2. no update prompt is drawn, and nothing chose "Update now";
 * 3. both messages are turns of her codex, which still runs.
 * Red on 715455c8b (#608's head): the prompt is drawn, the second message's Enter chooses "Update now", codex exits,
 * and neither message is a turn.
 * The artefact: values.json (the launch, the stand-in's log, the tools' answers, Ula's record) and the screenshot.
 */

const LEAD = 'aaaa7777-0000-4000-8000-0000000000a7';
const ULA = 'bbbb7777-0000-4000-8000-0000000000b7';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
type Reply = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
type Entry = Record<string, unknown>;

for (const newInterface of [false, true]) {
  test(`a task typed into codex never answers its update prompt${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(3 * 60_000);
    const home = fs.mkdtempSync('/tmp/dorothy-e2e-codex-update-');
    const project = path.join(home, 'projects', 'demo');
    const dir = path.join(home, '.tars');
    const bin = path.join(home, 'bin');
    const codexHome = path.join(home, '.codex');
    for (const d of [project, dir, bin, codexHome]) fs.mkdirSync(d, { recursive: true });
    execFileSync('git', ['init', '-q', project]);
    // What an earlier start of codex wrote in its home (the form measured on 0.170.0): a newer codex exists.
    fs.writeFileSync(path.join(codexHome, 'version.json'), JSON.stringify({ latest_version: '0.171.0', last_checked_at: new Date().toISOString(), dismissed_version: null }));

    const codexLog = path.join(home, 'codex.jsonl');
    const codex = path.join(bin, 'codex');
    fs.writeFileSync(codex, `#!${process.execPath}\nprocess.env.FAKE_CODEX_LOG = ${JSON.stringify(codexLog)};\nimport(${JSON.stringify(path.resolve('e2e', 'fake-codex.mjs'))});\n`, { mode: 0o755 });
    const entries = () => (fs.existsSync(codexLog) ? fs.readFileSync(codexLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Entry[];
    const launched = (e: Entry) => !!e.launch && !e.refused && Array.isArray(e.argv) && !(e.argv as string[]).includes('--help');

    const agent = (id: string, name: string, role: string, extra: Record<string, unknown> = {}) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role, permissionMode: 'normal', projectPath: project, skills: [],
      createdAt: '2026-11-21T08:00:00.000Z', lastActivity: '2026-11-21T08:00:00.000Z', ...extra,
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      agent(LEAD, 'Lead', 'orchestrator'),
      agent(ULA, 'Ula', 'worker', { provider: 'codex', permissionMode: 'auto', model: 'gpt-6-luna' }),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { codex }, newInterface }, null, 2));

    const port = apiPort(newInterface ? 31532 : 31531);
    const dist = path.resolve('electron', 'dist');
    const values: Record<string, unknown> = { newInterface, home };
    const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
    const servers: ChildProcess[] = [];
    let app: ElectronApplication | undefined;
    try {
      app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' } });
      const appLog = test.info().outputPath('app.log');
      app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
      app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
      const page: Page = await app.firstWindow();
      await expect(page.getByRole('navigation', { name: 'Main menu' })).toHaveCount(newInterface ? 1 : 0, { timeout: 30_000 });
      const ulaNow = () => app!.evaluate((_e, { dist, id }) => {
        const a = process.mainModule!.require(`${dist}/core/agent-manager.js`).agents.get(id);
        return { status: a?.status as string | undefined, error: a?.error as string | undefined, ptyId: a?.ptyId as string | undefined };
      }, { dist, id: ULA });

      // The project's orchestrator, through Tars's MCP server with its own token, as it runs in its terminal.
      const identity = await app.evaluate((_e, { dist, lead }) => {
        const tokens = process.mainModule!.require(`${dist}/core/agent-tokens.js`);
        return { token: tokens.mintRunToken(lead).token as string, instance: tokens.tarsInstanceId() as string };
      }, { dist, lead: LEAD });
      const mcp = spawn(process.execPath, [path.resolve('mcp-orchestrator', 'dist', 'bundle.js')], {
        env: { PATH: process.env.PATH ?? '', HOME: home, CLAUDE_MGR_API_URL: `http://127.0.0.1:${port}`, CLAUDE_MGR_API_TOKEN: identity.token, CLAUDE_AGENT_ID: LEAD, CLAUDE_PROJECT_PATH: project, TARS_INSTANCE_ID: identity.instance },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      servers.push(mcp);
      const replies = new Map<number, (msg: Reply) => void>();
      let buffered = '';
      mcp.stdout.on('data', (chunk) => {
        buffered += chunk;
        for (let at = buffered.indexOf('\n'); at >= 0; at = buffered.indexOf('\n')) {
          const line = buffered.slice(0, at); buffered = buffered.slice(at + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (typeof msg.id === 'number') replies.get(msg.id)?.(msg);
        }
      });
      mcp.on('exit', () => { for (const [, r] of replies) r({ error: 'mcp-orchestrator exited' }); replies.clear(); });
      let nextId = 1;
      const rpc = (method: string, params: unknown) => new Promise<Reply>((resolve) => { const id = nextId++; replies.set(id, resolve); mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const lead = async (tool: string, args: Record<string, unknown>) => {
        const reply = await Promise.race([rpc('tools/call', { name: tool, arguments: args }), sleep(60_000).then(() => ({ error: `${tool} gave no answer in 60 s` }) as Reply)]);
        return { text: reply.result?.content?.map(c => c.text ?? '').join('\n') ?? JSON.stringify(reply.error), isError: !!reply.result?.isError || !!reply.error };
      };

      // Ula's first message starts her codex, on her line; the second is typed into her terminal once codex runs and
      // has drawn itself, as Tars types into a TUI (core/typed-task.ts, TUI_SETTLE_MS).
      const nonce = randomBytes(4).toString('hex');
      const first = await lead('send_message', { id: ULA, message: `ECHO a${nonce}` });
      await expect.poll(() => entries().some(launched), { timeout: 30_000 }).toBe(true);
      const launch = entries().find(launched)!;
      await sleep(3_000);
      const second = await lead('send_message', { id: ULA, message: `ECHO b${nonce}` });
      const turnOf = (tag: string) => entries().some(e => e.turn && String(e.text ?? '').includes(tag));
      const chose = () => entries().filter(e => e.updatePrompt === 'update-now');
      await expect.poll(() => chose().length > 0 || (turnOf(`a${nonce}`) && turnOf(`b${nonce}`)), { timeout: 30_000 }).toBe(true).catch(() => {});
      const alive = (() => { try { process.kill(Number(launch.pid), 0); return true; } catch { return false; } })();
      keep({ launch, first, second, alive, ula: await ulaNow(), entries: entries() });

      expect.soft(launch.argv as string[], "Ula's line leaves codex's update check on").toEqual(expect.arrayContaining(['-c', 'check_for_update_on_startup=false']));
      expect.soft(entries().filter(e => e.updatePrompt === 'shown'), "codex drew its update prompt in Ula's terminal").toHaveLength(0);
      expect.soft(chose(), 'the Enter of a message Tars typed chose "Update now": codex ran npm install -g and exited').toHaveLength(0);
      expect.soft(turnOf(`a${nonce}`), "Ula's first message, on her line, never became a turn").toBe(true);
      expect.soft(turnOf(`b${nonce}`), "Ula's second message, typed into her terminal, never became a turn").toBe(true);
      expect.soft(alive, "Ula's codex is gone").toBe(true);
      await stepShot(page, newInterface ? 'codex-update-prompt-new-interface' : 'codex-update-prompt');
    } finally {
      for (const s of servers) s.kill();
      await app?.close();
      await sleep(500);
      await removeHome(home);
    }
  });
}
