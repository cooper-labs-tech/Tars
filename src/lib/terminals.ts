import type { FleetResources } from '@/types/electron';

/**
 * The machine's terminals as Resources · Heavy runs says them (2.0.6, item 1; frames `Resources (2.0.6) · heavy runs,
 * terminals left` and `· terminals left · states`), on PR 553's FleetResources.terminals: in use of the limit, the PTY
 * masters Tars holds and the terminals it has open. The words of the notice are main's own (`notice`, built in
 * electron/core/pty-pool.ts), shown as they come: one copy of the sentence, so the window and the orchestrators never
 * read two. Its failures: __tests__/lib/terminals.test.ts.
 */

export type Terminals = NonNullable<FleetResources['terminals']>;
type Tone = 'waiting' | 'error';

/** Full by main's rule (pty-pool.ts's isFull): a start opens two on macOS, so one free is full there; none on Linux. */
const isFull = (t: Terminals, platform: string) => t.max - t.inUse < (platform === 'darwin' ? 2 : 1);

const tone = (t: Terminals, platform: string): Tone | undefined => (isFull(t, platform) ? 'error' : t.nearFull ? 'waiting' : undefined);

/** The figure, its line and its tone. Undefined: not read yet; null: Windows' ConPTY has no pool, or it cannot be read. */
export function terminalsFigure(t: Terminals | null | undefined, platform: string): { value: string; sub: string; tone: Tone | undefined } {
  if (t === undefined) return { value: 'not read', sub: 'with the health samples', tone: undefined };
  if (t === null) {
    return platform === 'win32'
      ? { value: 'not counted', sub: 'No shared pool on Windows: each terminal is its own', tone: undefined }
      : { value: 'not read', sub: 'cannot be read on this machine', tone: undefined };
  }
  const base = `of ${t.max} on this machine`;
  if (t.tars === null) return { value: String(t.inUse), sub: base, tone: tone(t, platform) };
  const held = t.open === undefined ? `Tars holds ${t.tars}` : t.tars > t.open ? `Tars holds ${t.tars}, ${t.open} open` : `Tars holds ${t.tars} for ${t.open} open`;
  return { value: String(t.inUse), sub: `${base} · ${held}`, tone: tone(t, platform) };
}

/** The notice above the figures: main's text when it gives one (full, or past 80 %), in the figure's tone. */
export function terminalsNotice(t: Terminals | null | undefined, platform: string): { tone: Tone; text: string } | null {
  if (!t?.notice) return null;
  return { tone: tone(t, platform) ?? 'waiting', text: t.notice };
}
