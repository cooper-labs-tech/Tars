// A batch (API.md § 5), checked field by field before anything reaches the database. Unknown
// fields are refused rather than dropped, so a client that sends something it should not (a path,
// an environment) is told at once instead of having it silently stored or silently lost.
type Spec =
  | { t: 'id' } | { t: 'hash' } | { t: 'hex'; max: number } | { t: 'str'; max: number }
  | { t: 'int' } | { t: 'bool' } | { t: 'enum'; of: readonly string[] } | { t: 'obj'; maxBytes: number }
  | { t: 'msgs' } | { t: 'count'; max: number } | { t: 'env' } | { t: 'events' }
  | { t: 'shape'; shape: Shape } | { t: 'list'; shape: Shape; max: number }
  | { t: 're'; re: RegExp; desc: string } | { t: 'bytes'; max: number } | { t: 'cancel' };
type Shape = { [k: string]: Spec & { req?: boolean } };

// A session's environment (27/11, the machine and the system at its start, exact values): these keys and no other,
// so that nothing a client should not send (a serial number, a host name, a user name) can ride along. Each value
// may be null, "the client could not read it" (the client's contract, the architecture Tars runs as included).
type EnvValue = { kind: 'str'; max: number } | { kind: 'int'; min: number; max: number } | { kind: 'bool' };
const ENV_TEXT: EnvValue = { kind: 'str', max: 200 };
const ENVIRONMENT: Record<string, EnvValue> = {
  osName: ENV_TEXT, osVersion: ENV_TEXT, kernel: ENV_TEXT, arch: ENV_TEXT, machineModel: ENV_TEXT, chip: ENV_TEXT,
  cpuCores: { kind: 'int', min: 0, max: 4096 }, ramBytes: { kind: 'int', min: 0, max: Number.MAX_SAFE_INTEGER },
  tarsVersion: ENV_TEXT, tarsArch: { kind: 'str', max: 40 }, locale: ENV_TEXT, timeZone: ENV_TEXT,
  utcOffsetMinutes: { kind: 'int', min: -840, max: 840 }, onBattery: { kind: 'bool' },
};
const EVENT_KINDS = ['sleep', 'wake', 'battery', 'ac'];
const MAX_EVENTS = 10_000;

function checkEnvironment(v: unknown): string | null {
  if (!isObj(v)) return 'an object of the environment keys';
  for (const [k, x] of Object.entries(v)) {
    const s = ENVIRONMENT[k];
    if (!s) return `an object of the environment keys (${k} is not one)`;
    if (x === null) continue;
    if (s.kind === 'str' && !(typeof x === 'string' && x.length <= s.max)) return `${k}: a string of at most ${s.max}, or null`;
    if (s.kind === 'int' && !(Number.isSafeInteger(x) && (x as number) >= s.min && (x as number) <= s.max)) return `${k}: an integer from ${s.min} to ${s.max}, or null`;
    if (s.kind === 'bool' && typeof x !== 'boolean') return `${k}: a boolean, or null`;
  }
  return null;
}

function checkEvents(v: unknown): string | null {
  if (!Array.isArray(v) || v.length > MAX_EVENTS) return `an array of at most ${MAX_EVENTS} events`;
  for (const e of v) {
    if (!isObj(e) || Object.keys(e).some((k) => k !== 'at' && k !== 'kind') || !isInt(e.at) || !EVENT_KINDS.includes(e.kind as string)) {
      return `items of {at: int, kind: ${EVENT_KINDS.join('|')}}`;
    }
  }
  return null;
}

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HASH = /^[0-9a-f]{64}$/;
const r = <S extends Spec>(s: S) => ({ ...s, req: true });
const id = { t: 'id' } as const, hash = { t: 'hash' } as const, int = { t: 'int' } as const, bool = { t: 'bool' } as const;
const str = (max: number) => ({ t: 'str', max }) as const;

