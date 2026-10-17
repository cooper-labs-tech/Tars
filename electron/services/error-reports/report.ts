import { createHash } from 'crypto';
import { redactSecrets } from '../../utils/redact-secrets';
import { homeUserName, windowsHomeSpellings } from '../../platform/home-spellings';
import { cleanSample, HEALTH_KEEP_MS, type HealthSample } from '../health/samples';

/**
 * What an error report carries, and nothing else (Sentry, step 1; the
 * design's part B1).
 *
 * The report is built from the SDK's event, field by field, instead of being
 * scrubbed from it: what the SDK or a renderer adds (breadcrumbs, the request,
 * the user, extra, tags, contexts, the host name, source lines, local
 * variables) is never copied, so it cannot leak by being forgotten in a list
 * of things to remove. The fields, which the privacy text is written from:
 *
 *   event_id, timestamp, platform, level
 *   release              `tars@<version>`
 *   exception.values[]   at most 5 (an error and its causes):
 *     type, value        the message: home folder as ~, machine name as <host>, secrets masked, 1000 characters at most
 *     mechanism          { type, handled }
 *     stacktrace.frames  the 50 nearest the throw: filename (home as ~), function, lineno, colno, in_app
 *   tags.process         main or renderer
 *   tags.kind            abrupt-end or diagnostic, for the two reports of Tars's health only
 *   contexts.os          { name, version }
 *   contexts.tars        for those two only, numbers rebuilt field by field (healthEvent, below)
 *   contexts.runtime     { name: Electron, version }
 *   user.id              a random id for the installation, made on this machine
 */

export interface ReportFacts {
  /** Random, per installation (budget.ts). */
  installId: string;
  /** `tars@1.9.1` */
  release: string;
  home: string;
  /** os.hostname(): masked wherever it appears, never sent. */
  host: string;
  os: { name: string; version: string };
  electron: string;
}

interface ReportFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
}

interface ReportException {
  type?: string;
  value?: string;
  mechanism?: { type: string; handled?: boolean };
  stacktrace?: { frames: ReportFrame[] };
}

export interface ErrorReport {
  event_id?: string;
  timestamp?: number;
  platform?: string;
  level?: string;
  release: string;
  exception: { values: ReportException[] };
  tags: { process: 'main' | 'renderer'; kind?: HealthKind };
  contexts: { os: { name: string; version: string }; runtime: { name: 'Electron'; version: string }; tars?: AbruptEnd | Diagnostic };
  user: { id: string };
}

const MAX_VALUE = 1_000;
const MAX_FRAMES = 50;
const MAX_EXCEPTIONS = 5;
const LEVELS = new Set(['fatal', 'error', 'warning']);

type Loose = Record<string, unknown>;
const record = (v: unknown): Loose | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? v as Loose : undefined);
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Not part of a name: what may follow the home folder, or stand around the user name. */
const NAME_END = '(?![A-Za-z0-9._-])';
const NAME_START = '(?<![A-Za-z0-9._-])';

/**
 * A path or a message, with this machine taken out: the home folder as ~, in
 * any case and URL-encoded once or twice, the machine's name as <host>, the
 * user name alone as <user>, a macOS temp folder as <tmp>, secrets masked.
 * The home folder is rewritten wherever the name ends, not only before `/` or
 * a space: `cwd /Users/x, exit 1` and `/Users/x;` left the whole path (the
 * Audit's gate of #221).
 */
type Machine = Pick<ReportFacts, 'home' | 'host'>;
const MIN_SHORT_HOST = 6;

function scrub(value: string, machine: Machine): string {
  const { home, host } = machine;
  let out = value.replace(/file:\/\//g, '');
  // The home folder first: it may itself be under a temp folder. /var is
  // /private/var on macOS, so a folder there reaches an error by either name.
  // The longer name goes first, or /private<home> would read /private~.
  if (home && home !== '/') {
    const homes = [...new Set([home, home.startsWith('/private/') ? home.slice('/private'.length) : `/private${home}`, ...windowsHomeSpellings(home)])]
      .sort((a, b) => b.length - a.length);
    for (const h of homes) {
      for (const slash of ['/', '%2F', '%252F']) {
        out = out.replace(new RegExp(`${escape(h.replace(/\//g, slash))}${NAME_END}`, 'gi'), '~');
      }
    }
  }
  // The machine's name often carries its owner's ("MacBook-Pro-de-JeanBrasse"),
  // inside a word the user name rule below does not look into. Its first
  // label alone is masked only when long enough to be a name: "Mac" of
  // "Mac.lan" would take the word out of every message.
  if (host) {
    const short = host.split('.')[0];
    for (const name of new Set([host, short.length >= MIN_SHORT_HOST ? short : host])) {
      if (name.length >= 3) out = out.replace(new RegExp(`${NAME_START}${escape(name)}${NAME_END}`, 'gi'), '<host>');
    }
  }
  if (home && home !== '/') {
    const user = homeUserName(home);
    if (user.length >= 3) out = out.replace(new RegExp(`${NAME_START}${escape(user)}${NAME_END}`, 'gi'), '<user>');
  }
  out = out.replace(/(?:\/private)?\/var\/folders\/(?:[^/\s]+\/){1,2}T(?=\/)/g, '<tmp>');
  return redactSecrets(out);
}

/**
 * Quoted text that reads as words (a space in it, more than 24 characters),
 * replaced by its length: the way a conversation or a prompt reaches an
 * error's message is quoted, as the input JSON.parse or a CLI choked on. A
 * quoted name ('discord.js', "agent:start") is kept: it says where it broke.
 */
const QUOTED = [/"([^"\n]*)"/g, /'([^'\n]*)'/g, /`([^`\n]*)`/g, /\u201C([^\u201D\n]*)\u201D/g];
function quotedWords(value: string): string {
  let out = value;
  for (const pattern of QUOTED) {
    out = out.replace(pattern, (match, inner: string) => {
      const length = Array.from(inner).length;
      if (length <= 24 || !/\s/.test(inner)) return match;
      return `${match[0]}[${length} characters]${match[match.length - 1]}`;
    });
  }
  return out;
}

