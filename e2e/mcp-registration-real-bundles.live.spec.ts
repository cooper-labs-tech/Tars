import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { parse as parseToml } from 'smol-toml';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * What Tars's start-up registration of its MCP servers writes into each CLI's config, with real bundles.
 *
 * A dev or E2E Tars looks for the bundles under process.resourcesPath, which is Electron's own folder there, finds none
 * and registers nothing, by design: it keeps a dev run off a real home's CLI configs (the #201 incident). So what a
 * packaged Tars writes at start was covered by units only. Here the sandboxed Tars is handed the tree's own built bundles
 * (DOROTHY_E2E_MCP_BUNDLES, read under DOROTHY_E2E only and never by a packaged build, services/mcp-orchestrator.ts),
 * starts, and its registration runs as a packaged Tars's would, into the sandbox's homes.
 *
 * Asserted, once the registration settled:
 * - Claude Code: ~/.claude/mcp.json holds the six servers, each the shared entry on this Tars's API or Tars's own copy
 *   running the tree's bundle; the worker's role file (mcp-worker.json, as an install that started a claude worker has
 *   one) holds the same but X; ~/.claude.json holds no Tars copy of them.
 * - codex: its config.toml, read by codex itself (`codex mcp list --json`, this machine's codex on the sandbox's home):
 *   the six, each running the tree's bundle on one program, with the variables Tars's servers read.
 * - Qwen Code: Tars's own list of its servers (~/.tars/qwen-code/mcp-servers.json): the six, the tree's bundles.
 * - gemini and grok, not installed here: Tars ran neither CLI and wrote each one's own config file in the sandbox
 *   (settings.json, config.toml), the six in it; opencode and Pi: their config files, the six; Amp, whose settings file
 *   does not exist: nothing written.
 * - Nothing named the tree's bundles in the real home's CLI configs that did not before (read for that, never written).
 * On a build whose registration drops a server, the six are not there: red.
 *
 * Live: E2E_LIVE=1 (codex read with this machine's codex when there is one); macOS and Linux. The artefact: values.json
 * (each CLI's servers as written, the program, the real home's check).
 */

const WT = path.resolve('.');
const SIX: Record<string, string> = {
  'claude-mgr-orchestrator': 'mcp-orchestrator', 'tars-memory': 'mcp-memory', 'claude-mgr-kanban': 'mcp-kanban',
  'claude-mgr-vault': 'mcp-vault', 'dorothy-socialdata': 'mcp-socialdata', 'dorothy-x': 'mcp-x',
};
const NAMES = Object.keys(SIX).sort();
const bundleOf = (name: string) => path.join(WT, SIX[name], 'dist', 'bundle.js');

function found(bin: string): string {
  try { return fs.realpathSync(execFileSync('which', [bin]).toString().trim()); } catch { return ''; }
}
const readJson = (file: string): Record<string, unknown> | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const sorted = (o: unknown) => Object.keys((o && typeof o === 'object' ? o : {}) as Record<string, unknown>).sort();

test('the start-up registration writes the six servers, with the tree\'s bundles, into each CLI\'s config in the sandbox', async () => {
  test.skip(process.env.E2E_LIVE !== '1', 'live: E2E_LIVE=1');
  test.skip(process.platform === 'win32', 'macOS and Linux');
  test.setTimeout(4 * 60_000);
  const CODEX = found('codex');
  const home = fs.mkdtempSync('/tmp/tars-mcp-real-');
  for (const dir of ['.tars', '.claude']) fs.mkdirSync(path.join(home, dir), { recursive: true });
  fs.writeFileSync(path.join(home, '.tars', 'agents.json'), JSON.stringify({ version: 3, agents: [] }));
  fs.writeFileSync(path.join(home, '.tars', 'projects.json'), '[]');
  fs.writeFileSync(path.join(home, '.tars', 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(home, '.tars', 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  // As an install that has started a claude worker has it: the registration keeps it in step.
  fs.writeFileSync(path.join(home, '.claude', 'mcp-worker.json'), JSON.stringify({ mcpServers: {} }));

  // The real home's CLI configs: how many times each names a bundle of this tree, before and after (read, never written).
  const real = os.userInfo().homedir;
  const realFiles = ['.claude/mcp.json', '.claude/mcp-worker.json', '.claude.json', '.codex/config.toml', '.tars/qwen-code/mcp-servers.json',
    '.gemini/settings.json', '.grok/config.toml', '.config/opencode/opencode.json', '.pi/agent/mcp.json', '.config/amp/settings.json'].map((f) => path.join(real, f));
  const mark = `${WT}/mcp-`;
  const namings = () => Object.fromEntries(realFiles.map((f) => {
    let n = 0;
    try { n = fs.readFileSync(f, 'utf8').split(mark).length - 1; } catch { /* absent */ }
    return [f.replace(real, '~'), n];
  }));
  const before = namings();
  const values: Record<string, unknown> = { tree: '<tree>', codexForReading: CODEX ? path.basename(CODEX) : null };
  try {
    const app = await launchSandboxed(electron, home, {
      env: {
        NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_E2E: '1', DOROTHY_API_PORT: apiPort(31449),
        DOROTHY_E2E_MCP_BUNDLES: WT, CODEX_HOME: path.join(home, '.codex'),
      },
    });
    try {
      await app.firstWindow();
      const where = await app.evaluate(() => {
        const req = (process as unknown as { mainModule: { require(m: string): unknown } }).mainModule.require;
        return {
          home: (req('os') as typeof import('os')).homedir(), xdg: process.env.XDG_CONFIG_HOME ?? null, codexHome: process.env.CODEX_HOME ?? null,
          piDir: process.env.PI_CODING_AGENT_DIR ?? null, port: process.env.DOROTHY_API_PORT ?? null,
        };
      });
      expect(where.home, 'the app runs on the sandbox\'s home').toBe(home);
      const file = {
        claude: path.join(home, '.claude', 'mcp.json'),
        worker: path.join(home, '.claude', 'mcp-worker.json'),
        claudeJson: path.join(home, '.claude.json'),
        codex: path.join(where.codexHome ?? path.join(home, '.codex'), 'config.toml'),
        qwen: path.join(home, '.tars', 'qwen-code', 'mcp-servers.json'),
        gemini: path.join(home, '.gemini', 'settings.json'),
        grok: path.join(home, '.grok', 'config.toml'),
        opencode: path.join(where.xdg ?? path.join(home, '.config'), 'opencode', 'opencode.json'),
        pi: path.join(where.piDir ?? path.join(home, '.pi', 'agent'), 'mcp.json'),
        amp: path.join(home, '.config', 'amp', 'settings.json'),
      };
      // Settled: the files the registration writes for claude, codex and Qwen Code there, and none changed for 3 s.
      const stamp = () => [file.claude, file.codex, file.qwen, file.gemini, file.grok, file.opencode, file.pi]
        .map((f) => { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return '-'; } }).join('|');
      let last = '';
      let since = Date.now();
      await expect.poll(() => {
        const now = stamp();
        if (now !== last) { last = now; since = Date.now(); }
        return [file.claude, file.codex, file.qwen].every((f) => fs.existsSync(f)) && Date.now() - since >= 3_000;
      }, { timeout: 90_000, intervals: [500], message: 'the start-up registration settled' }).toBe(true);

      const api = `http://127.0.0.1:${where.port}`;
      // Claude Code: the shared entry on this Tars's API, or Tars's own copy of the tree's bundle.
      const claude = (readJson(file.claude)?.mcpServers ?? {}) as Record<string, { type?: string; url?: string; args?: string[]; command?: string }>;
      const worker = (readJson(file.worker)?.mcpServers ?? {}) as typeof claude;
      const kind = (name: string, e: (typeof claude)[string] | undefined) =>
        e?.type === 'http' && e.url === `${api}/api/mcp/${name}` ? 'shared' : e?.args?.at(-1) === bundleOf(name) ? 'copy' : `wrong: ${JSON.stringify(e)}`;
      values.claude = Object.fromEntries(sorted(claude).map((n) => [n, kind(n, claude[n])]));
      values.worker = Object.fromEntries(sorted(worker).map((n) => [n, kind(n, worker[n])]));
      const claudeJsonServers = (readJson(file.claudeJson)?.mcpServers ?? {}) as Record<string, { args?: string[] }>;
      values.claudeJsonTarsCopies = sorted(claudeJsonServers).filter((n) => claudeJsonServers[n]?.args?.at(-1) === bundleOf(n));

      // codex, as codex reads it.
      let codex: Array<{ name: string; transport?: { type?: string; command?: string; args?: string[]; env_vars?: string[] } }>;
      if (CODEX) {
        const out = execFileSync(CODEX, ['mcp', 'list', '--json'], {
          env: { PATH: `${path.dirname(CODEX)}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, CODEX_HOME: path.dirname(file.codex), npm_config_prefix: path.join(home, 'npm') },
          encoding: 'utf8', timeout: 60_000,
        });
        codex = JSON.parse(out);
        values.codexReadBy = 'codex mcp list --json';
      } else {
        const toml = parseToml(fs.readFileSync(file.codex, 'utf8')) as { mcp_servers?: Record<string, { command?: string; args?: string[]; env_vars?: string[] }> };
        codex = Object.entries(toml.mcp_servers ?? {}).map(([name, t]) => ({ name, transport: { type: 'stdio', ...t } }));
        values.codexReadBy = 'smol-toml (no codex on PATH)';
      }
      values.codex = Object.fromEntries(codex.map((s) => [s.name, { type: s.transport?.type, command: s.transport?.command, bundle: s.transport?.args?.at(-1) === bundleOf(s.name) ? 'tree' : s.transport?.args?.at(-1), env: (s.transport?.env_vars ?? []).includes('CLAUDE_MGR_API_TOKEN') }]));
      const programs = new Set(codex.map((s) => s.transport?.command));
      values.program = [...programs];

      // Qwen Code, gemini, grok, opencode, Pi, Amp: their files as Tars wrote them.
      const lastArg = (args: unknown) => (Array.isArray(args) ? args.at(-1) : undefined);
      const qwen = (readJson(file.qwen) ?? {}) as Record<string, { args?: string[] }>;
      const qwenServers = ((qwen as { mcpServers?: unknown }).mcpServers ?? qwen) as Record<string, { args?: string[] }>;
      values.qwen = Object.fromEntries(sorted(qwenServers).map((n) => [n, lastArg(qwenServers[n]?.args) === bundleOf(n) ? 'tree' : lastArg(qwenServers[n]?.args)]));
      const gemini = ((readJson(file.gemini)?.mcpServers ?? null) as Record<string, { args?: string[] }> | null);
      values.gemini = gemini ? Object.fromEntries(sorted(gemini).map((n) => [n, lastArg(gemini[n]?.args) === bundleOf(n) ? 'tree' : lastArg(gemini[n]?.args)])) : 'not written';
      const grokToml = fs.existsSync(file.grok) ? (parseToml(fs.readFileSync(file.grok, 'utf8')) as { mcp_servers?: Record<string, { args?: string[] }> }).mcp_servers ?? {} : null;
      values.grok = grokToml ? Object.fromEntries(sorted(grokToml).map((n) => [n, lastArg(grokToml[n]?.args) === bundleOf(n) ? 'tree' : lastArg(grokToml[n]?.args)])) : 'not written';
      const opencode = ((readJson(file.opencode)?.mcp ?? null) as Record<string, { command?: string[] }> | null);
      values.opencode = opencode ? Object.fromEntries(sorted(opencode).map((n) => [n, lastArg(opencode[n]?.command) === bundleOf(n) ? 'tree' : lastArg(opencode[n]?.command)])) : 'not written';
      const pi = ((readJson(file.pi)?.mcpServers ?? null) as Record<string, { args?: string[] }> | null);
      values.pi = pi ? Object.fromEntries(sorted(pi).map((n) => [n, lastArg(pi[n]?.args) === bundleOf(n) ? 'tree' : lastArg(pi[n]?.args)])) : 'not written';
      values.amp = fs.existsSync(file.amp) ? 'written' : 'not written';
      values.realHome = { before, after: namings() };
      recordValues(values);

      const all = (kindOf: string) => Object.fromEntries(NAMES.map((n) => [n, kindOf]));
      expect(sorted(claude), 'claude: the six in mcp.json').toEqual(NAMES);
      for (const n of NAMES) expect(['shared', 'copy'], `claude: ${n}`).toContain(kind(n, claude[n]));
      expect(sorted(worker), 'claude: the worker\'s role file, the six but X').toEqual(NAMES.filter((n) => n !== 'dorothy-x'));
      expect(values.claudeJsonTarsCopies, 'claude: no Tars copy left in the user scope').toEqual([]);
      expect(values.codex, 'codex, as codex reads it').toEqual(Object.fromEntries(NAMES.map((n) => [n, { type: 'stdio', command: [...programs][0], bundle: 'tree', env: true }])));
      expect(programs.size, 'codex: one program for every server').toBe(1);
      expect(values.qwen, 'Qwen Code: Tars\'s list of its servers').toEqual(all('tree'));
      expect(values.gemini, 'gemini, not installed: its settings.json written in the sandbox').toEqual(all('tree'));
      expect(values.grok, 'grok, not installed: its config.toml written in the sandbox').toEqual(all('tree'));
      expect(values.opencode, 'opencode: its config').toEqual(all('tree'));
      expect(values.pi, 'Pi: its config').toEqual(all('tree'));
      expect(values.amp, 'Amp: no settings file, nothing written').toBe('not written');
      expect((values.realHome as { after: unknown }).after, 'the real home\'s CLI configs name no more of the tree\'s bundles than before').toEqual(before);
    } finally {
      recordValues(values);
      await app.close();
    }
  } finally {
    await removeHome(home);
  }
});