// The client's closed lists and forms (27/11, its authors' contract): a kind is one of its list, never free text.
const TASK_REF = { t: 're', re: /^t-[0-9a-f]{8}$/, desc: 't- and 8 lowercase hex' } as const;
const COMMIT = { t: 're', re: /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, desc: '40 or 64 lowercase hex' } as const;
const enumOf = (...of: string[]) => ({ t: 'enum', of }) as const;
// What started a session: its trigger and how it came, by kind, and what is known of its task and its commit.
const START: Shape = {
  trigger: r(enumOf('owner', 'task', 'channel', 'restart', 'start', 'wake', 'redelegation', 'unknown')),
  via: enumOf('window', 'chat', 'api', 'telegram', 'slack', 'discord', 'hermes', 'relay', 'settings', 'asked', 'tars'),
  taskRef: TASK_REF, taskId: str(200), requesterAgentId: str(200), queuedAt: int, handedAt: int, firstRequestAt: int,
  commit: COMMIT, branch: { t: 'bytes', max: 255 }, redelegatedFrom: str(64),
};
// A task that left the agent's queue never to start, while the session ran.
const LOST_DEMAND: Shape = {
  kind: r(enumOf('queue_drop')), ref: r(TASK_REF), queuedAt: r(int), at: r(int),
  reason: r(enumOf('cancelled', 'taken_back', 'dropped_with_stop', 'queue_cleared', 'agent_removed', 'not_handed_again')),
};
// Who cut a request (by), why (a cause of that `by`'s own list), when, and how many bytes had reached the harness.
const CANCEL_CAUSES: Record<string, readonly string[]> = {
  harness: ['esc', 'ctrl_c', 'cli_interrupt', 'abandoned_while_held', 'unknown'],
  tars: ['stop', 'restart', 'sleep', 'remove', 'quit', 'replace'],
  proxy: ['hold_ceiling'],
  endpoint: ['stream_cut'],
};
const CANCEL: Shape = { by: r(enumOf(...Object.keys(CANCEL_CAUSES))), cause: r(str(40)), at: r(int), deliveredBytes: r(int) };

const SESSION: Shape = {
  sessionId: r(id), agentId: id, projectKey: { t: 'hex', max: 64 }, harness: r(str(40)), harnessVersion: str(40),
  nativeSessionId: str(128), endpointKey: str(64), endpointName: str(60), model: r(str(200)), startedAt: r(int), endedAt: int,
  finalStatus: r({ t: 'enum', of: ['open', 'done', 'failed', 'abandoned'] }), turnCount: r(int), requestCount: r(int),
  tokensIn: r(int), tokensCached: r(int), tokensOut: r(int), mixed: bool, unknownTurns: int, outcome: { t: 'obj', maxBytes: 16 * 1024 },
  environment: { t: 'env' }, events: { t: 'events' },
  start: { t: 'shape', shape: START }, lostDemand: { t: 'list', shape: LOST_DEMAND, max: 1000 },
};
const TURN: Shape = {
  turnId: r(id), sessionId: r(id), index: r(int), startedAt: r(int), endedAt: int, gapBeforeMs: int, requestCount: r(int),
  toolCallCount: r(int), toolErrorCount: r(int), toolMs: int, modelMs: int, tokensIn: r(int), tokensCached: r(int), tokensOut: r(int),
  finalStatus: str(20), finalFinishReason: str(40), author: str(40), authorDetail: str(128), taskRef: TASK_REF,
};
const REQUEST: Shape = {
  requestId: r(id), sessionId: r(id), turnId: r(id), seq: r(int), upstreamRequestId: str(128),
  surface: r({ t: 'enum', of: ['openai_chat', 'openai_responses', 'anthropic_messages', 'models', 'other'] }),
  modelRequested: str(200), modelServed: str(200), params: { t: 'obj', maxBytes: 16 * 1024 }, toolsHash: hash, startedAt: r(int),
  ttftMs: int, totalMs: int, tokensIn: int, tokensCached: int, tokensOut: int, status: int, error: str(2000), finishReason: str(40),
  streamed: bool, side: bool, reqBytes: int, respBytes: int, messages: r({ t: 'msgs' }),
  liveSessions: { t: 'count', max: 1_000_000 }, cancel: { t: 'cancel' },
};
const MESSAGE: Shape = {
  hash: r(hash), role: r({ t: 'enum', of: ['system', 'user', 'assistant', 'tool', 'developer'] }), createdAt: r(int), size: r(int),
  toolCallCount: int, hasThinking: bool,
};
const LIMITS = { sessions: 1000, turns: 10_000, requests: 10_000, messages: 50_000 } as const;
const MESSAGE_REFS = 10_000;

