/**
 * A load pool (trace feature C3, 27/11): `~/.tars/load-pools/<pool>/tasks.jsonl` and `window.json`. Agents write them;
 * Tars only reads. This module is the pure part: every line validated (a refused line is listed as
 * `tasks.jsonl:<line>` with its reason, never dropped silently), the window's values checked one by one, and the
 * window's arrivals planned from its seed, so the same seed and pool give the same schedule.
 *
 * The format, one task a line:
 * - task_id (string, unique in the pool); project (an absolute path); repo (`owner/name`, or null for a project the
 *   owner allowed by name); base_commit (40 hex, which must already exist in the project: load-window.ts checks it);
 * - prompt (string, the first instruction); language (string or null); setup (strings, none by default); test_cmd
 *   (string or null); time_cap_min (whole, 10 to 120); expected_tools (strings, informational, none by default);
 * - harnesses (a list of the endpoint harnesses, or null for any); weight (a number, 0 or more); max_runs (whole, 1 or
 *   more, per window);
 * - split (train, heldout or eval); train_ok (a boolean, false unless the split is train); source and licence (string
 *   or null).
 * A field the format does not know is left out of the task, never a reason to refuse it.
 */

/** The harnesses a load agent may run: the endpoint harnesses (inference-endpoints.ts ENDPOINT_HARNESSES). */
export const LOAD_HARNESSES = ['codex', 'pi', 'qwen-code', 'opencode'] as const;
export type LoadHarness = typeof LOAD_HARNESSES[number];
export const LOAD_SPLITS = ['train', 'heldout', 'eval'] as const;
export type LoadSplit = typeof LOAD_SPLITS[number];

export interface LoadTask {
  /** Its line in tasks.jsonl, from 1. */
  line: number;
  task_id: string;
  project: string;
  repo: string | null;
  base_commit: string;
  prompt: string;
  language: string | null;
  setup: string[];
  test_cmd: string | null;
  time_cap_min: number;
  expected_tools: string[];
  harnesses: LoadHarness[] | null;
  weight: number;
  max_runs: number;
  split: LoadSplit;
  train_ok: boolean;
  source: string | null;
  licence: string | null;
}

/** A line or a value refused: where it is, and why. `line` 0 is the file as a whole; `key` a window.json value. */
export interface RefusedLine { file: 'tasks.jsonl' | 'window.json'; line: number; key?: string; reason: string }

export interface LoadWindowParams {
  rate_per_hour: number;
  distribution: 'poisson';
  seed: number;
  window_min: number;
  max_concurrent: number;
  initial_sessions: number;
  pick: 'weighted_without_replacement';
}

export const DEFAULT_WINDOW: LoadWindowParams = Object.freeze({
  rate_per_hour: 6, distribution: 'poisson', seed: 1, window_min: 60, max_concurrent: 3, initial_sessions: 0, pick: 'weighted_without_replacement',
}) as LoadWindowParams;

export const MAX_POOL_BYTES = 4 * 1024 * 1024;
export const MAX_LINE_BYTES = 64 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isWhole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');

