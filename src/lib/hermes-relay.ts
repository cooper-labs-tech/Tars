import type { StatusTone } from '@/components/ui';
import type { HermesRelayStatus } from '@/types/electron';

/**
 * What the Telegram through Hermes row in Settings, Hermes says of the relay
 * (#285's HermesRelayStatus): its state as a word in its tone, and a sentence
 * on what to do. Frames: `Settings · Connection`, and `Settings · Connection ·
 * Telegram through Hermes` with its light copy. Its failures are listed, and
 * pinned, in __tests__/lib/hermes-relay-view.test.ts.
 */

/** The row's sentence while the switch is off: what it does, and what turning it on erases. */
export const RELAY_OFF_LINE =
  "Hermes becomes the only voice on your Telegram: Tars writes to you through it, and each reply reaches the orchestrator it answers. Turning it on erases the Tars bot's token and switches the bot off.";

const STATES: Record<Exclude<HermesRelayStatus['state'], 'off'>, { word: string; tone: StatusTone; line: string }> = {
  ready: { word: 'ready', tone: 'running', line: 'Hermes writes to you for Tars, and each reply reaches the orchestrator it answers.' },
  unreachable: { word: 'unreachable', tone: 'error', line: 'Hermes did not answer.' },
  'not-configured': {
    word: 'not configured', tone: 'waiting',
    line: "The tars-relay plugin on your Hermes has no Telegram user to write to. Set it in the plugin's settings on the server.",
  },
  'plugin-missing': {
    word: 'plugin missing', tone: 'waiting',
    line: 'The tars-relay plugin is not installed on your Hermes. Install it there: Tars looks again every few seconds.',
  },
  unauthorized: { word: 'unauthorized', tone: 'error', line: 'Hermes refused the dashboard token. Sign in again above.' },
  'no-connection': { word: 'no connection', tone: 'waiting', line: 'No Hermes connection is saved. Set one above, then save.' },
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "at 14:02" today, "on 30 Sep at 23:58" another day; null for a time that is missing or not one. */
function when(iso: string | undefined, now: Date): string | null {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return null;
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return at.toDateString() === now.toDateString() ? `at ${time}` : `on ${at.getDate()} ${MONTHS[at.getMonth()]} at ${time}`;
}

export interface RelayView {
  word: string | null;
  tone: StatusTone | null;
  line: string;
}

/** The row's word, tone and sentence for a status, or for none yet. */
export function relayView(status: HermesRelayStatus | null, now = new Date()): RelayView {
  if (!status || status.state === 'off') return { word: null, tone: null, line: RELAY_OFF_LINE };
  const known = STATES[status.state as keyof typeof STATES];
  // A state a newer main sends and this window does not know: its own name,
  // in the idle ink, and main's own words for it.
  const base = known ?? { word: String(status.state), tone: 'idle' as const, line: status.lastError ?? '' };
  const parts = [base.line];
  if (status.state === 'ready') {
    const sent = when(status.lastSentAt, now);
    const reply = when(status.lastReplyAt, now);
    const times = [sent && `Last sent ${sent}`, reply && `${sent ? 'last' : 'Last'} reply ${reply}`].filter(Boolean).join(', ');
    if (times) parts.push(`${times}.`);
  }
  if (status.waiting > 0) {
    parts.push(status.waiting === 1 ? '1 message waits, and goes when it answers.' : `${status.waiting} messages wait, and go when it answers.`);
  }
  return { word: base.word, tone: base.tone, line: parts.filter(Boolean).join(' ') };
}