function cut(value: string, limit: number): string {
  const chars = Array.from(value);
  return chars.length > limit ? `${chars.slice(0, limit - 3).join('')}...` : value;
}

function toFrame(raw: unknown, machine: Machine): ReportFrame {
  const f = record(raw) ?? {};
  const frame: ReportFrame = {};
  const file = text(f.filename) ?? text(f.abs_path);
  if (file !== undefined) frame.filename = cut(scrub(file, machine), 300);
  const fn = text(f.function);
  if (fn !== undefined) frame.function = cut(scrub(fn, machine), 200);
  if (count(f.lineno) !== undefined) frame.lineno = count(f.lineno);
  if (count(f.colno) !== undefined) frame.colno = count(f.colno);
  if (typeof f.in_app === 'boolean') frame.in_app = f.in_app;
  return frame;
}

function toException(raw: unknown, machine: Machine): ReportException | undefined {
  const e = record(raw);
  if (!e) return undefined;
  const out: ReportException = {};
  const type = text(e.type);
  if (type !== undefined) out.type = cut(scrub(type, machine), 200);
  const value = text(e.value);
  if (value !== undefined) out.value = cut(scrub(quotedWords(value), machine), MAX_VALUE);
  const mechanism = record(e.mechanism);
  if (mechanism && typeof mechanism.type === 'string') {
    out.mechanism = { type: cut(mechanism.type, 100) };
    if (typeof mechanism.handled === 'boolean') out.mechanism.handled = mechanism.handled;
  }
  const frames = record(e.stacktrace)?.frames;
  if (Array.isArray(frames) && frames.length > 0) {
    out.stacktrace = { frames: frames.slice(-MAX_FRAMES).map(frame => toFrame(frame, machine)) };
  }
  return out.type !== undefined || out.value !== undefined ? out : undefined;
}

/**
 * The report for an SDK event, or null for anything that is not an error:
 * a message, a transaction, an event with no exception.
 */
export function toReport(raw: unknown, facts: ReportFacts): ErrorReport | null {
  const event = record(raw);
  if (!event || (event.type !== undefined && event.type !== 'event')) return null;
  const values = record(event.exception)?.values;
  if (!Array.isArray(values)) return null;
  // Sentry lists the causes first and the error thrown last: the last five are kept.
  const exceptions = values.slice(-MAX_EXCEPTIONS).map(v => toException(v, facts)).filter((v): v is ReportException => !!v);
  if (exceptions.length === 0) return null;

  const tags = record(event.tags);
  const process = tags?.process === 'renderer' || tags?.['event.process'] === 'renderer' ? 'renderer' : 'main';
  const report: ErrorReport = {
    release: facts.release,
    exception: { values: exceptions },
    tags: { process },
    contexts: {
      os: { name: facts.os.name, version: facts.os.version },
      runtime: { name: 'Electron', version: facts.electron },
    },
    user: { id: facts.installId },
  };
  const kind = healthKindOf(tags?.kind, exceptions);
  if (kind) {
    report.tags.kind = kind;
    report.contexts.tars = kind === 'abrupt-end' ? cleanAbruptEnd(record(record(event.contexts)?.tars)) : cleanDiagnostic(record(record(event.contexts)?.tars));
  }
  const id = text(event.event_id);
  if (id && /^[0-9a-f]{32}$/.test(id)) report.event_id = id;
  if (count(event.timestamp) !== undefined) report.timestamp = count(event.timestamp);
  const platform = text(event.platform);
  if (platform === 'node' || platform === 'javascript') report.platform = platform;
  const level = text(event.level);
  if (level && LEVELS.has(level)) report.level = level;
  return report;
}

