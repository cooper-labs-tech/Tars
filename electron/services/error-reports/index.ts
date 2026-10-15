import * as os from 'os';
import * as path from 'path';
import { app, ipcMain } from 'electron';
import { DATA_DIR } from '../../constants';
import { ReportBudget } from './budget';
import { errorReportOptions } from './options';
import type { ReportFacts } from './report';
import { errorReportsAvailable } from '../../platform/error-reports';

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

/** Tars's Sentry project (the maintainer's organisation, EU). A DSN is public by design: it only lets a client send. */
export const ERROR_REPORTS_DSN = 'https://d3d853ef128291b07daad0c136b0c82d@o4511321063620608.ingest.de.sentry.io/4512140890996816';

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

function facts(budget: ReportBudget): ReportFacts {
  return {
    installId: budget.installId,
    release: `tars@${app.getVersion()}`,
    home: os.homedir(),
    host: os.hostname(),
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

/** Never on a platform whose build may not send (errorReportsAvailable: not on win32). */
export function startErrorReports(isEnabled: () => boolean, platform: NodeJS.Platform = process.platform): { sync(): Promise<void> } {
  let starting: Promise<void> | undefined;
  const sync = (): Promise<void> => {
    if (starting) return starting;
    if (!errorReportsAvailable(platform) || !isEnabled()) return Promise.resolve();
    starting = (async () => {
      try {
        const sentry = await import('@sentry/electron/main');
        const budget = new ReportBudget(path.join(DATA_DIR, 'error-reports.json'));
        sentry.init({
          ...errorReportOptions({
            dsn: dsn(),
            isEnabled,
            facts: () => facts(budget),
            budget,
            makeTransport: sentry.makeElectronTransport as never,
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
      } catch (err) {
        console.warn('[error-reports] could not start:', err instanceof Error ? err.message : err);
      }
      guardRendererBridge();
    })();
    return starting;
  };
  void sync();
  return { sync };
}
