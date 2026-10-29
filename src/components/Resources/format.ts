/**
 * The Resources page's words for figures: sizes in the units the frames use (MB under a gigabyte, GB with one decimal
 * above), clock times, and "since 14:02 · 12 min". A figure Tars could not read is said as such, never as zero.
 *
 * One unit in the whole window, Tars's own: a GB is 1024³ bytes, as the heavy-run slot reads the disk and applies its
 * floor and alerts (health/machine.ts), and as Settings · System shows it (lib/orphan-folders.ts). In 10⁹ bytes the
 * free disk read above the slot's floor while a run waited for disk (the Audit's M1 at the re-check of PR 539).
 */

export const NOT_READ = 'not read';

const MB = 1024 ** 2;
const GB = 1024 ** 3;

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NOT_READ;
  if (n === 0) return '0 B';
  if (n < GB) return `${Math.max(1, Math.round(n / MB))} MB`;
  return `${(n / GB).toFixed(1)} GB`;
}

/** A disk figure in bytes, in the slot's GB. */
export const diskGb = (n: number) => n / GB;

/** A figure the backends give in MB (KB / 1024), in bytes. */
export const mbBytes = (n: number) => n * MB;

export const mb = (n: number | null | undefined) => (n === null || n === undefined ? NOT_READ : bytes(mbBytes(n)));
export const gb = (n: number | null | undefined) => (n === null || n === undefined ? NOT_READ : `${n.toFixed(1)} GB`);
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? NOT_READ : `${Math.round(n)} %`);

/**
 * Free memory as the frame draws it, one measure: the free memory the share speaks of (memFreeShareMb) over
 * "26 % of 24 GB · floor 20 %". Never the free pages (memFreeMb) beside the share: on macOS they are another measure,
 * "144 MB · 43 % free" on a 24 GB Mac (the QA's F2 on PR 539).
 */
export function freeMemory(
  m: { memFreePct: number | null; memFreeShareMb: number | null; memTotalMb: number | null } | null,
  floorPct?: number,
): { value: string; sub: string } | null {
  if (!m) return null;
  const share = m.memFreePct === null ? NOT_READ : m.memTotalMb === null ? `${pct(m.memFreePct)} free` : `${pct(m.memFreePct)} of ${Math.round(m.memTotalMb / 1024)} GB`;
  return { value: mb(m.memFreeShareMb), sub: floorPct === undefined ? share : `${share} · floor ${floorPct} %` };
}

export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 14:22 today, 27/10 14:22 another day. */
export function stamp(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const today = new Date(now).toDateString() === d.toDateString();
  return today ? clock(ms) : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} ${clock(ms)}`;
}

export function lasted(from: number, now = Date.now()): string {
  const min = Math.max(0, Math.floor((now - from) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

export const since = (from: number, now = Date.now()) => `since ${clock(from)} · ${lasted(from, now)}`;

/** A sum over figures that may be unread: unread if any is. */
export function sum(values: (number | null | undefined)[]): number | null {
  let total = 0;
  for (const v of values) {
    if (v === null || v === undefined) return null;
    total += v;
  }
  return total;
}