export interface MessageRef { position: number; hash: string; direction: 'input' | 'output' }
// The fields the server reads by name; every other field is passed to Postgres as JSON, as checked.
type Fields = Record<string, unknown>;
export type SessionRow = Fields & { sessionId: string };
export type TurnRow = Fields & { turnId: string; sessionId: string };
export type RequestRow = Fields & { requestId: string; sessionId: string; toolsHash?: string; messages: MessageRef[] };
export type MessageRow = Fields & { hash: string };
export interface Batch { sessions: SessionRow[]; turns: TurnRow[]; requests: RequestRow[]; messages: MessageRow[] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

function checkValue(s: Spec, v: unknown): string | null {
  switch (s.t) {
    case 'id': return typeof v === 'string' && ID.test(v) ? null : 'an id ([A-Za-z0-9._:-]{1,128})';
    case 'hash': return typeof v === 'string' && HASH.test(v) ? null : 'a sha256 (64 lowercase hex)';
    case 'hex': return typeof v === 'string' && v.length <= s.max && /^[0-9a-f]+$/.test(v) ? null : `lowercase hex, at most ${s.max}`;
    case 'str': return typeof v === 'string' && v.length <= s.max ? null : `a string of at most ${s.max}`;
    case 'int': return isInt(v) ? null : 'an integer >= 0';
    case 'bool': return typeof v === 'boolean' ? null : 'a boolean';
    case 'enum': return typeof v === 'string' && s.of.includes(v) ? null : `one of ${s.of.join(', ')}`;
    case 'obj': return isObj(v) && Buffer.byteLength(JSON.stringify(v)) <= s.maxBytes ? null : `an object of at most ${s.maxBytes} bytes`;
    case 'count': return isInt(v) && (v as number) <= s.max ? null : `an integer from 0 to ${s.max}`;
    case 'env': return checkEnvironment(v);
    case 'events': return checkEvents(v);
    case 're': return typeof v === 'string' && s.re.test(v) ? null : s.desc;
    case 'bytes': return typeof v === 'string' && Buffer.byteLength(v) <= s.max ? null : `a string of at most ${s.max} bytes`;
    case 'cancel': {
      const e = checkShape(v, CANCEL);
      if (e) return e;
      const c = v as { by: string; cause: string };
      return CANCEL_CAUSES[c.by]!.includes(c.cause) ? null : `cause must be one of ${c.by}'s: ${CANCEL_CAUSES[c.by]!.join(', ')}`;
    }
    case 'shape': return checkShape(v, s.shape);
    case 'list': {
      if (!Array.isArray(v) || v.length > s.max) return `an array of at most ${s.max}`;
      for (const item of v) {
        const e = checkShape(item, s.shape);
        if (e) return `items: ${e}`;
      }
      return null;
    }
    case 'msgs': {
      if (!Array.isArray(v) || v.length > MESSAGE_REFS) return `an array of at most ${MESSAGE_REFS}`;
      for (const m of v) {
        if (!isObj(m) || Object.keys(m).some((k) => !['position', 'hash', 'direction'].includes(k))) return 'items of {position, hash, direction}';
        if (!isInt(m.position) || typeof m.hash !== 'string' || !HASH.test(m.hash) || (m.direction !== 'input' && m.direction !== 'output')) {
          return 'items of {position: int, hash: sha256, direction: input|output}';
        }
      }
      return null;
    }
  }
}

/** An object of the shape's keys and no other, each of its type, the required ones present: the first fault, or null. */
function checkShape(v: unknown, shape: Shape): string | null {
  if (!isObj(v)) return `an object of ${Object.keys(shape).join(', ')}`;
  for (const k of Object.keys(v)) if (!(k in shape) && v[k] !== undefined) return `${k} is not a key of it`;
  for (const [k, s] of Object.entries(shape)) {
    const x = v[k];
    if (x === undefined || x === null) {
      if (s.req) return `${k} is required`;
      continue;
    }
    const e = checkValue(s, x);
    if (e) return `${k} must be ${e}`;
  }
  return null;
}

function checkRow(kind: string, i: number, row: unknown, shape: Shape, errors: string[]) {
  if (!isObj(row)) { errors.push(`${kind}[${i}]: not an object`); return; }
  for (const k of Object.keys(row)) if (!(k in shape)) errors.push(`${kind}[${i}].${k}: unknown field`);
  for (const [k, s] of Object.entries(shape)) {
    const v = row[k];
    if (v === undefined || v === null) {
      if (s.req) errors.push(`${kind}[${i}].${k}: required`);
      continue;
    }
    const e = checkValue(s, v);
    if (e) errors.push(`${kind}[${i}].${k}: must be ${e}`);
  }
}

export function validateBatch(body: unknown): Batch | { errors: string[] } {
  if (!isObj(body)) return { errors: ['the body must be a JSON object'] };
  if (body.schema !== 1) return { errors: ['schema: must be 1'] };
  const errors: string[] = [];
  for (const k of Object.keys(body)) if (!['schema', 'sessions', 'turns', 'requests', 'messages'].includes(k)) errors.push(`${k}: unknown field`);
  const out: Batch = { sessions: [], turns: [], requests: [], messages: [] };
  const shapes = { sessions: SESSION, turns: TURN, requests: REQUEST, messages: MESSAGE } as const;
  for (const kind of Object.keys(shapes) as (keyof Batch)[]) {
    const v = body[kind];
    if (v === undefined) continue;
    if (!Array.isArray(v)) { errors.push(`${kind}: must be an array`); continue; }
    if (v.length > LIMITS[kind]) { errors.push(`${kind}: at most ${LIMITS[kind]} per batch`); continue; }
    v.forEach((row, i) => checkRow(kind, i, row, shapes[kind], errors));
    (out as unknown as Record<string, unknown[]>)[kind] = v;
    if (errors.length > 50) break;
  }
  return errors.length ? { errors: errors.slice(0, 50) } : out;
}
