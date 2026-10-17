import { describe, it, expect } from 'vitest';
import { toReport, reportFingerprint, keepErrorsOnly, healthEvent, type ReportFacts } from '../../../electron/services/error-reports/report';
import type { HealthSample } from '../../../electron/services/health/samples';

/**
 * The two reports of Tars's health (2.0.3, monitoring options 1 and 2), through the error-reports module, its switch and
 * its budget: "Tars ended abruptly" at the launch after a run that did not quit, and the diagnostic the user sends.
 * Each is an error event of a kind of its own, whose numbers ride in `contexts.tars`, rebuilt field by field.
 *
 * How it fails, written before the code:
 * 1. A health report loses its numbers on the way: toReport keeps nothing of contexts.tars.
 * 2. Something else than numbers rides in contexts.tars: a path or a name as the version, a message as the crash type,
 *    a key no one listed, a sample with a string in it.
 * 3. Any other error event carries a contexts.tars of its own (code that set one, a renderer's event), or one forged
 *    with the kind tag but not the kind's own exception.
 * 4. A diagnostic carries more samples than 24 hours hold (a file grown by hand).
 * 5. Two abrupt ends of one day fingerprint apart (by their uptime), so the budget sends each: it must be once a day
 *    per kind, as for any one error.
 * 6. The transport strips the numbers, so the report leaves empty; or lets them through on any other event.
 */

const facts: ReportFacts = {
  installId: '0f8fad5b-d9cb-469f-a165-70867728950e', release: 'tars@2.0.3', home: '/Users/someone', host: 'MacBook-Pro-de-Someone',
  os: { name: 'macOS', version: '15.4' }, electron: '44.0.0',
};
const sample = (at: number, over: Partial<HealthSample> = {}): HealthSample => ({
  at, heapUsedMb: 120, heapTotalMb: 180, rssMb: 400, loopP50Ms: 11, loopP95Ms: 30,
  slowest: [{ channel: 'usage:tasks', ms: 118 }], agents: 45, running: 3, page: '/usage', ...over,
});
const T = Date.UTC(2026, 9, 15, 12, 0, 0);
const abrupt = (over: Record<string, unknown> = {}) => healthEvent('abrupt-end', {
  previousVersion: '2.0.2', uptimeMinutes: 312, crashType: 'EXC_BREAKPOINT', lastSample: sample(T), ...over,
});

describe('the reports of Tars\'s health', () => {
  it('1. an abrupt end keeps its numbers, and nothing of this machine', () => {
    const report = toReport(abrupt(), facts)!;
    expect(report.tags).toEqual({ process: 'main', kind: 'abrupt-end' });
    expect(report.contexts.tars).toEqual({ previousVersion: '2.0.2', uptimeMinutes: 312, crashType: 'EXC_BREAKPOINT', lastSample: sample(T) });
    expect(report.exception.values[0].type).toBe('TarsEndedAbruptly');
    expect(JSON.stringify(report)).not.toMatch(/someone|MacBook/i);
  });

  it('1. a diagnostic keeps its samples', () => {
    const report = toReport(healthEvent('diagnostic', { samples: [sample(T - 300_000), sample(T)] }), facts)!;
    expect(report.tags.kind).toBe('diagnostic');
    expect(report.contexts.tars).toEqual({ samples: [sample(T - 300_000), sample(T)] });
  });

  it('2. only numbers and the listed words ride in contexts.tars', () => {
    const report = toReport(abrupt({
      previousVersion: '/Users/someone/Tars.app', crashType: 'segfault in /Users/someone/x', note: 'hello',
      lastSample: { ...sample(T), page: 'the conversation' },
    }), facts)!;
    expect(report.contexts.tars).toEqual({ previousVersion: null, uptimeMinutes: 312, crashType: null, lastSample: { ...sample(T), page: null } });
    expect(toReport(abrupt({ uptimeMinutes: 'long' }), facts)!.contexts.tars).toMatchObject({ uptimeMinutes: null });
  });

  it('3. no other error event carries a contexts.tars', () => {
    const plain = { exception: { values: [{ type: 'TypeError', value: 'x is undefined' }] }, contexts: { tars: { uptimeMinutes: 3 } }, tags: { kind: 'abrupt-end' } };
    const report = toReport(plain, facts)!;
    expect(report.contexts.tars).toBeUndefined();
    expect(report.tags).toEqual({ process: 'main' });
  });

  it('4. a diagnostic holds 24 hours of samples at most', () => {
    const many = Array.from({ length: 1_000 }, (_, i) => sample(T - i * 60_000));
    const report = toReport(healthEvent('diagnostic', { samples: many }), facts)!;
    expect((report.contexts.tars as { samples: unknown[] }).samples.length).toBeLessThanOrEqual(24 * 12 + 12);
  });

  it('5. abrupt ends fingerprint as one, diagnostics as another', () => {
    const a = reportFingerprint(toReport(abrupt({ uptimeMinutes: 1 }), facts)!);
    const b = reportFingerprint(toReport(abrupt({ uptimeMinutes: 900, crashType: null }), facts)!);
    const d = reportFingerprint(toReport(healthEvent('diagnostic', { samples: [sample(T)] }), facts)!);
    expect(a).toBe(b);
    expect(d).not.toBe(a);
  });

  it('6. the transport keeps the numbers of a health report, and of it only', () => {
    const envelope = [{ event_id: 'a'.repeat(32) }, [[{ type: 'event' }, abrupt()], [{ type: 'event' }, { exception: { values: [{ type: 'Error', value: 'x' }] }, contexts: { tars: { a: 1 } } }]]];
    const kept = keepErrorsOnly(envelope as never, facts)!;
    const [first, second] = kept[1].map(([, payload]) => payload as { contexts: Record<string, unknown> });
    expect(first.contexts.tars).toMatchObject({ uptimeMinutes: 312 });
    expect(second.contexts.tars).toBeUndefined();
  });
});
