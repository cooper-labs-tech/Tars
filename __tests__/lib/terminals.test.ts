import { describe, expect, it } from 'vitest';
import { terminalsFigure, terminalsNotice } from '@/lib/terminals';
import { wakeRefusedReason } from '@/app/agents/constants';

/**
 * The machine's terminals on Resources · Heavy runs (2.0.6, item 1, on PR 553's FleetResources.terminals at 848a307ee;
 * frames `Resources (2.0.6) · heavy runs, terminals left` and `· terminals left · states`), and an agent that could
 * not start for lack of one (frame `Agent cannot start · no terminal left (2.0.6)`).
 *
 * How it can fail, written before the code:
 * 1. the figure is not the machine's count in use, or its line does not name the limit, the terminals Tars holds and
 *    the ones it has open, as the frame writes them;
 * 2. Tars's own count unknown (tars null) reads as a number, or open unknown as "for undefined open";
 * 3. near full (nearFull) or full does not take the waiting or the error tone, or full is not main's rule: one free
 *    on macOS, where a start opens two, none on Linux;
 * 4. the notice is not main's own text (terminals.notice) as it comes, or shows when main gives none;
 * 5. Windows (null, no pool) reads as not read, or a machine whose pool cannot be read reads as "not counted";
 * 6. before the first reading (undefined) a figure shows, or a notice;
 * 7. an asleep agent whose wake was refused (asleep, with `error`, PR 553's second round) shows no reason, or an
 *    agent at work shows an old one.
 */

const SAID = 'main says this, word for word';
const pool = (inUse: number, tars: number | null, open?: number, notice: string | null = null, max = 511) => ({ inUse, max, tars, open, nearFull: inUse / max >= 0.8, notice });

describe('the terminals figure', () => {
  it('is the machine\'s count in use, its line naming the limit, Tars\'s and its open ones (1)', () => {
    expect(terminalsFigure(pool(137, 42, 42), 'darwin')).toEqual({ value: '137', sub: 'of 511 on this machine · Tars holds 42 for 42 open', tone: undefined });
  });

  it('says only what is known (2)', () => {
    expect(terminalsFigure(pool(137, null), 'linux').sub).toBe('of 511 on this machine');
    expect(terminalsFigure(pool(137, 42), 'linux').sub).toBe('of 511 on this machine · Tars holds 42');
    expect(terminalsFigure(pool(511, 505, 0), 'darwin').sub).toBe('of 511 on this machine · Tars holds 505, 0 open');
  });

  it('takes the waiting tone near full and the error tone when full, by main\'s rule for each system (3)', () => {
    expect(terminalsFigure(pool(410, 400, 400), 'darwin').tone).toBe('waiting');
    expect(terminalsFigure(pool(510, 18, 18), 'darwin').tone).toBe('error');
    expect(terminalsFigure(pool(509, 18, 18), 'darwin').tone).toBe('waiting');
    expect(terminalsFigure(pool(510, 18, 18), 'linux').tone).toBe('waiting');
    expect(terminalsFigure(pool(511, 18, 18), 'linux').tone).toBe('error');
    expect(terminalsFigure(pool(300, 18, 18), 'darwin').tone).toBeUndefined();
  });

  it('reads not counted on Windows and not read where the pool cannot be read (5, 6)', () => {
    expect(terminalsFigure(null, 'win32')).toEqual({ value: 'not counted', sub: 'No shared pool on Windows: each terminal is its own', tone: undefined });
    expect(terminalsFigure(null, 'darwin')).toEqual({ value: 'not read', sub: 'cannot be read on this machine', tone: undefined });
    expect(terminalsFigure(undefined, 'darwin')).toEqual({ value: 'not read', sub: 'with the health samples', tone: undefined });
  });
});

describe('the terminals notice', () => {
  it('is main\'s own text, as it comes, in the tone of the figure (4)', () => {
    expect(terminalsNotice(pool(410, 400, 400, SAID), 'darwin')).toEqual({ tone: 'waiting', text: SAID });
    expect(terminalsNotice(pool(510, 18, 18, SAID), 'darwin')).toEqual({ tone: 'error', text: SAID });
  });

  it('says nothing when main says nothing, on Windows or before a reading (4, 6)', () => {
    expect(terminalsNotice(pool(300, 18, 18), 'darwin')).toBeNull();
    expect(terminalsNotice(null, 'win32')).toBeNull();
    expect(terminalsNotice(undefined, 'darwin')).toBeNull();
  });
});

describe('an asleep agent whose wake was refused', () => {
  it('says why under its word (7)', () => {
    expect(wakeRefusedReason({ status: 'asleep', error: ` ${SAID} ` })).toBe(SAID);
  });

  it('says nothing asleep without a reason, nor in any other status (7)', () => {
    expect(wakeRefusedReason({ status: 'asleep', error: undefined })).toBeNull();
    expect(wakeRefusedReason({ status: 'asleep', error: '  ' })).toBeNull();
    expect(wakeRefusedReason({ status: 'running', error: SAID })).toBeNull();
    expect(wakeRefusedReason({ status: 'error', error: SAID })).toBeNull();
  });
});