/** The same error, whatever its event id, its time or its process: its types, messages and in-app frames. */
export function reportFingerprint(report: ErrorReport): string {
  const shape = report.exception.values.map(e => [
    e.type, e.value,
    (e.stacktrace?.frames ?? []).filter(f => f.in_app !== false).slice(-5).map(f => `${f.filename}:${f.function}:${f.lineno}`),
  ]);
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

type EnvelopeItem = [Loose, unknown];
type Envelope = [Loose, EnvelopeItem[]];

/**
 * The envelope as it may reach the network: its error events, rebuilt as
 * reports, and no other item (sessions, attachments, replays, feedback, spans,
 * profiles, logs, client reports). @sentry/electron hands some of a
 * renderer's envelopes straight to the transport, past beforeSend: this is
 * where those are stopped. Null when nothing is left to send.
 */
export function keepErrorsOnly(envelope: Envelope, facts: ReportFacts): Envelope | null {
  const [header, items] = envelope;
  const kept: EnvelopeItem[] = [];
  for (const [itemHeader, payload] of items ?? []) {
    if (itemHeader?.type !== 'event') continue;
    const report = toReport(payload, facts);
    if (report) kept.push([{ type: 'event' }, report]);
  }
  if (kept.length === 0) return null;
  const outHeader: Loose = {};
  if (typeof header?.event_id === 'string') outHeader.event_id = header.event_id;
  if (typeof header?.sent_at === 'string') outHeader.sent_at = header.sent_at;
  const sdk = record(header?.sdk);
  if (sdk && typeof sdk.name === 'string' && typeof sdk.version === 'string') outHeader.sdk = { name: sdk.name, version: sdk.version };
  return [outHeader, kept];
}


/* ── The two reports of Tars's health (2.0.3, monitoring options 1 and 2) ── */

export type HealthKind = 'abrupt-end' | 'diagnostic';

/** At the launch after a run that did not quit: services/health/abrupt-end.ts. */
export interface AbruptEnd {
  /** The version that ran, `2.0.2`; null when the record did not say. */
  previousVersion: string | null;
  uptimeMinutes: number | null;
  /** What the OS named the crash, without memory (macOS: the .ips report's exception type); null when it gave none. */
  crashType: string | null;
  lastSample: HealthSample | null;
}

/** What the user sends with "Send a diagnostic": the last 24 hours of samples. */
export interface Diagnostic {
  samples: HealthSample[];
}

const HEALTH_TYPES: Record<HealthKind, string> = { 'abrupt-end': 'TarsEndedAbruptly', diagnostic: 'TarsDiagnostic' };
const HEALTH_VALUES: Record<HealthKind, string> = { 'abrupt-end': 'Tars ended without quitting', diagnostic: 'A diagnostic the user sent' };
const HEALTH_MECHANISM = 'tars-health';
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,4}(?:-[0-9A-Za-z.]{1,20})?$/;
const CRASH_TYPE = /^[A-Z][A-Z0-9_]{2,39}$/;
/** 24 hours at one sample every 5 minutes, and an hour's margin. */
const MAX_SAMPLES = HEALTH_KEEP_MS / 300_000 + 12;

/**
 * The SDK event of a health report. Its kind is told by its tag AND its own
 * exception type and mechanism: a tag alone, set on any other error, gives
 * it no contexts.tars. Its message is fixed, so the budget counts each kind
 * as one error: once a day.
 */
export function healthEvent(kind: HealthKind, payload: Record<string, unknown>): Record<string, unknown> {
  // No `type`: the SDK runs beforeSend only for an event without one (an error).
  return {
    platform: 'node',
    level: kind === 'abrupt-end' ? 'error' : 'warning',
    timestamp: Date.now() / 1000,
    exception: { values: [{ type: HEALTH_TYPES[kind], value: HEALTH_VALUES[kind], mechanism: { type: HEALTH_MECHANISM, handled: true } }] },
    tags: { kind },
    contexts: { tars: payload },
  };
}

function healthKindOf(tag: unknown, exceptions: ReportException[]): HealthKind | null {
  if (tag !== 'abrupt-end' && tag !== 'diagnostic') return null;
  const [only] = exceptions;
  return exceptions.length === 1 && only.type === HEALTH_TYPES[tag] && only.mechanism?.type === HEALTH_MECHANISM ? tag : null;
}

function cleanAbruptEnd(raw: Loose | undefined): AbruptEnd {
  const version = text(raw?.previousVersion);
  const crash = text(raw?.crashType);
  const uptime = count(raw?.uptimeMinutes);
  return {
    previousVersion: version && VERSION.test(version) ? version : null,
    uptimeMinutes: uptime !== undefined && uptime >= 0 ? Math.round(uptime) : null,
    crashType: crash && CRASH_TYPE.test(crash) ? crash : null,
    lastSample: cleanSample(raw?.lastSample),
  };
}

function cleanDiagnostic(raw: Loose | undefined): Diagnostic {
  const samples = (Array.isArray(raw?.samples) ? raw.samples : [])
    .map(cleanSample).filter((s): s is HealthSample => !!s);
  return { samples: samples.slice(-MAX_SAMPLES) };
}
