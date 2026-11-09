import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';
import { launchSandboxed, listenForErrors, markWhatsNewSeen, recordValues, removeHome, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * An orchestrator only orchestrates, out of the box (2.0.7, the owner's words of 10/11: "les orchestrators
 * orchestrent, ils ne font pas dev, de recherches, de qa, d'audit, ils orchestrent", after a fresh install whose
 * orchestrator delegated nothing until he wrote its role into its vault by hand).
 *
 * A fresh home: two projects, each with nothing but its orchestrator, as a new user creates them. No vault, no
 * CLAUDE.md, no memory. One orchestrator runs on claude, the other on codex, each a stand-in that records what Tars
 * hands it. The claude one fetches its identity as session-start.sh does, with its own token.
 *
 * Asserted, with the classic shell and with the new interface:
 * 1. claude: the role file Tars appends to its system prompt says it never does the work itself, diagnosing included,
 *    and no longer that reading the code is its own work;
 * 2. claude: its session is denied the tools of the work, editing (Edit, Write, NotebookEdit), its own subagents
 *    (Task), searching code (Grep, Glob) and the web (WebFetch, WebSearch), and keeps Read and Bash;
 * 3. claude: its identity says the same, and, its project having no agent yet, to create the ones the work needs;
 * 4. codex, which has no system prompt file and no tool to deny: its first prompt says the same as 3;
 * 5. ~/.tars/CLAUDE.md, every agent's instructions as the app publishes them and every claude session loads them,
 *    tells a worker to fix a bug report itself, and an orchestrator to hand it to an agent (the Audit's M1 on #579).
 * Red on main 58f2863b4: the role file says reading the code is its own work, Grep, Glob, WebFetch and WebSearch are
 * allowed, neither identity says it, and ~/.tars/CLAUDE.md tells every agent to fix a bug report itself.
 * The artefact: values.json (the role file's rule, the denied tools, both identities).
 */

const RULE = 'You never do the work yourself';
const CREATE = 'create_agent';
type Api = { electronAPI: { agent: { start(p: { id: string; prompt: string }): Promise<unknown> } } };

for (const newInterface of [false, true]) {
  test(`a fresh project's orchestrator is told and made to only orchestrate, on claude and on codex${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(180_000);
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `dorothy-e2e-orch-only-${newInterface ? 'ni' : 'classic'}-`)));
    const shop = path.join(home, 'projects', 'shop');
    const garden = path.join(home, 'projects', 'garden');
    const dir = path.join(home, '.tars');
    const bin = path.join(home, 'bin');
    for (const d of [shop, garden, dir, bin, path.join(home, '.claude'), path.join(home, '.codex')]) fs.mkdirSync(d, { recursive: true });

    // claude: its argv, the file its --append-system-prompt-file names, and its identity, fetched as the hook does.
    const seenClaude = path.join(home, 'claude-seen.json');
    const claude = writeNodeCli(path.join(home, 'stand-in-claude.cjs'), [
      "const fs = require('fs');",
      "if (process.argv.includes('--version')) { console.log('2.1.321 (Claude Code)'); process.exit(0); }",
      'const argv = process.argv.slice(2);',
      "const at = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };",
      "const denied = []; const d = argv.indexOf('--disallowed-tools');",
      "if (d >= 0) for (let i = d + 1; i < argv.length && !argv[i].startsWith('-'); i++) denied.push(argv[i]);",
      "const file = at('--append-system-prompt-file');",
      "let role = null; try { role = fs.readFileSync(file, 'utf8'); } catch {}",
      "fetch(process.env.CLAUDE_MGR_API_URL + '/api/agents/' + process.env.CLAUDE_AGENT_ID + '/bootstrap', {",
      "  headers: { Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN },",
      '}).then(r => r.json()).catch(() => ({})).then(b => {',
      `  fs.writeFileSync(${JSON.stringify(seenClaude)}, JSON.stringify({ argv, denied, role, identity: b.context ?? null }));`,
      '});',
      "process.stdout.write('stand-in ready\\n');",
      'process.stdin.resume();',
      '',
    ].join('\n'));
    // codex: the recording fake, whose log holds each launch's argv, its first prompt among them.
    const codexLog = path.join(home, 'codex.jsonl');
    const codex = path.join(bin, 'codex');
    fs.writeFileSync(codex, `#!${process.execPath}\nprocess.env.FAKE_CODEX_LOG = ${JSON.stringify(codexLog)};\nimport(${JSON.stringify(path.resolve('e2e', 'fake-codex.mjs'))});\n`, { mode: 0o755 });

    const lead = (id: string, name: string, provider: string, projectPath: string, extra: Record<string, unknown>) => ({
      id, name, character: 'robot', provider, status: 'idle', role: 'orchestrator', orchestratorMode: true, permissionMode: 'auto',
      projectPath, skills: [], createdAt: '2026-11-10T08:00:00.000Z', lastActivity: '2026-11-10T08:00:00.000Z', ...extra,
    });
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
      lead('shop-lead', 'Shop Lead', 'claude', shop, { cliPath: claude }),
      lead('garden-lead', 'Garden Lead', 'codex', garden, { model: 'gpt-6-luna' }),
    ], null, 2));
    fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([shop, garden]));
    fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { codex }, newInterface }));

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31591 + (newInterface ? 1 : 0)), DOROTHY_E2E: '1' },
    });
    const values: Record<string, unknown> = { newInterface, home };
    const errors: string[] = [];
    try {
      const page = await app.firstWindow();
      listenForErrors(page, errors);
      await markWhatsNewSeen(page, WHATS_NEW_STORAGE_KEY, String(LATEST_RELEASE.id));
      await page.goto(`${DEV_URL}/agents`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!(window as unknown as { electronAPI?: unknown }).electronAPI, undefined, { timeout: 60_000 });
      for (const id of ['shop-lead', 'garden-lead']) {
        await page.evaluate((agentId) => (window as unknown as Api).electronAPI.agent.start({ id: agentId, prompt: 'Users say the cart total is wrong. Why?' }), id);
      }

      await expect.poll(() => fs.existsSync(seenClaude), { timeout: 60_000, message: 'the claude orchestrator started' }).toBe(true);
      const seen = JSON.parse(fs.readFileSync(seenClaude, 'utf8')) as { denied: string[]; role: string | null; identity: string | null };
      const launches = () => (fs.existsSync(codexLog) ? fs.readFileSync(codexLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [])
        .filter((e: Record<string, unknown>) => e.launch && !e.refused && Array.isArray(e.argv) && !(e.argv as string[]).includes('--help')) as Array<{ argv: string[] }>;
      await expect.poll(() => launches().length, { timeout: 60_000, message: 'the codex orchestrator started' }).toBeGreaterThan(0);
      const codexPrompt = launches()[0].argv.find(a => a.includes('Users say the cart total is wrong')) ?? '';
      const ruleOf = (text: string | null) => text?.split('\n').find(l => l.includes(RULE)) ?? null;
      values.roleRule = ruleOf(seen.role);
      values.denied = seen.denied;
      values.claudeIdentity = seen.identity;
      values.codexPrompt = codexPrompt;
      recordValues(values);

      // 1.
      expect(seen.role).toContain(RULE);
      expect(seen.role).not.toContain('reading the code to check a fact');
      // 2.
      expect([...seen.denied].sort()).toEqual(['Edit', 'Glob', 'Grep', 'LSP', 'NotebookEdit', 'Task', 'WebFetch', 'WebSearch', 'Workflow', 'Write']);
      // 3.
      expect(seen.identity).toContain(RULE);
      expect(seen.identity).toContain(CREATE);
      // 4.
      expect(codexPrompt).toContain(RULE);
      expect(codexPrompt).toContain(CREATE);
      // 5.
      const everyAgent = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
      values.bugReportLine = everyAgent.split('\n').find(l => l.includes('bug report')) ?? null;
      recordValues(values);
      expect(everyAgent).not.toContain('When given a bug report, just fix it');
      expect(everyAgent).toContain('An orchestrator never does: it hands the bug report to one of its agents');
      expect(errors).toEqual([]);
    } finally {
      recordValues(values);
      await app.close().catch(() => undefined);
      await removeHome(home);
    }
  });
}
