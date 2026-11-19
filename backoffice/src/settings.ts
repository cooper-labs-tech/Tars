// The settings the operator changes in the back-office pages, kept in the database.
import type { Db } from './db.ts';

export interface Settings {
  retentionDays: number;           // sessions older than this (by end, else start) are deleted
  registration: 'open' | 'closed'; // closed on a fresh deploy: the operator opens it
  minFreeBytes: number;            // writes stop (507) while the blob disk has less free
  maxStoredBytes: number;          // default quota per install
  ratePerMinute: number;
  burst: number;
  registrationsPerHourPerAddress: number;
  registrationsPerHour: number;
}

export const DEFAULTS: Settings = {
  retentionDays: 90,
  registration: 'closed',
  minFreeBytes: 5 * 1024 ** 3,
  maxStoredBytes: 2 * 1024 ** 3,
  ratePerMinute: 120,
  burst: 60,
  registrationsPerHourPerAddress: 10,
  registrationsPerHour: 500,
};

export async function readSettings(db: Db): Promise<Settings> {
  const rows = (await db.query<{ k: string; v: unknown }>('SELECT k, v FROM settings')).rows;
  const s: Record<string, unknown> = { ...DEFAULTS };
  for (const { k, v } of rows) if (k in s && typeof v === typeof s[k]) s[k] = v;
  return s as unknown as Settings;
}

/** Checks and stores what the operator submitted; returns the error to show, or null. */
export async function writeSettings(db: Db, next: Settings): Promise<string | null> {
  const intIn = (v: number, lo: number, hi: number) => Number.isSafeInteger(v) && v >= lo && v <= hi;
  if (!intIn(next.retentionDays, 1, 3650)) return 'Retention must be 1 to 3650 days.';
  if (next.registration !== 'open' && next.registration !== 'closed') return 'Registration must be open or closed.';
  if (!intIn(next.maxStoredBytes, 0, 1024 ** 5)) return 'The quota must be 0 or more.';
  if (!intIn(next.minFreeBytes, 1024 * 1024, 1024 ** 5)) return 'The free-disk floor must be 1 MiB or more.';
  if (!intIn(next.ratePerMinute, 1, 100_000) || !intIn(next.burst, 1, 100_000)) return 'The rate and the burst must be 1 to 100000.';
  if (!intIn(next.registrationsPerHourPerAddress, 1, 100_000) || !intIn(next.registrationsPerHour, 1, 1_000_000)) return 'Registration limits must be 1 or more.';
  for (const [k, v] of Object.entries(next)) {
    await db.query('INSERT INTO settings (k, v) VALUES ($1, $2) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v', [k, JSON.stringify(v)]);
  }
  return null;
}
