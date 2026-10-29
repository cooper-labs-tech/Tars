import { describe, expect, it } from 'vitest';
import { terminalsFigure, terminalsNotice } from '@/lib/terminals';

/**
 * The machine's terminals on Resources · Heavy runs (2.0.6, item 1, on #553's FleetResources.terminals; frames
 * `Resources (2.0.6) · heavy runs, terminals left` and `· terminals left · states`).
 *
 * How it can fail, written before the code:
 * 1. the figure is not the machine's count in use, or its line does not name the limit, the terminals Tars holds and
 *    the ones it has open, as the frame writes them;
 * 2. Tars's own count unknown (tars null) reads as a number, or open unknown as "for undefined open";
 * 3. near full (past 80 %, nearFull) or full (inUse at the limit, less one, where #553 refuses a spawn) does not take
 *    the waiting or the error tone;
 * 4. the notice's words are not #553's: the warning's for near full, the 503's (code no_terminal) when full, its
 *    second form only when Tars holds more than it has open, and without the Tars part when its count is unknown;
 * 5. Windows (null, no pool) reads as not read, or a machine whose pool cannot be read reads as "not counted";
 * 6. before the first reading (undefined) a figure shows, or a notice;
 * 7. a restart is offered when Tars holds no more than it has open.
 */

const pool = (inUse: number, tars: number | null, open?: number, max = 511) => ({ inUse, max, tars, open, nearFull: inUse / max >= 0.8 });

describe('the terminals figure', () => {
  it('is the machine\'s count in use, its line naming the limit, Tars\'s and its open ones (1)', () => {
    expect(terminalsFigure(pool(137, 42, 42), 'darwin')).toEqual({ value: '137', sub: 'of 511 on this machine · Tars holds 42 for 42 open', tone: undefined });
  });

  it('says only what is known (2)', () => {
    expect(terminalsFigure(pool(137, null), 'linux').sub).toBe('of 511 on this machine');
    expect(terminalsFigure(pool(137, 42), 'linux').sub).toBe('of 511 on this machine · Tars holds 42');
    expect(terminalsFigure(pool(511, 505, 0), 'darwin').sub).toBe('of 511 on this machine · Tars holds 505, 0 open');
  });

  it('takes the waiting tone near full and the error tone when full (3)', () => {
    expect(terminalsFigure(pool(410, 400, 400), 'darwin').tone).toBe('waiting');
    expect(terminalsFigure(pool(510, 18, 18), 'darwin').tone).toBe('error');
    expect(terminalsFigure(pool(511, 18, 18), 'darwin').tone).toBe('error');
    expect(terminalsFigure(pool(300, 18, 18), 'darwin').tone).toBeUndefined();
  });

  it('reads not counted on Windows and not read where the pool cannot be read (5, 6)', () => {
    expect(terminalsFigure(null, 'win32')).toEqual({ value: 'not counted', sub: 'No shared pool on Windows: each terminal is its own', tone: undefined });
    expect(terminalsFigure(null, 'darwin')).toEqual({ value: 'not read', sub: 'cannot be read on this machine', tone: undefined });
    expect(terminalsFigure(undefined, 'darwin')).toEqual({ value: 'not read', sub: 'with the health samples', tone: undefined });
  });
});

describe('the terminals notice', () => {
  it('says the warning\'s words near full (4)', () => {
    expect(terminalsNotice(pool(410, 400, 400))).toEqual({
      tone: 'waiting',
      text: "The machine's terminals are filling: 410 of 511 are in use, 400 of them held by Tars for its 400 open terminals. At 511 no agent can start: stop the agents that do not need their terminal.",
    });
  });

  it('says the 503\'s words when full, the restart only for a leak (4, 7)', () => {
    expect(terminalsNotice(pool(511, 18, 18))).toEqual({
      tone: 'error',
      text: 'No terminal can be opened on this machine: 511 of 511 are in use, 18 of them held by Tars for its 18 open terminals. Stop an agent that does not need its terminal, or close terminals in other apps, to free one.',
    });
    expect(terminalsNotice(pool(511, 505, 0))?.text).toBe(
      'No terminal can be opened on this machine: 511 of 511 are in use, 505 of them held by Tars, which has 0 open. The other 505 were never given back, and only a restart of Tars frees them: it stops every agent.',
    );
    expect(terminalsNotice(pool(511, null))?.text).toBe(
      'No terminal can be opened on this machine: 511 of 511 are in use. Stop an agent that does not need its terminal, or close terminals in other apps, to free one.',
    );
    expect(terminalsNotice(pool(511, 18, 18))?.text).not.toContain('restart');
  });

  it('says nothing under 80 %, on Windows or before a reading (6)', () => {
    expect(terminalsNotice(pool(300, 18, 18))).toBeNull();
    expect(terminalsNotice(null)).toBeNull();
    expect(terminalsNotice(undefined)).toBeNull();
  });
});
