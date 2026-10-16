import { flat } from '@/lib/stop-line';

/**
 * The line under Settings > Preferences > Diagnostic once main has answered
 * `diagnostic:send`: how many samples went, from when to when in local time,
 * or main's own sentence for why nothing did. Frame: `Settings · Preferences ·
 * diagnostic`, and its light copy. Its failures are listed, and pinned, in
 * __tests__/lib/diagnostic.test.ts.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const NOTHING = 'Nothing was sent.';

/** `14 Oct 09:05`, with the year when it is not now's. */
function stamp(at: Date, now: Date): string {
  const year = at.getFullYear() === now.getFullYear() ? '' : ` ${at.getFullYear()}`;
  return `${at.getDate()} ${MONTHS[at.getMonth()]}${year} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** A time main wrote, or null when it does not read as one. */
function timeOf(value: unknown): Date | null {
  if (typeof value !== 'string' || !value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** What to say of main's answer; checked here, since a bridge can hand over anything. */
export function diagnosticLine(answer: unknown, now: Date): string {
  if (!answer || typeof answer !== 'object') return NOTHING;
  const a = answer as Record<string, unknown>;
  if (a.sent === false) return (typeof a.reason === 'string' && flat(a.reason)) || NOTHING;
  if (a.sent !== true || typeof a.samples !== 'number' || !Number.isInteger(a.samples) || a.samples < 0) return NOTHING;
  const count = a.samples === 1 ? '1 sample' : `${a.samples} samples`;
  const from = timeOf(a.from);
  const to = timeOf(a.to);
  return from && to ? `Sent ${count} from ${stamp(from, now)} to ${stamp(to, now)}.` : `Sent ${count}.`;
}
