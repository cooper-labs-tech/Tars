import type { FleetResources } from '@/types/electron';

/**
 * The machine's terminals as Resources · Heavy runs says them (2.0.6, item 1; frames `Resources (2.0.6) · heavy runs,
 * terminals left` and `· terminals left · states`), on PR 553's FleetResources.terminals: in use of the limit, the PTY
 * masters Tars holds and the terminals it has open. The notice's words are main's own (electron/core/pty-pool.ts:
 * the 503 code no_terminal and the 80 % warning), so the window and the orchestrators read the same sentence. Its
 * failures: __tests__/lib/terminals.test.ts.
 */

export type Terminals = NonNullable<FleetResources['terminals']>;
type Tone = 'waiting' | 'error';

/** Where PR 553 refuses a spawn: the pool full, less the one a spawn needs. */
const isFull = (t: Terminals) => t.inUse >= t.max - 1;

const tone = (t: Terminals): Tone | undefined => (isFull(t) ? 'error' : t.nearFull ? 'waiting' : undefined);

/** The figure, its line and its tone. Undefined: not read yet; null: Windows' ConPTY has no pool, or it cannot be read. */
export function terminalsFigure(t: Terminals | null | undefined, platform: string): { value: string; sub: string; tone: Tone | undefined } {
  if (t === undefined) return { value: 'not read', sub: 'with the health samples', tone: undefined };
  if (t === null) {
    return platform === 'win32'
      ? { value: 'not counted', sub: 'No shared pool on Windows: each terminal is its own', tone: undefined }
      : { value: 'not read', sub: 'cannot be read on this machine', tone: undefined };
  }
  const base = `of ${t.max} on this machine`;
  if (t.tars === null) return { value: String(t.inUse), sub: base, tone: tone(t) };
  const held = t.open === undefined ? `Tars holds ${t.tars}` : t.tars > t.open ? `Tars holds ${t.tars}, ${t.open} open` : `Tars holds ${t.tars} for ${t.open} open`;
  return { value: String(t.inUse), sub: `${base} · ${held}`, tone: tone(t) };
}

const STOP_ONE = ' Stop an agent that does not need its terminal, or close terminals in other apps, to free one.';

/** main's withRemedy: a restart only for the masters Tars holds with no terminal open for them. */
function withRemedy(head: string, { tars, open }: Terminals, stop: string): string {
  if (tars === null) return `${head}.${stop}`;
  if (open !== undefined && tars > open) {
    return `${head}, ${tars} of them held by Tars, which has ${open} open. The other ${tars - open} were never given back, and only a restart of Tars frees them: it stops every agent.`;
  }
  return `${head}, ${tars} of them held by Tars${open === undefined ? '' : ` for its ${open} open terminals`}.${stop}`;
}

/** The notice above the figures: full, the 503's words; near full, the warning's; else none. */
export function terminalsNotice(t: Terminals | null | undefined): { tone: Tone; text: string } | null {
  if (!t) return null;
  if (isFull(t)) return { tone: 'error', text: withRemedy(`No terminal can be opened on this machine: ${t.inUse} of ${t.max} are in use`, t, STOP_ONE) };
  if (t.nearFull) {
    return { tone: 'waiting', text: withRemedy(`The machine's terminals are filling: ${t.inUse} of ${t.max} are in use`, t, ` At ${t.max} no agent can start: stop the agents that do not need their terminal.`) };
  }
  return null;
}
