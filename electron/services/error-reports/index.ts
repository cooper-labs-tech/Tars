import * as os from 'os';
import * as path from 'path';
import { app, ipcMain } from 'electron';
import { DATA_DIR } from '../../constants';
import { ReportBudget } from './budget';
import { errorReportOptions } from './options';
import { randomUUID } from 'crypto';
import { healthEvent, reportFingerprint, toReport, type HealthKind, type ReportFacts } from './report';

/**
 * Error reports to Sentry, off unless the user turns them on in Settings
 * (`errorReportsEnabled`, default false). Step 1 of PLAN-RELAIS-SENTRY.md.
 *
 * Off, the SDK is not even loaded: no handler, no IPC listener, nothing on
 * the network. Turned on, at start or while Tars runs, it is loaded and
 * started once for the run. Turned off again, it stays loaded and sends
 * nothing: options.ts reads the setting at each event and again as each
 * envelope is about to leave. Only what report.ts lists can leave, at most
 * once a day for the same error and 20 a day (budget.ts).
 *
 * Started with none of the SDK's defaults: no native crash dumps (they hold
 * process memory), no screenshots, no breadcrumbs of network requests or
 * console lines, no sessions, no preload injected into windows, no
 * OpenTelemetry, and no offline queue on disk that would send later. The
 * renderer's errors come through Tars's own preload (IPCMode.Classic): the
 * window is sandboxed and cannot load the SDK's preload.
 */

/** Tars's Sentry project (the noah-boisserie organisation, EU). A DSN is public by design: it only lets a client send. */
export const ERROR_REPORTS_DSN = 'https://d3d853ef128291b07daad0c136b0c82d@o4511321063620608.ingest.de.sentry.io/4512140890996816';

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

function facts(budget: ReportBudget): ReportFacts {
  return {
    installId: budget.installId,
    release: `tars@${app.getVersion()}`,
    home: os.homedir(),
    host: os.hostname(),
    // Windows: where the home's 8.3 short form is read (platform/home-spellings.ts).
    ...(process.platform === 'win32'
      ? { tempDirs: [os.tmpdir(), process.env.TEMP, process.env.TMP].filter((d): d is string => typeof d === 'string' && d.length > 0) }
      : {}),
    os: {
      name: OS_NAMES[process.platform] ?? process.platform,
      version: typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : os.release(),
    },
    electron: process.versions.electron ?? '',
  };
}

/**
 * Where reports go. A development run may point them at a stand-in
 * (DOROTHY_ERROR_REPORTS_DSN), for the proof against a fake Sentry; a packaged
 * Tars never reads it.
 */
function dsn(): string {
  const override = app.isPackaged ? undefined : process.env.DOROTHY_ERROR_REPORTS_DSN;
  return override || ERROR_REPORTS_DSN;
}

/** The SDK's IPCMode.Classic channels, which the preload's `__SENTRY_IPC__` sends on. */
const RENDERER_CHANNELS = 'sentry-ipc.';
const ENVELOPE_CHANNEL = 'sentry-ipc.envelope';
/** Far above any error report (report.ts caps one at a few tens of kilobytes). */
const MAX_ENVELOPE = 1_000_000;

type Listener = (...args: unknown[]) => unknown;

function dropped(channel: string, why: unknown): void {
  // The name only: the payload, and a parser's message quoting it, may hold anything.
  const reason = why instanceof Error ? why.name : String(why);
  console.warn(`[error-reports] dropped what the renderer sent on ${channel}: ${reason}`);
}

/**
 * The SDK's listeners for what the renderer sends, behind a guard. Their
 * input is the renderer's, and the SDK parses it with no try: a malformed
 * envelope threw out of an ipcMain listener, which is an uncaught exception
 * in main, a fatal report of its own, then Electron's error box holding the
 * process until it was killed (QA's gate of #221). An envelope that is not
 * text or bytes, or is larger than any report, never reaches the SDK; what
 * throws in its listener is logged and dropped. Other channels are not
 * touched.
 */
function guardRendererBridge(): void {
  for (const channel of ipcMain.eventNames()) {
    if (typeof channel !== 'string' || !channel.startsWith(RENDERER_CHANNELS)) continue;
    const listeners = ipcMain.listeners(channel) as Listener[];
    ipcMain.removeAllListeners(channel);
    ipcMain.on(channel, (event, ...args) => {
      if (channel === ENVELOPE_CHANNEL) {
        const env = args[0];
        const fits = (typeof env === 'string' && env.length <= MAX_ENVELOPE)
          || (env instanceof Uint8Array && env.byteLength <= MAX_ENVELOPE);
        if (!fits) return dropped(channel, 'not an envelope, or too large');
      }
      for (const listener of listeners) {
        try {
          const result = listener(event, ...args);
          if (result instanceof Promise) result.catch(err => dropped(channel, err));
        } catch (err) {
          dropped(channel, err);
        }
      }
    });
  }
}

