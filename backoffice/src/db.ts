// The Postgres pool and the migration runner. Migrations are numbered pairs of SQL files,
// NNN_name.up.sql and NNN_name.down.sql, each applied in one transaction.
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// bigint columns come back as strings by default; every count here fits in a JS number, and the
// change sequence is read as a string where it matters (cursor.ts).
pg.types.setTypeParser(20, (v: string) => Number(v));

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function connect(): Db {
  // DATABASE_URL, or the standard PG* variables when it is unset.
  const pool = new pg.Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL, max: 10 } : { max: 10 });
  pool.on('error', (e) => console.error(`postgres pool: ${e.message}`));
  return pool;
}

export async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const out = await fn(tx);
    await tx.query('COMMIT');
    return out;
  } catch (e) {
    await tx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}

/**
 * Every write a reader can see takes this lock, then the next number of change_seq, and holds the
 * lock until it commits. So changes commit in the order of their numbers, and a reader that saw
 * number N can never later meet a change numbered below N: its cursor misses nothing.
 */
export async function nextChange(tx: Tx): Promise<string> {
  await tx.query('SELECT pg_advisory_xact_lock(7243001)');
  const r = await tx.query<{ n: string }>(`SELECT nextval('change_seq')::text AS n`);
  return r.rows[0]!.n;
}

const MIGRATIONS = resolve(import.meta.dirname, '..', 'migrations');

interface Migration { version: number; name: string; up: string; down: string }

export function migrations(): Migration[] {
  const files = readdirSync(MIGRATIONS);
  const out: Migration[] = [];
  for (const f of files) {
    const m = /^(\d{3})_([a-z0-9_]+)\.up\.sql$/.exec(f);
    if (!m) continue;
    const down = `${m[1]}_${m[2]}.down.sql`;
    if (!files.includes(down)) throw new Error(`${f} has no ${down}`);
    out.push({ version: Number(m[1]), name: m[2]!, up: readFileSync(join(MIGRATIONS, f), 'utf8'), down: readFileSync(join(MIGRATIONS, down), 'utf8') });
  }
  return out.sort((a, b) => a.version - b.version);
}

async function applied(db: Db): Promise<number[]> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  return (await db.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => r.version);
}

export async function migrateUp(db: Db): Promise<string[]> {
  const done = new Set(await applied(db));
  const ran: string[] = [];
  for (const m of migrations()) {
    if (done.has(m.version)) continue;
    await inTx(db, async (tx) => {
      await tx.query(m.up);
      await tx.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
    });
    ran.push(`${m.version} ${m.name}`);
  }
  return ran;
}

export async function migrateDown(db: Db, all: boolean): Promise<string[]> {
  const done = await applied(db);
  const byVersion = new Map(migrations().map((m) => [m.version, m]));
  const ran: string[] = [];
  for (const v of done.reverse()) {
    const m = byVersion.get(v);
    if (!m) throw new Error(`migration ${v} is applied but its files are gone`);
    await inTx(db, async (tx) => {
      await tx.query(m.down);
      await tx.query('DELETE FROM schema_migrations WHERE version = $1', [v]);
    });
    ran.push(`${m.version} ${m.name}`);
    if (!all) break;
  }
  return ran;
}

/** The migrations not applied yet; the server refuses to start while there are any. */
export async function pending(db: Db): Promise<string[]> {
  const done = new Set(await applied(db));
  return migrations().filter((m) => !done.has(m.version)).map((m) => `${m.version} ${m.name}`);
}
