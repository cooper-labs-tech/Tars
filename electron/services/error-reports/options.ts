import { toReport, reportFingerprint, keepErrorsOnly, type ReportFacts } from './report';
import type { ReportBudget } from './budget';

/**
 * The Sentry options Tars starts the SDK with, apart from what only the
 * Electron SDK knows (its integrations, its IPC mode): index.ts adds those.
 * Kept free of `electron` so the real Sentry client can be run on them in a
 * test, with a transport that records the bytes.
 *
 * Two gates, each enough on its own:
 * - beforeSend: the setting is read at each event, the event is rebuilt as a
 *   report (report.ts), and the daily budget decides whether it leaves;
 * - the transport: the setting is read again when the envelope is about to
 *   go, after a turn of the event loop, so an event captured just before the
 *   setting was turned off does not leave either; and only error events,
 *   rebuilt the same way, reach the network. @sentry/electron hands some of a
 *   renderer's envelopes straight to the transport, past beforeSend.
 */

/** The transport shape both @sentry/core's createTransport and the Electron SDK's transports return. */
interface Transport {
  send(envelope: unknown): PromiseLike<unknown>;
  flush(timeout?: number): PromiseLike<boolean>;
}

export interface ErrorReportDeps {
  dsn: string;
  isEnabled: () => boolean;
  facts: () => ReportFacts;
  budget: ReportBudget;
  /** The network: the Electron SDK's transport in the app, a recorder in a test. */
  makeTransport: (options: never) => Transport;
  /** Event ids the budget already counted (a health report, index.ts sendHealth): not counted twice. */
  preAdmitted?: Set<string>;
  /** Told each event's answer from Sentry: its HTTP status, 0 when none came. */
  onSent?: (eventId: string, status: number) => void;
  /**
   * A health report's numbers, by event id, put back after the SDK's
   * normalization: it cuts what an event holds below a depth of 3, and a
   * diagnostic's samples (contexts.tars.samples[i]) or the slowest handlers
   * of an abrupt end's last sample sit deeper. Raising the depth for every
   * event would move the cut, not remove it.
   */
  healthPayloads?: Map<string, Record<string, unknown>>;
}

function gated(base: Transport, deps: ErrorReportDeps): Transport {
  const pending = new Set<Promise<unknown>>();
  return {
    send(envelope) {
      const sent = new Promise(resolve => setImmediate(resolve)).then(() => {
        if (!deps.isEnabled()) return {};
        const kept = keepErrorsOnly(envelope as never, deps.facts());
        if (!kept) return {};
        const id = typeof kept[0].event_id === 'string' ? kept[0].event_id : undefined;
        return Promise.resolve(base.send(kept)).then(
          (answer) => {
            if (id) deps.onSent?.(id, Number((answer as { statusCode?: unknown })?.statusCode) || 0);
            return answer;
          },
          (err) => {
            if (id) deps.onSent?.(id, 0);
            throw err;
          },
        );
      });
      pending.add(sent);
      void sent.finally(() => pending.delete(sent));
      return sent;
    },
    async flush(timeout) {
      await Promise.allSettled([...pending]);
      return base.flush(timeout);
    },
  };
}

export function errorReportOptions(deps: ErrorReportDeps) {
  return {
    dsn: deps.dsn,
    release: deps.facts().release,
    sendDefaultPii: false,
    sendClientReports: false,
    enableLogs: false,
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    beforeSendTransaction: () => null,
    beforeSend(event: unknown) {
      if (!deps.isEnabled()) return null;
      const id = (event as { event_id?: unknown } | null)?.event_id;
      const payload = typeof id === 'string' ? deps.healthPayloads?.get(id) : undefined;
      const whole = payload
        ? { ...(event as Record<string, unknown>), contexts: { ...((event as { contexts?: object }).contexts ?? {}), tars: payload } }
        : event;
      const report = toReport(whole, deps.facts());
      if (!report) return null;
      if (report.event_id && deps.preAdmitted?.has(report.event_id)) return report as never;
      if (!deps.budget.admit(reportFingerprint(report))) return null;
      return report as never;
    },
    transport: (options: never) => gated(deps.makeTransport(options), deps) as never,
  } as {
    dsn: string;
    release: string;
    sendDefaultPii: false;
    sendClientReports: false;
    enableLogs: false;
    maxBreadcrumbs: 0;
    tracesSampleRate?: undefined;
    tracesSampler?: undefined;
    beforeBreadcrumb: () => null;
    beforeSendTransaction: () => null;
    beforeSend: (event: unknown) => never | null;
    transport: (options: never) => never;
  };
}
