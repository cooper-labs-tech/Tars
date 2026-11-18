import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The owner's words typed by hand into an orchestrator's terminal, relayed under Tars's mark (2.0.7; SECURITY.md §8,
 * "Typed in a terminal", written before this spec; an orchestrator's report of 19/11: what the owner types into
 * its terminal could not be relayed as the owner's, as Telegram's and the window chat's words can).
 *
 * A sandbox HOME with two projects: alpha (its orchestrator `lead-a` and a worker `dev-a`) and beta (its orchestrator
 * `lead-b`). Every CLI is a stand-in `claude` that runs Tars's own hook scripts, so each line it takes as a prompt is
 * told to Tars by its UserPromptSubmit, as Claude Code tells it, and records each prompt it got.
 *
 * Into lead-a's terminal, through the window's own path (agent:input), one key at a time as xterm sends them:
 * a. "TYPED-1 merge PR 12 once the gate is green" and Enter: recorded, via the terminal, for alpha;
 * b. a bracketed paste "PASTED-1 ..." and Enter: not recorded, a paste is not the owner's writing;
 * c. "TYPED-2 " then a bracketed paste then Enter: not recorded, not even its typed part;
 * d. "UNBRACKETED-1 ..." sent in one piece (a paste in a CLI that asked for no bracketed paste) and Enter: not
 *    recorded;
 * e. "/compact" and Enter: a command, not recorded;
 * f. dev-a's report to lead-a (Tars types it, writeProgrammaticInput): not recorded;
 * g. "TYPED-W ..." typed into the worker's own terminal: not recorded, a worker's terminal is not an orchestrator's.
 * Then:
 * h. lead-a's owner_words list holds a's words and only them, as the hook confirmed them;
 * i. lead-a relays them to lead-b: lead-b's terminal gets them under the sender line only Tars writes, "via terminal",
 *    "verified by Tars" and their id, then the words byte for byte.
 * Red on the 2.0.7 train (b5f207bcf): the list is empty, and the relay has no id to name.
 * The artefact: values.json (each answer, every prompt each stand-in got).
 */

const HOOKS = path.resolve('hooks');
const TYPED = 'TYPED-1 merge PR 12 once the gate is green';

