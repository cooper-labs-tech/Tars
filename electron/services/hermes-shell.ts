import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { HermesConnection } from '../types/hermes';
import { HERMES_DEFAULT_PORT } from '../types/hermes';

/**
 * A shell on Hermes's machine, for the relay's switch (2.0.4, the Relay frames' notes for the Backend): on this Mac
 * through execFile, never a shell; over SSH to the host saved in Connection, keys only (BatchMode), never a password
 * or a host key asked in a terminal nobody watches; none for a remote URL or Hermes Cloud, whose user runs the
 * commands by hand (byHand).
 */

export type Exec = (file: string, args: string[], opts: { timeout: number; env?: NodeJS.ProcessEnv }) => Promise<{ code: number; out: string }>;

export interface HermesShell {
  /** Where the commands run, as the window says it. */
  where: string;
  /** The plugin's folder on Hermes's machine, as `hermes plugins validate` takes it there. */
  pluginPath: string;
  run(argv: string[], timeoutMs?: number): Promise<{ code: number; out: string }>;
  /** The plugin shipped in Tars, copied into Hermes's plugins folder in place of any older copy. */
  copyPlugin(localDir: string): Promise<{ code: number; out: string }>;
}

const RUN_MS = 60_000;
const OUT_MAX = 1_000_000;

/** execFile, its exit code and its output (stdout then stderr), never thrown. */
export const realExec: Exec = (file, args, opts) => new Promise((resolve) => {
  execFile(file, args, { timeout: opts.timeout, maxBuffer: OUT_MAX, env: opts.env, windowsHide: true }, (err, stdout, stderr) => {
    const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((err as { code: number }).code) : 1) : 0;
    resolve({ code, out: `${stdout ?? ''}${stderr ?? ''}`.slice(0, OUT_MAX) });
  });
});

/** One word for a POSIX shell: single-quoted, a quote in it closed, escaped and reopened. */
export function shellWord(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** What to run by hand on Hermes's server when Tars has no shell there (a remote URL, Hermes Cloud). */
export function byHand(): string[] {
  return [
    'scp -r tars-relay <server>:~/.hermes/plugins/tars-relay',
    'ssh <server> hermes plugins validate ~/.hermes/plugins/tars-relay',
    'ssh <server> hermes plugins enable tars-relay',
  ];
}

export function hermesShellFor(conn: HermesConnection, exec: Exec = realExec, opts: { hermesHome?: string; env?: NodeJS.ProcessEnv } = {}): HermesShell | null {
  if (conn.mode === 'local') {
    const hermesHome = opts.hermesHome ?? (process.env.HERMES_HOME || path.join(os.homedir(), '.hermes'));
    const pluginPath = path.join(hermesHome, 'plugins', 'tars-relay');
    return {
      where: 'this Mac',
      pluginPath,
      run: (argv, timeoutMs = RUN_MS) => exec(argv[0], argv.slice(1), { timeout: timeoutMs, env: opts.env }),
      async copyPlugin(localDir) {
        try {
          fs.rmSync(pluginPath, { recursive: true, force: true });
          fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
          fs.cpSync(localDir, pluginPath, { recursive: true });
          return { code: 0, out: `copied to ${pluginPath}` };
        } catch (err) {
          return { code: 1, out: err instanceof Error ? err.message : String(err) };
        }
      },
    };
  }
  if (conn.mode !== 'ssh' || !conn.ssh?.host || !conn.ssh.user) return null;
  const { host, user } = conn.ssh;
  const port = String(conn.ssh.port || 22);
  const key = conn.ssh.keyPath ? ['-i', conn.ssh.keyPath, '-o', 'IdentitiesOnly=yes'] : [];
  const quiet = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15'];
  const target = `${user}@${host}`;
  // A command over SSH is one line for the remote shell: each word quoted. `hermes` is put on the PATH where its
  // installer puts it, which a non-interactive SSH shell may not have.
  const remote = (line: string, timeoutMs = RUN_MS) => exec('ssh', [...quiet, '-p', port, ...key, target, line], { timeout: timeoutMs, env: opts.env });
  return {
    where: `${target} over SSH`,
    pluginPath: '.hermes/plugins/tars-relay',
    run: (argv, timeoutMs) => remote(`PATH="$HOME/.local/bin:$HOME/.hermes/hermes-agent/venv/bin:$PATH" ${argv.map(shellWord).join(' ')}`, timeoutMs),
    async copyPlugin(localDir) {
      const cleared = await remote('rm -rf "$HOME/.hermes/plugins/tars-relay" && mkdir -p "$HOME/.hermes/plugins"');
      if (cleared.code !== 0) return cleared;
      return exec('scp', ['-r', ...quiet, '-P', port, ...key, localDir, `${target}:.hermes/plugins/`], { timeout: RUN_MS, env: opts.env });
    },
  };
}

export { HERMES_DEFAULT_PORT };
