import { ipcMain } from 'electron';
import { readSamples, type Vocabulary } from '../services/health/samples';
import type { ErrorReports } from '../services/error-reports';

/**
 * "Send a diagnostic" (2.0.3, monitoring option 2): the last 24 hours of
 * health samples, sent once, at the user's click, through the error reports'
 * switch and budget. The window shows the answer: what left, or why nothing
 * did.
 */

export type DiagnosticAnswer =
  | { sent: true; samples: number; from: string; to: string }
  | { sent: false; reason: string };

export const NO_SAMPLE = 'Nothing has been recorded yet: Tars records its health every 5 minutes.';

interface DiagnosticDeps {
  reports: Pick<ErrorReports, 'refusal' | 'sendHealth'>;
  samplesFile: string;
  /** What a sample may name when it leaves: the channels registered, the app's pages. */
  known?: Vocabulary;
  now?: () => number;
}

export async function sendDiagnostic(deps: DiagnosticDeps): Promise<DiagnosticAnswer> {
  const refused = deps.reports.refusal();
  if (refused) return { sent: false, reason: refused };
  const samples = readSamples(deps.samplesFile, (deps.now ?? Date.now)(), deps.known);
  if (samples.length === 0) return { sent: false, reason: NO_SAMPLE };
  const result = await deps.reports.sendHealth('diagnostic', { samples });
  if (!result.sent) return result;
  return {
    sent: true,
    samples: samples.length,
    from: new Date(samples[0].at).toISOString(),
    to: new Date(samples[samples.length - 1].at).toISOString(),
  };
}

export function registerDiagnosticHandlers(deps: Omit<DiagnosticDeps, 'now'>): void {
  ipcMain.handle('diagnostic:send', () => sendDiagnostic(deps));
}
