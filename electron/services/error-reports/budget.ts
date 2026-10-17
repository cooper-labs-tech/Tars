import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { writeAtomicSync } from '../../utils/secret-file';

/**
 * How many error reports leave one installation: the same error at most once
 * in 24 hours, and at most 20 reports in any 24 hours. Kept on disk, so a Tars
 * that crashes and is restarted in a loop does not send 20 more at each start,
 * and with it the random id the installation is known by.
 *
 * The file (`~/.dorothy/error-reports.json`, 0600) holds that id, when each
 * report of the last 24 hours left, and the fingerprint of each error sent in
 * that time with when. A file that cannot be read is started again, never a
 * reason to throw.
 */

export const REPORTS_PER_DAY = 20;
const DAY_MS = 24 * 3_600_000;

interface BudgetFile {
  installId: string;
  /** When each report of the last 24 hours left, in ms. */
  sent: number[];
  /** fingerprint -> when it last left, in ms. */
  seen: Record<string, number>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ReportBudget {
  private state: BudgetFile;

  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    this.state = this.read();
  }

  get installId(): string {
    return this.state.installId;
  }

  /** Whether a report of this error may leave now; counts it when it may. */
  admit(fingerprint: string): boolean {
    return this.admitAt(fingerprint) !== null;
  }

  /** As admit(), with the moment it was counted at, which refund() takes; null when it may not leave. */
  admitAt(fingerprint: string): number | null {
    const now = this.now();
    const since = now - DAY_MS;
    this.state.sent = this.state.sent.filter(t => t > since);
    for (const [fp, t] of Object.entries(this.state.seen)) if (t <= since) delete this.state.seen[fp];
    if (this.state.sent.length >= REPORTS_PER_DAY || fingerprint in this.state.seen) return null;
    this.state.sent.push(now);
    this.state.seen[fingerprint] = now;
    this.write();
    return now;
  }

  /**
   * Gives back what admit() counted, for a report that did not leave after
   * all (Sentry could not be reached): a diagnostic the user tries again
   * after a failure must not read "already sent".
   */
  refund(fingerprint: string, at: number): void {
    const index = this.state.sent.lastIndexOf(at);
    if (index !== -1) this.state.sent.splice(index, 1);
    if (this.state.seen[fingerprint] === at) delete this.state.seen[fingerprint];
    this.write();
  }

  private read(): BudgetFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<BudgetFile>;
      if (typeof parsed.installId === 'string' && UUID.test(parsed.installId)) {
        const seen: Record<string, number> = {};
        for (const [fp, t] of Object.entries(parsed.seen ?? {})) if (typeof t === 'number') seen[fp] = t;
        return {
          installId: parsed.installId,
          sent: Array.isArray(parsed.sent) ? parsed.sent.filter((t): t is number => typeof t === 'number') : [],
          seen,
        };
      }
    } catch { /* none yet, or unreadable: a new one */ }
    this.state = { installId: randomUUID(), sent: [], seen: {} };
    this.write();
    return this.state;
  }

  private write(): void {
    try {
      writeAtomicSync(this.file, JSON.stringify(this.state), 0o600);
    } catch (err) {
      console.warn('[error-reports] could not record the reports sent:', err instanceof Error ? err.message : err);
    }
  }
}
