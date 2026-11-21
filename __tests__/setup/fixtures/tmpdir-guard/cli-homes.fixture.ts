import '../../home-guard';
import { expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodexProvider } from '../../../../electron/providers/codex-provider';

// Run by env-isolation.test.ts (case 3) with decoy CLI homes, CLI configs and git variables exported, as a shell that
// sets CODEX_HOME and the others has them. The write comes first, so a decoy codex home is written when the setup lets
// CODEX_HOME through, and the case that started this run sees it.
const NAMES = [
  'CODEX_HOME', 'KIMI_CODE_HOME', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'ZDOTDIR',
  'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'KILO_CONFIG', 'KILO_CONFIG_DIR', 'KILO_CONFIG_CONTENT',
  'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_GLOBAL',
];

it('starts without a CLI home of the runner\'s, and codex writes its config under the throwaway HOME', async () => {
  const provider = new CodexProvider();
  await provider.registerMcpServer('tars-decoy-probe', 'node', ['probe.js'], ['CLAUDE_AGENT_ID']);
  expect(provider.configDir).toBe(path.join(os.homedir(), '.codex'));
  expect(fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8')).toContain('tars-decoy-probe');
  for (const name of NAMES) expect(process.env[name], name).toBeUndefined();
});
