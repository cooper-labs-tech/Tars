import * as path from 'node:path';

/**
 * Whether a unit test may run the real `name` CLI, as whoever runs the suite asked (the Audit's I-4 and I-5 on #616):
 * - TARS_REAL_CLAUDE, the suite's older opt-in, for claude: `1`, or the absolute path of the binary;
 * - TARS_TEST_REAL_CLIS, for any CLI, comma separated: `codex` or `codex=1`, or `codex=/abs/path/to/codex`.
 * Answers 'any' (that CLI wherever it is), the absolute path asked for (that binary alone), or null. Anything else,
 * `0`, `false`, an empty value or a path that is not absolute, opts nothing in. Read by __tests__/setup/no-real-cli.ts,
 * which lets an opted-in CLI through, and by the tests that run one (codex-trust, codex-mcp-env, real-claude-bypass).
 */
export function realCliOptIn(name: string, env: NodeJS.ProcessEnv = process.env): 'any' | string | null {
  const accepted = (value: string | undefined) => (value === '1' ? 'any' : value && path.isAbsolute(value) ? value : null);
  const want = name.toLowerCase();
  if (want === 'claude') {
    const asked = accepted(env.TARS_REAL_CLAUDE);
    if (asked) return asked;
  }
  for (const entry of (env.TARS_TEST_REAL_CLIS ?? '').split(/[\s,]+/).filter(Boolean)) {
    const at = entry.indexOf('=');
    const [cli, value] = at < 0 ? [entry, '1'] : [entry.slice(0, at), entry.slice(at + 1)];
    if (cli.toLowerCase() !== want) continue;
    const asked = accepted(value);
    if (asked) return asked;
  }
  return null;
}
