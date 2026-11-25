import '../../home-guard';
import { expect, it } from 'vitest';

// Run by env-isolation.test.ts (case 4) with decoys of gemini's, grok's, codex's and pi's own variables, Google's and
// xAI's keys and XDG_BIN_HOME exported, as a shell that sets them has them.
const NAMES = [
  'GEMINI_CLI_HOME', 'GROK_HOME', 'CODEX_SQLITE_HOME', 'PI_PACKAGE_DIR', 'PI_MANAGED_INSTALL_ROOT', 'XDG_BIN_HOME',
  'GROK_CONFIG_PATH', 'GEMINI_CLI_TRUSTED_FOLDERS_PATH', 'CODEX_CA_CERTIFICATE', 'PI_SESSION_FILE',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GCLOUD_PROJECT', 'XAI_API_KEY', 'CODEX_AUTH', 'GROK_CONFIG',
];

it('starts without any of the CLIs\' own variables of the runner\'s', () => {
  for (const name of NAMES) expect(process.env[name], name).toBeUndefined();
});
