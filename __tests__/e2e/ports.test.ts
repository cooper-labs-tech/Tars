import { afterEach, describe, expect, it } from 'vitest';
import { apiPort, DEV_PORT, WORKER_PORT_STRIDE } from '../../e2e/ports.mjs';

/**
 * The E2E specs' ports when a run's spec files run side by side in several workers (E2E_WORKERS,
 * playwright.config.ts; reports/faster-e2e.md, 29/10).
 *
 * How it fails, written before the code:
 * W1. Two workers give the same port for the same base: 51 bases are shared by two or more spec files, and two such
 *     files running at once start two apps on one port.
 * W2. The runner itself (no TEST_PARALLEL_INDEX: the config, the global setup) is moved, or a worker's index is read
 *     from anything but a whole number.
 * W3. `next dev` moves with the worker: every worker must open the run's one renderer.
 * W4. The shift is narrower than the bases' spread (31302 to 31974), so worker 1's lowest port meets worker 0's highest.
 */
const before = process.env.TEST_PARALLEL_INDEX;
afterEach(() => {
  if (before === undefined) delete process.env.TEST_PARALLEL_INDEX;
  else process.env.TEST_PARALLEL_INDEX = before;
});
const inWorker = (index: string | undefined, base: number) => {
  if (index === undefined) delete process.env.TEST_PARALLEL_INDEX;
  else process.env.TEST_PARALLEL_INDEX = index;
  return Number(apiPort(base));
};

describe('the ports of a run in several workers', () => {
  it('W1. a base shared by two spec files is two ports in two workers', () => {
    expect(inWorker('1', 31455)).not.toBe(inWorker('0', 31455));
    expect(inWorker('3', 31455) - inWorker('0', 31455)).toBe(3 * WORKER_PORT_STRIDE);
  });

  it('W2. the runner is not moved, and an index that is not a whole number moves nothing', () => {
    const runner = inWorker(undefined, 31455);
    expect(inWorker('0', 31455)).toBe(runner);
    for (const odd of ['', '-1', '1.5', 'x']) expect(inWorker(odd, 31455), JSON.stringify(odd)).toBe(runner);
  });

  it('W3. next dev is the run\'s one, whatever the worker', () => {
    process.env.TEST_PARALLEL_INDEX = '2';
    expect(DEV_PORT).toBe(3100 + (Number(process.env.E2E_PORT_OFFSET) || 0));
  });

  it('W4. worker 1\'s lowest port is above worker 0\'s highest', () => {
    expect(inWorker('1', 31302)).toBeGreaterThan(inWorker('0', 31974));
  });
});
