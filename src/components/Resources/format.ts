/**
 * The Resources page's words for figures: sizes in the units the frames use (MB under a gigabyte, GB with one decimal
 * above), clock times, and "since 14:02 · 12 min". A figure Tars could not read is said as such, never as zero.
 */

export const NOT_READ = 'not read';

const GB = 1e9;
const MB = 1e6;

export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NOT_READ;
  if (n === 0) return '0 B';
  if (n < GB) return `${Math.max(1, Math.round(n / MB))} MB`;
  return `${(n / GB).toFixed(1)} GB`;
}

export const mb = (n: number | null | undefined) => (n === null || n === undefined ? NOT_READ : bytes(n * MB));
export const gb = (n: number | null | undefined) => (n === null || n === undefined ? NOT_READ : `${n.toFixed(1)} GB`);
export const pct = (n: number | null | undefined) => (n === null || n === undefined ? NOT_READ : `${Math.round(n)} %`);

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
