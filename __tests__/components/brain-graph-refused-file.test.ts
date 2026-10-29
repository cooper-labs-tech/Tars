import { describe, it, expect } from 'vitest';
import { openedFile } from '../../src/components/Memory/AgentKnowledgeGraph';

/**
 * A file the Brain graph's panel opens, from memory:read-file or fs:read-text-file's answer: `{ content }`, or
 * `{ content: '', error }` for a file Tars does not read (PR 565: a FIFO, a link, a file past 1 MiB; or missing, or
 * out of the allowed roots). The panel offers what it read as an editable draft, and save writes the draft over the
 * file. The Audit's finding on #565: the graph ignored `error`, so a refused file opened as an empty draft that could
 * be saved over the real one. Written before the code, as the ways it can fail:
 * 1. a refused file opens as a draft that can be saved: an empty one, or one holding the refusal's words;
 * 2. the refusal is not said, or not in main's own words;
 * 3. no answer at all (no bridge) reads as an empty file that can be saved over;
 * 4. a file read whole is refused, or its content altered;
 * 5. an empty file that was read (no error) is refused: it is a real file, and may be written.
 */

describe('a file the graph opens', () => {
  const REFUSED = 'Not a regular file, or past 1 MB: Tars does not read it.';

  it('a refused file is no draft: nothing to save over the real one (1)', () => {
    const opened = openedFile({ content: '', error: REFUSED });
    expect(opened.refused).not.toBeNull();
    expect(opened.content).toBe('');
  });

  it("says why in main's own words (2)", () => {
    expect(openedFile({ content: '', error: REFUSED }).refused).toBe(REFUSED);
    expect(openedFile({ content: '', error: 'Path outside allowed roots' }).refused).toBe('Path outside allowed roots');
  });

  it('no answer is no file read (3)', () => {
    expect(openedFile(undefined).refused).not.toBeNull();
    expect(openedFile(null).refused).not.toBeNull();
  });

  it('a file read whole opens as it is (4)', () => {
    expect(openedFile({ content: '# Memory\n\n- a fact\n' })).toEqual({ content: '# Memory\n\n- a fact\n', refused: null });
  });

  it('an empty file that was read stays a file (5)', () => {
    expect(openedFile({ content: '' })).toEqual({ content: '', refused: null });
  });
});
