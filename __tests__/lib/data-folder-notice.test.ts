import '../setup/home-guard';
import { describe, expect, it } from 'vitest';
import { dataFolderNotice } from '@/lib/data-folder-notice';

/**
 * What the data folder notice says (2.0.4, the window's part of #473's app:dataDir; frame `Data folder · notice`).
 * Written before the code. Every way it can be wrong:
 * 1. A start that needs no notice shows one: moved, already, none, a did main may add later, no answer at all.
 * 2. Two data folders: main's notice not said, or said with the home folder spelled out where the frame writes ~,
 *    a path outside the home folder changed, or the notice made up when main gave none.
 * 3. A move refused: the folder Tars goes on from or the one it would move to named wrong (a Windows path read with
 *    the wrong separator), or the move said to have happened.
 * 4. A notice that is not a string (an older main) breaking the line.
 */

describe('dataFolderNotice', () => {
  it('says nothing for a start that settled on its folder (1)', () => {
    for (const did of ['moved', 'already', 'none', 'something-new']) {
      expect(dataFolderNotice({ dir: '/Users/you/.tars', did }), did).toBeNull();
    }
    expect(dataFolderNotice(null)).toBeNull();
    expect(dataFolderNotice(undefined)).toBeNull();
  });

  it("says main's notice of two folders, the home folder as ~, another path whole (2)", () => {
    expect(dataFolderNotice({
      dir: '/Users/you/.dorothy',
      did: 'both',
      notice: 'Two data folders: /Users/you/.tars and /Users/you/.dorothy, which are not the same folder. Tars uses /Users/you/.dorothy, which holds its agents and settings, and has left /Users/you/.tars as it is.',
    })).toBe('Two data folders: ~/.tars and ~/.dorothy, which are not the same folder. Tars uses ~/.dorothy, which holds its agents and settings, and has left ~/.tars as it is.');
    expect(dataFolderNotice({ dir: '/srv/tars/.tars', did: 'both', notice: 'Two data folders: /srv/tars/.tars and /srv/tars/.dorothy.' }))
      .toBe('Two data folders: /srv/tars/.tars and /srv/tars/.dorothy.');
    expect(dataFolderNotice({ dir: 'C:\\Users\\you\\.tars', did: 'both', notice: 'Tars uses C:\\Users\\you\\.tars, and has left C:\\Users\\you\\.dorothy as it is.' }))
      .toBe('Tars uses ~\\.tars, and has left ~\\.dorothy as it is.');
  });

  it('says which folder Tars runs on when main gave two folders without a notice (2)', () => {
    expect(dataFolderNotice({ dir: '/Users/you/.tars', did: 'both' })).toBe('Two data folders stand: Tars runs on ~/.tars.');
  });

  it('says a refused move, the folder it goes on from and the one it would move to (3)', () => {
    expect(dataFolderNotice({ dir: '/Users/you/.dorothy', did: 'kept-old' }))
      .toBe('Tars could not move ~/.dorothy to ~/.tars: it goes on from ~/.dorothy, and tries again at each start.');
    expect(dataFolderNotice({ dir: 'C:\\Users\\you\\.dorothy', did: 'kept-old' }))
      .toBe('Tars could not move ~\\.dorothy to ~\\.tars: it goes on from ~\\.dorothy, and tries again at each start.');
  });

  it('takes a notice that is not a string for none (4)', () => {
    expect(dataFolderNotice({ dir: '/Users/you/.tars', did: 'both', notice: 42 as unknown as string })).toBe('Two data folders stand: Tars runs on ~/.tars.');
  });
});