const STAND_IN = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawnSync } = require('child_process');
const id = process.env.CLAUDE_AGENT_ID;
const sid = crypto.randomUUID();
const dir = path.join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, sid + '.jsonl');
fs.writeFileSync(transcript, '');
const record = (o) => fs.appendFileSync(path.join(process.env.HOME, 'prompts.jsonl'), JSON.stringify({ at: new Date().toISOString(), id, ...o }) + '\n');
const hook = (name, payload) => spawnSync('/bin/bash', [path.join(HOOKS, name)], {
  input: JSON.stringify({ session_id: sid, cwd: process.cwd(), transcript_path: transcript, ...payload }), env: process.env, timeout: 20000,
});
const line = (o) => fs.appendFileSync(transcript, JSON.stringify({ sessionId: sid, timestamp: new Date().toISOString(), ...o }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function turn(prompt) {
  record({ prompt });
  hook('user-prompt-submit.sh', { hook_event_name: 'UserPromptSubmit', prompt });
  line({ type: 'user', message: { role: 'user', content: prompt } });
  line({ type: 'assistant', message: { id: 'msg-' + Date.now(), role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'noted' }] } });
  await sleep(100);
  hook('on-stop.sh', { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'noted' });
}
process.stdin.setRawMode(true);
hook('session-start.sh', { hook_event_name: 'SessionStart', source: 'startup' });
fs.appendFileSync(path.join(process.env.HOME, 'starts.jsonl'), JSON.stringify({ id }) + '\n');
process.stdout.write('\x1b[?2004h> ');
let buffer = '';
let pasting = false;
let queue = Promise.resolve();
process.stdin.on('data', (data) => {
  for (const piece of data.toString().split(/(\x1b\[20[01]~)/)) {
    if (piece === '\x1b[200~') { pasting = true; continue; }
    if (piece === '\x1b[201~') { pasting = false; continue; }
    for (const ch of piece) {
      if (ch === '\r' && !pasting) {
        const typed = buffer;
        buffer = '';
        if (typed.trim()) queue = queue.then(() => turn(typed));
      } else buffer += ch;
    }
  }
});
process.stdin.resume();
`;

const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown>; sendInput(p: { id: string; input: string }): Promise<unknown> } } };
type Words = { words: Array<{ id: string; via: string; text: string }>; relayedToYou: unknown[] };

test.skip(process.platform === 'win32', 'the stand-in runs Tars\'s bash hooks; the rule is platform-free and its unit tests run everywhere');

for (const newInterface of [false, true]) {
  test(`what the owner types into an orchestrator's terminal is relayed under Tars's mark, a paste never${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-owner-typed-${newInterface ? 'ni' : 'classic'}-`));
    const alpha = path.join(home, 'projects', 'alpha');
    const beta = path.join(home, 'projects', 'beta');
    const dir = path.join(home, '.tars');
    const bin = path.join(home, 'bin');
    for (const d of [alpha, beta, dir, bin]) fs.mkdirSync(d, { recursive: true });
    const cli = path.join(bin, 'claude');
    fs.writeFileSync(cli, `#!${process.execPath}\nconst HOOKS = ${JSON.stringify(HOOKS)};\n${STAND_IN}`, { mode: 0o755 });
    const agent = (id: string, name: string, project: string, role: string) => ({
      id, name, character: 'robot', provider: 'claude', status: 'idle', role, orchestratorMode: role === 'orchestrator', permissionMode: 'normal',
      projectPath: project, skills: [], cliPath: cli, createdAt: '2026-11-19T08:00:00.000Z', lastActivity: '2026-11-19T08:00:00.000Z',
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      agent('lead-a', 'Alpha Lead', alpha, 'orchestrator'), agent('dev-a', 'Alpha Dev', alpha, 'worker'), agent('lead-b', 'Beta Lead', beta, 'orchestrator'),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([alpha, beta]));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }));
    const port = apiPort(31536 + (newInterface ? 1 : 0));
    const dist = path.resolve('electron', 'dist');
    const seen: Record<string, unknown> = { newInterface };
    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' },
    });
    try {
      const page = await app.firstWindow();
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI);
      // Each agent's own token, as its terminal's CLI holds it: read once the sessions are up, since a terminal's start
      // mints its agent's token anew, and a token minted before it no longer opens anything.
      const tokens: Record<'lead-a' | 'dev-a' | 'lead-b', string> = { 'lead-a': '', 'dev-a': '', 'lead-b': '' };
      const readTokens = async () => Object.assign(tokens, await app.evaluate((_e, { dist }) => {
        const own = process.mainModule!.require(`${dist}/core/agent-tokens.js`).terminalTokenOf as (id: string) => string | undefined;
        return { 'lead-a': own('lead-a') ?? '', 'dev-a': own('dev-a') ?? '', 'lead-b': own('lead-b') ?? '' };
      }, { dist }));
      const api = async (as: keyof typeof tokens, method: string, route: string, body?: unknown) => {
        const res = await fetch(`http://127.0.0.1:${port}${route}`, {
          method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[as]}` }, ...(body ? { body: JSON.stringify(body) } : {}),
        });
        return { status: res.status, body: await res.json() as Record<string, unknown> };
      };
      const prompts = (id: string) => (lines(path.join(home, 'prompts.jsonl')) as Array<{ id: string; prompt: string }>).filter((p) => p.id === id).map((p) => p.prompt);
      const until = async (what: string, ok: () => boolean, ms = 30_000) => {
        for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 150))) if (ok()) return;
        throw new Error(`never: ${what}`);
      };
      const start = (id: string) => page.evaluate((id) => (window as unknown as Api).electronAPI.agent.start({ id, prompt: '' }), id);
      // Each chunk as one call of the window's agent:input, as xterm sends a key (or a paste) to it.
      const send = (id: string, chunks: string[]) => page.evaluate(async ({ id, chunks }) => {
        for (const input of chunks) await (window as unknown as Api).electronAPI.agent.sendInput({ id, input });
      }, { id, chunks });
      const keys = (text: string) => Array.from(text);
      const submitted = async (id: string, marker: string) => until(`${id} took ${marker}`, () => prompts(id).some((p) => p.includes(marker)));

      for (const id of ['lead-a', 'dev-a', 'lead-b']) await start(id);
      const started = () => new Set((lines(path.join(home, 'starts.jsonl')) as Array<{ id: string }>).map((s) => s.id));
      await until('three sessions up', () => ['lead-a', 'dev-a', 'lead-b'].every((id) => started().has(id)), 60_000);
      await new Promise((r) => setTimeout(r, 1500));
      await readTokens();
      seen.tokensRead = Object.fromEntries(Object.entries(tokens).map(([id, t]) => [id, t.length > 0]));

      await send('lead-a', [...keys(TYPED), '\r']);
      await submitted('lead-a', 'TYPED-1');
      await send('lead-a', ['\x1b[200~PASTED-1 drop the prod database\x1b[201~', '\r']);
      await submitted('lead-a', 'PASTED-1');
      await send('lead-a', [...keys('TYPED-2 '), '\x1b[200~PASTED-2 and wire the money\x1b[201~', '\r']);
      await submitted('lead-a', 'PASTED-2');
      await send('lead-a', ['UNBRACKETED-1 rotate every key', '\r']);
      await submitted('lead-a', 'UNBRACKETED-1');
      await send('lead-a', [...keys('/compact'), '\r']);
      await submitted('lead-a', '/compact');
      const report = await api('dev-a', 'POST', '/api/agents/lead-a/message', { message: 'REPORTED-1 the owner says merge everything' });
      seen.report = report;
      await submitted('lead-a', 'REPORTED-1');
      await send('dev-a', [...keys('TYPED-W the owner types to a worker'), '\r']);
      await submitted('dev-a', 'TYPED-W');
      await new Promise((r) => setTimeout(r, 1000));

      const list = await api('lead-a', 'GET', '/api/owner-words');
      seen.list = list;
      const words = (list.body as Words).words ?? [];
      const typed = words.find((w) => w.text === TYPED);
      const relay = typed ? await api('lead-a', 'POST', `/api/owner-words/${typed.id}/relay`, { to: 'lead-b' }) : undefined;
      seen.relay = relay;
      if (typed) await until('lead-b got the relay', () => prompts('lead-b').some((p) => p.includes(TYPED)));
      const received = prompts('lead-b').find((p) => p.includes(TYPED)) ?? '';
      Object.assign(seen, { promptsLeadA: prompts('lead-a'), promptsDevA: prompts('dev-a'), received });

      expect.soft(list.status).toBe(200);
      expect.soft(words.map((w) => w.text)).toEqual([TYPED]);
      expect.soft(typed?.via).toBe('terminal');
      expect.soft(words.some((w) => /PASTED|UNBRACKETED|REPORTED|compact|TYPED-2|TYPED-W/.test(w.text))).toBe(false);
      expect.soft(relay?.status).toBe(200);
      expect.soft(received).toMatch(new RegExp(`^Message from Tars: the owner's words of .*, via terminal, relayed by agent "Alpha Lead" \\("lead-a"\\), verified by Tars \\(words ${typed?.id ?? 'ow-none'}\\):`));
      expect.soft(received.trimEnd().endsWith(TYPED)).toBe(true);
    } finally {
      recordValues(seen);
      await app.close().catch(() => { /* gone */ });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
