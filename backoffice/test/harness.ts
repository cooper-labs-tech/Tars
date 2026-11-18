// A throwaway Postgres and the real server, for the E2E. Nothing here touches a database or a
// folder that exists outside the run: initdb writes into a fresh temporary folder, the server
// listens on a free loopback port, and stop() removes both.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

export const ROOT = resolve(import.meta.dirname, '..');

/** Where initdb and pg_ctl live: PG_BIN, then pg_config, then the usual places. */
export function pgBin(): string {
  const candidates: string[] = [];
  if (process.env.PG_BIN) candidates.push(process.env.PG_BIN);
  try {
    candidates.push(execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim());
  } catch { /* not on PATH */ }
  candidates.push('/opt/homebrew/opt/postgresql@17/bin', '/usr/local/opt/postgresql@17/bin');
  for (const v of ['17', '16', '18']) candidates.push(`/usr/lib/postgresql/${v}/bin`);
  for (const dir of candidates) if (existsSync(join(dir, 'initdb')) && existsSync(join(dir, 'pg_ctl'))) return dir;
  throw new Error(`no initdb and pg_ctl found (looked in ${candidates.join(', ')}); set PG_BIN`);
}

export function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (a && typeof a === 'object' ? ok(a.port) : fail(new Error('no port'))));
    });
  });
}

export interface Pg { env: Record<string, string>; dir: string; stop(): void }

export async function startPostgres(): Promise<Pg> {
  const bin = pgBin();
  const dir = mkdtempSync(join(tmpdir(), 'tbo-pg-'));
  const data = join(dir, 'data');
  const port = await freePort();
  execFileSync(join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-locale'], { stdio: 'ignore' });
  // No TCP: the server listens on a unix socket in the run's own folder only.
  execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-l', join(dir, 'pg.log'), '-w', '-o', `-k ${dir} -p ${port} -c listen_addresses=`, 'start'], { stdio: 'ignore' });
  return {
    dir,
    env: { PGHOST: dir, PGPORT: String(port), PGUSER: 'postgres', PGDATABASE: 'postgres' },
    stop() {
      try { execFileSync(join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' }); } catch { /* already down */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function runCli(args: string[], env: Record<string, string>, input?: string): string {
  return execFileSync(process.execPath, [join(ROOT, 'src/cli.ts'), ...args], {
    env: { ...process.env, ...env }, input, encoding: 'utf8',
  });
}

export interface Server { base: string; proc: ChildProcess; log: string[]; stop(): Promise<void> }

export async function startServer(env: Record<string, string>): Promise<Server> {
  const proc = spawn(process.execPath, [join(ROOT, 'src/server.ts')], {
    env: { ...process.env, BACKOFFICE_LISTEN: '127.0.0.1:0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log: string[] = [];
  const base = await new Promise<string>((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`server did not start:\n${log.join('')}`)), 15_000);
    const onData = (b: Buffer) => {
      log.push(b.toString());
      const m = /listening on (http:\/\/[0-9.:]+)/.exec(log.join(''));
      if (m?.[1]) { clearTimeout(timer); ok(m[1]); }
    };
    proc.stdout!.on('data', onData);
    proc.stderr!.on('data', (b: Buffer) => log.push(b.toString()));
    proc.once('exit', (code) => { clearTimeout(timer); fail(new Error(`server exited ${code}:\n${log.join('')}`)); });
  });
  return {
    base, proc, log,
    stop: () => new Promise<void>((ok) => {
      if (proc.exitCode !== null) return ok();
      proc.once('exit', () => ok());
      proc.kill('SIGTERM');
    }),
  };
}

/** Every file under a folder, relative paths, for the blob store's on-disk checks. */
export function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out.push(join(e.parentPath, e.name));
  return out;
}
