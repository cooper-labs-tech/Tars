import type { HealthSample } from './samples';
import type { AbruptEnd } from '../error-reports/report';

/**
 * The report of a run that ended abruptly (2.0.3, monitoring option 1), from
 * its run record (run-state.ts) and the health samples it left: its version,
 * how long it ran, the OS's name for the crash when there is one, and its last
 * sample. Its uptime runs to the later of the record's last write and its last
 * sample: the record is written when an agent's state changes, which can be
 * hours before the end.
 */
export function abruptEndPayload(
  previous: { startedAt: number; lastWriteAt: number; version: string | null },
  samples: HealthSample[],
  crashType: string | null,
): AbruptEnd {
  const ofThatRun = samples.filter((s) => s.at >= previous.startedAt);
  const lastSample = ofThatRun.length ? ofThatRun[ofThatRun.length - 1] : null;
  const end = Math.max(previous.lastWriteAt, lastSample?.at ?? 0);
  return {
    previousVersion: previous.version,
    uptimeMinutes: Math.max(0, Math.round((end - previous.startedAt) / 60_000)),
    crashType,
    lastSample,
  };
}