/** A task from one parsed line, or the reason it is refused, naming the field. */
function taskOf(o: Record<string, unknown>, line: number): LoadTask | string {
  if (typeof o.task_id !== 'string' || !o.task_id.trim()) return 'task_id: a string that is not empty';
  if (typeof o.project !== 'string' || !(o.project.startsWith('/') || /^[A-Za-z]:[\\/]/.test(o.project))) return 'project: an absolute path';
  if (!(o.repo === null || (typeof o.repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(o.repo)))) return 'repo: owner/name, or null';
  if (typeof o.base_commit !== 'string' || !/^[0-9a-f]{40}$/.test(o.base_commit)) return 'base_commit: 40 hex characters';
  if (typeof o.prompt !== 'string' || !o.prompt.trim()) return 'prompt: a string that is not empty';
  if (o.language !== undefined && !strOrNull(o.language)) return 'language: a string, or null';
  if (o.setup !== undefined && !strings(o.setup)) return 'setup: a list of strings';
  if (o.test_cmd !== undefined && !strOrNull(o.test_cmd)) return 'test_cmd: a string, or null';
  if (!isWhole(o.time_cap_min) || o.time_cap_min < 10 || o.time_cap_min > 120) return 'time_cap_min: a whole number from 10 to 120';
  if (o.expected_tools !== undefined && !strings(o.expected_tools)) return 'expected_tools: a list of strings';
  if (o.harnesses !== null && !(Array.isArray(o.harnesses) && o.harnesses.length > 0 && o.harnesses.every(h => (LOAD_HARNESSES as readonly unknown[]).includes(h)))) {
    return `harnesses: a list of ${LOAD_HARNESSES.join(', ')}, or null for any`;
  }
  if (typeof o.weight !== 'number' || !Number.isFinite(o.weight) || o.weight < 0) return 'weight: a number, 0 or more';
  if (!isWhole(o.max_runs) || o.max_runs < 1) return 'max_runs: a whole number, 1 or more';
  if (!(LOAD_SPLITS as readonly unknown[]).includes(o.split)) return `split: ${LOAD_SPLITS.join(', ')}`;
  if (typeof o.train_ok !== 'boolean') return 'train_ok: true or false';
  if (o.train_ok && o.split !== 'train') return 'train_ok: false unless the split is train';
  if (o.source !== undefined && !strOrNull(o.source)) return 'source: a string, or null';
  if (o.licence !== undefined && !strOrNull(o.licence)) return 'licence: a string, or null';
  return {
    line, task_id: o.task_id, project: o.project, repo: o.repo as string | null, base_commit: o.base_commit, prompt: o.prompt,
    language: (o.language ?? null) as string | null, setup: (o.setup ?? []) as string[], test_cmd: (o.test_cmd ?? null) as string | null,
    time_cap_min: o.time_cap_min, expected_tools: (o.expected_tools ?? []) as string[], harnesses: o.harnesses as LoadHarness[] | null,
    weight: o.weight, max_runs: o.max_runs, split: o.split as LoadSplit, train_ok: o.train_ok,
    source: (o.source ?? null) as string | null, licence: (o.licence ?? null) as string | null,
  };
}

