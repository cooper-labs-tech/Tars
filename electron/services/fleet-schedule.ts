/**
 * A project's hours (2.0.7, for long work kept to a window of the day): a window every day, from a start to a stop in HH:MM on 24 hours, in UTC or in the computer's local time, always said
 * (no zone is guessed: a schedule set from another country's habits would open at the wrong hour), and what the start
 * does: resume the queues the last stop paused, or start the agents as well. A stop at or before its start crosses
 * midnight (22:00 to 06:00 is eight hours, ending the next morning); a stop equal to its start is refused.
 *
 * Local time is the computer's own (Date's local calendar): a local window across a change of clocks lasts its real
 * length (01:00 to 05:00 on the night Paris moves from 02:00 to 03:00 is three hours), and a start the change skips
 * (02:30 that night) opens at the instant JavaScript gives it, 03:30. Pure: services/fleet-operations.ts runs it.
 */

export type ScheduleZone = 'UTC' | 'local';
/** What the start of a window does: the queues resumed, and the agents started too. */
export type ScheduleOnStart = 'resume-queues' | 'start-agents';

export interface ScheduleSpec {
  start: string;
  stop: string;
  timeZone: ScheduleZone;
  onStart: ScheduleOnStart;
}

export type ScheduleParse =
  | { ok: true; schedule: ScheduleSpec }
  | { ok: false; error: string; code: 'invalid_schedule' | 'zone_required' | 'invalid_time' | 'empty_window' | 'invalid_on_start' };

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

function clockOf(value: string): { h: number; m: number } {
  const [, h, m] = CLOCK.exec(value)!;
  return { h: Number(h), m: Number(m) };
}

export function parseSchedule(raw: unknown): ScheduleParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'invalid_schedule', error: 'A schedule is { start, stop, timeZone, onStart? }: start and stop in HH:MM, timeZone "UTC" or "local".' };
  }
  const { start, stop, timeZone, onStart } = raw as Record<string, unknown>;
  if (timeZone !== 'UTC' && timeZone !== 'local') {
    return { ok: false, code: 'zone_required', error: 'timeZone is required, and is "UTC" or "local" (the computer\'s own time): Tars never guesses the zone of a schedule.' };
  }
  for (const [name, value] of [['start', start], ['stop', stop]] as const) {
    if (typeof value !== 'string' || !CLOCK.test(value)) {
      return { ok: false, code: 'invalid_time', error: `${name} is a time of day in HH:MM on 24 hours, from 00:00 to 23:59 (22:00, 06:00).` };
    }
  }
  if (start === stop) {
    return { ok: false, code: 'empty_window', error: 'start and stop are the same time: a window has a length. A stop before the start ends the next day (22:00 to 06:00).' };
  }
  if (onStart !== undefined && onStart !== 'resume-queues' && onStart !== 'start-agents') {
    return { ok: false, code: 'invalid_on_start', error: 'onStart is "resume-queues" (the default: the agents start as their work comes) or "start-agents" (each agent at rest is started as well).' };
  }
  return { ok: true, schedule: { start: start as string, stop: stop as string, timeZone, onStart: onStart ?? 'resume-queues' } };
}

/** The instant of `clock` on the day `offset` days from `now`'s day, in the schedule's zone. */
function instant(zone: ScheduleZone, now: number, offset: number, clock: { h: number; m: number }): number {
  const d = new Date(now);
  return zone === 'UTC'
    ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + offset, clock.h, clock.m)
    : new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset, clock.h, clock.m).getTime();
}

/**
 * The window open at `now`, or else the next one to open: its start and its end, as instants. The same window read
 * at any instant within it has the same start, which is what services/fleet-operations.ts knows it by.
 */
export function windowAt(s: ScheduleSpec, now: number): { open: boolean; start: number; end: number } {
  const startClock = clockOf(s.start);
  const stopClock = clockOf(s.stop);
  const crosses = s.stop <= s.start;
  let next: { start: number; end: number } | undefined;
  for (const offset of [-1, 0, 1, 2]) {
    const start = instant(s.timeZone, now, offset, startClock);
    const end = instant(s.timeZone, now, offset + (crosses ? 1 : 0), stopClock);
    if (start <= now && now < end) return { open: true, start, end };
    if (start > now && (!next || start < next.start)) next = { start, end };
  }
  return { open: false, ...next! };
}

/** The schedule as the window, the guide and the queues' pause read it. */
export function scheduleLine(s: Pick<ScheduleSpec, 'start' | 'stop' | 'timeZone'>): string {
  return `every day from ${s.start} to ${s.stop}${s.timeZone === 'UTC' ? ' UTC' : ", the computer's local time"}`;
}
