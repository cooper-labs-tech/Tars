/**
 * The ports an E2E run takes, and where its artefacts go.
 *
 * Every port moves together by E2E_PORT_OFFSET: `next dev` listens on
 * 3100 + offset and each suite's app on its own API port + offset. Two runs
 * on the same machine, each with its own offset, never meet; with the
 * variable unset, nothing moves from the ports the suites always had. An
 * offset that is not a whole number is refused rather than read as 0, which
 * would put the run on another run's ports.
 *
 * Read by playwright.config.ts, the global setup and every spec, so the
 * server the config starts and the URL the specs open are the same one.
 */

function readOffset() {
  const raw = process.env.E2E_PORT_OFFSET;
  if (raw === undefined || raw === '') return 0;
  if (!/^\d+$/.test(raw) || Number(raw) > 20_000) {
    throw new Error(`E2E_PORT_OFFSET must be a whole number from 0 to 20000, not ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

export const PORT_OFFSET = readOffset();

/** Where `next dev` listens for this run. */
export const DEV_PORT = 3100 + PORT_OFFSET;

/** The renderer every spec opens: DOROTHY_DEV_URL when the caller set one, else this run's `next dev`. */
export const DEV_URL = process.env.DOROTHY_DEV_URL || `http://localhost:${DEV_PORT}`;

/**
 * How far each worker of a run moves the API ports (E2E_WORKERS, playwright.config.ts): the specs' bases span about
 * 700 (31302 to 31974), and 51 of them are shared by two or more spec files, so two workers 1,000 apart never meet.
 * `next dev` is one for the run and does not move. A run with N workers takes offset to offset + (N - 1) x 1,000 + 700:
 * two runs at once need offsets that far apart.
 */
export const WORKER_PORT_STRIDE = 1_000;

/** This process's worker of the run (TEST_PARALLEL_INDEX, set by Playwright in each worker); 0 in the runner. */
function readWorkerIndex() {
  const raw = process.env.TEST_PARALLEL_INDEX;
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 0;
}

/** A suite's API port for this run: its own base, moved by the offset and by this process's worker. */
export function apiPort(base) {
  return String(base + PORT_OFFSET + WORKER_PORT_STRIDE * readWorkerIndex());
}