/** Every line of tasks.jsonl: the tasks taken, and every line refused with its number and its reason. */
export function parseTasksJsonl(text: string): { tasks: LoadTask[]; refused: RefusedLine[] } {
  if (Buffer.byteLength(text) > MAX_POOL_BYTES) {
    return { tasks: [], refused: [{ file: 'tasks.jsonl', line: 0, reason: `the file is over ${MAX_POOL_BYTES / 1024 / 1024} MiB: nothing of it is read` }] };
  }
  const tasks: LoadTask[] = [];
  const refused: RefusedLine[] = [];
  const seen = new Map<string, number>();
  text.split('\n').forEach((raw, i) => {
    const line = i + 1;
    const content = raw.replace(/\r$/, '');
    if (!content.trim()) return;
    const refuse = (reason: string) => { refused.push({ file: 'tasks.jsonl', line, reason }); };
    if (Buffer.byteLength(content) > MAX_LINE_BYTES) { refuse(`the line is over ${MAX_LINE_BYTES / 1024} KiB`); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { refuse('not JSON'); return; }
    if (!isObject(parsed)) { refuse('not a JSON object'); return; }
    const t = taskOf(parsed, line);
    if (typeof t === 'string') { refuse(t); return; }
    const earlier = seen.get(t.task_id);
    if (earlier !== undefined) { refuse(`task_id ${t.task_id} is already on line ${earlier}`); return; }
    seen.set(t.task_id, line);
    tasks.push(t);
  });
  return { tasks, refused };
}

/** window.json: each value outside its rule refused as `window.json:<key>`, its default kept. No file: the defaults. */
export function parseWindowJson(text: string | undefined): { window: LoadWindowParams; refused: RefusedLine[] } {
  const window: LoadWindowParams = { ...DEFAULT_WINDOW };
  const refused: RefusedLine[] = [];
  if (text === undefined) return { window, refused };
  let o: unknown;
  try { o = JSON.parse(text); } catch { o = undefined; }
  if (!isObject(o)) return { window, refused: [{ file: 'window.json', line: 0, reason: 'not a JSON object: the defaults hold' }] };
  return checkWindow(o);
}

/** A window's values, as a pool or the owner gives them: each one outside its rule refused, its default kept. */
export function checkWindow(o: Record<string, unknown>): { window: LoadWindowParams; refused: RefusedLine[] } {
  const window: LoadWindowParams = { ...DEFAULT_WINDOW };
  const refused: RefusedLine[] = [];
  const take = <K extends keyof LoadWindowParams>(key: K, ok: (v: unknown) => boolean, rule: string) => {
    if (o[key] === undefined) return;
    if (ok(o[key])) window[key] = o[key] as LoadWindowParams[K];
    else refused.push({ file: 'window.json', line: 0, key, reason: `${key}: ${rule}` });
  };
  take('rate_per_hour', v => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 3600, 'a number above 0, 3600 at most');
  take('distribution', v => v === 'poisson', 'poisson, the one Tars runs');
  take('seed', v => isWhole(v) && v >= 0 && v <= 0xffffffff, 'a whole number from 0 to 4294967295');
  take('window_min', v => isWhole(v) && v >= 1 && v <= 1440, 'whole minutes from 1 to 1440');
  take('max_concurrent', v => isWhole(v) && v >= 1 && v <= 16, 'a whole number from 1 to 16');
  take('pick', v => v === 'weighted_without_replacement', 'weighted_without_replacement, the one Tars runs');
  take('initial_sessions', v => isWhole(v) && v >= 0 && v <= window.max_concurrent, 'a whole number from 0 to max_concurrent');
  return { window, refused };
}

/** A seeded generator, uniform in [0, 1): mulberry32. */
function generator(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PlannedArrival { n: number; offsetMs: number; taskId: string }

/**
 * The window's arrivals, from its seed: its initial sessions at the start, then a Poisson process at its rate
 * (exponential gaps) until the window's end, each arrival's task picked by weight without replacement: a task runs at
 * most its max_runs times, and one of weight 0 never. The plan ends early once every run is used.
 */
export function planArrivals(window: LoadWindowParams, tasks: LoadTask[]): PlannedArrival[] {
  const rng = generator(window.seed);
  const left = tasks.map(t => ({ id: t.task_id, weight: t.weight, runs: t.max_runs }));
  const pick = (): string | undefined => {
    const open = left.filter(t => t.runs > 0 && t.weight > 0);
    const total = open.reduce((s, t) => s + t.weight, 0);
    if (total <= 0) return undefined;
    let u = rng() * total;
    for (const t of open) {
      u -= t.weight;
      if (u < 0) { t.runs--; return t.id; }
    }
    const last = open[open.length - 1];
    last.runs--;
    return last.id;
  };
  const out: PlannedArrival[] = [];
  const end = window.window_min * 60_000;
  for (let i = 0; i < window.initial_sessions; i++) {
    const id = pick();
    if (id === undefined) return out;
    out.push({ n: out.length + 1, offsetMs: 0, taskId: id });
  }
  const perMs = window.rate_per_hour / 3_600_000;
  for (let t = 0; ;) {
    t += -Math.log(1 - rng()) / perMs;
    const at = Math.floor(t);
    if (at >= end) break;
    const id = pick();
    if (id === undefined) break;
    out.push({ n: out.length + 1, offsetMs: at, taskId: id });
  }
  return out;
}

/** About how many arrivals a window brings: its initial sessions and its rate over its length. */
export function expectedArrivals(window: LoadWindowParams): number {
  return window.initial_sessions + Math.round((window.rate_per_hour * window.window_min) / 60);
}