/** What a health report's send answers: sent, or why not, in a sentence the window shows as is. */
export type HealthSendResult = { sent: true } | { sent: false; reason: string };

export const HEALTH_REFUSALS = {
  off: 'Turn on Send error reports in Settings to send a diagnostic.',
  budget: 'A diagnostic was already sent in the last 24 hours.',
  unreachable: 'Sentry could not be reached. Nothing was sent.',
} as const;

/** How long a health report waits for Sentry's answer before it says it could not be reached. */
const HEALTH_SEND_MS = 10_000;

export interface ErrorReports {
  sync(): Promise<void>;
  /** Why nothing may be sent now (the switch off), or null. */
  refusal(): string | null;
  /**
   * A report of Tars's health (2.0.3): the abrupt end at the next launch, or
   * the diagnostic the user sends. Through the same switch and budget as an
   * error, counted before it leaves and given back when Sentry was not reached.
   */
  sendHealth(kind: HealthKind, payload: Record<string, unknown>): Promise<HealthSendResult>;
}

/**
 * The same on every platform (the maintainer's parity rule of 2026-10-16):
 * on Windows too since 2.0.4, where the reports were off until then.
 */
export function startErrorReports(isEnabled: () => boolean): ErrorReports {
  let starting: Promise<void> | undefined;
  let sentryOf: typeof import('@sentry/electron/main') | undefined;
  let budgetOf: ReportBudget | undefined;
  const preAdmitted = new Set<string>();
  const healthPayloads = new Map<string, Record<string, unknown>>();
  const answers = new Map<string, number>();
  const sync = (): Promise<void> => {
    if (starting) return starting;
    if (!isEnabled()) return Promise.resolve();
    starting = (async () => {
      try {
        const sentry = await import('@sentry/electron/main');
        const budget = new ReportBudget(path.join(DATA_DIR, 'error-reports.json'));
        budgetOf = budget;
        sentry.init({
          ...errorReportOptions({
            dsn: dsn(),
            isEnabled,
            facts: () => facts(budget),
            budget,
            makeTransport: sentry.makeElectronTransport as never,
            preAdmitted,
            healthPayloads,
            onSent: (eventId, status) => { answers.set(eventId, status); },
          }),
          defaultIntegrations: false,
          integrations: [
            sentry.onUncaughtExceptionIntegration(),
            sentry.onUnhandledRejectionIntegration(),
            sentry.linkedErrorsIntegration(),
          ],
          ipcMode: sentry.IPCMode.Classic,
          // Chromium would add the system's language to the request.
          transportOptions: { headers: { 'Accept-Language': 'en' } },
          skipOpenTelemetrySetup: true,
        } as never);
        sentryOf = sentry;
      } catch (err) {
        console.warn('[error-reports] could not start:', err instanceof Error ? err.message : err);
      }
      guardRendererBridge();
    })();
    return starting;
  };
  const refusal = (): string | null => {
    if (!isEnabled()) return HEALTH_REFUSALS.off;
    return null;
  };
  const sendHealth = async (kind: HealthKind, payload: Record<string, unknown>): Promise<HealthSendResult> => {
    const refused = refusal();
    if (refused) return { sent: false, reason: refused };
    await sync();
    const sentry = sentryOf;
    const budget = budgetOf;
    if (!sentry || !budget) return { sent: false, reason: HEALTH_REFUSALS.unreachable };
    const id = randomUUID().replace(/-/g, '');
    const event = { ...healthEvent(kind, payload), event_id: id };
    const report = toReport(event, facts(budget));
    if (!report) return { sent: false, reason: HEALTH_REFUSALS.unreachable };
    const fingerprint = reportFingerprint(report);
    const at = budget.admitAt(fingerprint);
    if (at === null) return { sent: false, reason: HEALTH_REFUSALS.budget };
    preAdmitted.add(id);
    healthPayloads.set(id, payload);
    try {
      sentry.captureEvent(event as never, { event_id: id } as never);
      const flushed = await sentry.flush(HEALTH_SEND_MS);
      const status = answers.get(id) ?? 0;
      if (flushed && status >= 200 && status < 300) return { sent: true };
      budget.refund(fingerprint, at);
      return { sent: false, reason: HEALTH_REFUSALS.unreachable };
    } finally {
      preAdmitted.delete(id);
      healthPayloads.delete(id);
      answers.delete(id);
    }
  };
  void sync();
  return { sync, refusal, sendHealth };
}
