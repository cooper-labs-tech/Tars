// Everything that deletes: an install's own request, the operator's, and the retention sweep.
// Each deletion leaves a tombstone in the readers' feed (API.md § 6.4), and a line in the
// operator's log with counts, never content.
import { randomBytes } from 'node:crypto';
import type { Ctx } from './http.ts';
import { inTx, nextChange } from './db.ts';

export interface Deleted {
  deleted: { sessions: number; turns: number; requests: number; blobs: number; storedBytes: number };
  deletedAt: number;
  receipt: string;
}

export async function deleteInstall(ctx: Ctx, installId: string, reason: 'install_deleted' | 'operator'): Promise<Deleted> {
  const { out, hashes } = await inTx(ctx.db, async (tx) => {
    const c = (await tx.query(
      `SELECT (SELECT count(*)::int FROM sessions WHERE install_id = $1) AS sessions,
              (SELECT count(*)::int FROM turns WHERE install_id = $1) AS turns,
              (SELECT count(*)::int FROM requests WHERE install_id = $1) AS requests,
              (SELECT count(*)::int FROM install_blobs WHERE install_id = $1) AS blobs,
              (SELECT stored_bytes FROM installs WHERE id = $1) AS stored`, [installId])).rows[0];
    const hashes = (await tx.query<{ hash: string }>('SELECT hash FROM install_blobs WHERE install_id = $1', [installId])).rows.map((r) => r.hash);
    // Every row the install sent cascades from this one, its token with it.
    await tx.query('DELETE FROM installs WHERE id = $1', [installId]);
    const seq = await nextChange(tx);
    await tx.query('INSERT INTO tombstones (seq, install_id, session_id, reason) VALUES ($1, $2, NULL, $3)', [seq, installId, reason]);
    const receipt = `del_${randomBytes(12).toString('base64url')}`;
    const deleted = { sessions: c.sessions, turns: c.turns, requests: c.requests, blobs: c.blobs, storedBytes: c.stored ?? 0 };
    const at = (await tx.query<{ at: Date }>(
      'INSERT INTO deletion_log (receipt, install_id, reason, counts) VALUES ($1, $2, $3, $4) RETURNING at', [receipt, installId, reason, JSON.stringify(deleted)])).rows[0]!.at;
    return { out: { deleted, deletedAt: at.getTime(), receipt }, hashes };
  });
  await collectBlobs(ctx, hashes);
  return out;
}

/** Removes the blobs among these that no install references any more, row and file. */
export async function collectBlobs(ctx: Ctx, hashes: string[]): Promise<number> {
  let removed = 0;
  for (const hash of hashes) {
    await inTx(ctx.db, async (tx) => {
      // The same lock as a blob upload (ingest.ts): an upload of this hash waits, then finds no
      // row and writes the file again, so no row is ever left without its file.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [hash]);
      const r = await tx.query('DELETE FROM blobs b WHERE hash = $1 AND NOT EXISTS (SELECT 1 FROM install_blobs ib WHERE ib.hash = b.hash)', [hash]);
      if (r.rowCount) {
        ctx.blobs.remove(hash);
        removed++;
      }
    });
  }
  return removed;
}

export interface SweepResult { sessions: number; blobs: number; installs: number }

/**
 * The retention sweep: deletes sessions that ended (or, never ended, started) more than
 * retentionDays ago, then the blobs only they used, the batch records past their replay window,
 * installs that never uploaded within 7 days, and expired logins.
 */
export async function sweep(ctx: Ctx, now = Date.now()): Promise<SweepResult> {
  const { retentionDays } = await ctx.settings();
  const cutoff = new Date(now - retentionDays * 86_400_000);
  let sessions = 0;
  const touched = new Set<string>();
  for (;;) {
    const n = await inTx(ctx.db, async (tx) => {
      const rows = (await tx.query<{ install_id: string; session_id: string }>(
        `DELETE FROM sessions WHERE (install_id, session_id) IN (
           SELECT install_id, session_id FROM sessions WHERE coalesce(ended_at, started_at) < $1 LIMIT 500 FOR UPDATE SKIP LOCKED)
         RETURNING install_id, session_id`, [cutoff])).rows;
      for (const r of rows) {
        const seq = await nextChange(tx);
        await tx.query(`INSERT INTO tombstones (seq, install_id, session_id, reason) VALUES ($1, $2, $3, 'retention')`, [seq, r.install_id, r.session_id]);
        touched.add(r.install_id);
      }
      if (rows.length) {
        const per = new Map<string, number>();
        for (const r of rows) per.set(r.install_id, (per.get(r.install_id) ?? 0) + 1);
        for (const [install, count] of per) {
          await tx.query(`INSERT INTO deletion_log (receipt, install_id, reason, counts) VALUES ($1, $2, 'retention', $3)`,
            [`del_${randomBytes(12).toString('base64url')}`, install, JSON.stringify({ sessions: count })]);
        }
      }
      return rows.length;
    });
    sessions += n;
    if (n < 500) break;
  }
  // Batch records are kept 30 days for replays, then let go (and stop counting towards the quota).
  await ctx.db.query(`DELETE FROM batches WHERE received_at < $1`, [new Date(now - 30 * 86_400_000)]);
  // References no request uses any more, a day after they arrived (a blob may come before its batch).
  const orphans = (await ctx.db.query<{ install_id: string; hash: string }>(
    `DELETE FROM install_blobs ib WHERE ib.created_at < $1
        AND NOT EXISTS (SELECT 1 FROM request_messages rm WHERE rm.install_id = ib.install_id AND rm.hash = ib.hash)
        AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.install_id = ib.install_id AND r.tools_hash = ib.hash)
      RETURNING install_id, hash`, [new Date(now - 86_400_000)])).rows;
  for (const o of orphans) touched.add(o.install_id);
  // Messages metadata no request names any more.
  await ctx.db.query(`DELETE FROM messages m WHERE NOT EXISTS (SELECT 1 FROM request_messages rm WHERE rm.install_id = m.install_id AND rm.hash = m.hash)
                         AND m.created_at < $1`, [cutoff]);
  for (const install of touched) {
    await ctx.db.query(
      `UPDATE installs SET stored_bytes =
         coalesce((SELECT sum(b.stored_size) FROM install_blobs ib JOIN blobs b USING (hash) WHERE ib.install_id = $1), 0)
       + coalesce((SELECT sum(bytes) FROM batches WHERE install_id = $1), 0) WHERE id = $1`, [install]);
  }
  const blobs = await collectBlobs(ctx, [...new Set(orphans.map((o) => o.hash))]);
  const idle = await ctx.db.query(`DELETE FROM installs WHERE first_upload_at IS NULL AND created_at < $1`, [new Date(now - 7 * 86_400_000)]);
  await ctx.db.query('DELETE FROM admin_sessions WHERE expires_at < now()');
  await ctx.db.query(`DELETE FROM registrations WHERE at < now() - interval '1 day'`);
  return { sessions, blobs, installs: idle.rowCount ?? 0 };
}
