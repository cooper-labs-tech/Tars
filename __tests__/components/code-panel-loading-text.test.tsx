import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Highlight } from 'prism-react-renderer';
import { mount, settle, deferred, elements, ofType, type Mount } from './hook-runtime';
import CodePanel from '../../src/components/AgentWorld/CodePanel';
import { BrandSpinner } from '../../src/components/ui';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * The agent window's code panel waits on a flag, not on a word (1.7.4).
 *
 * It used to put the string 'Loading...' in the file content while a file was
 * read, and showed the mark whenever the content equalled that string. So a
 * file whose text is exactly `Loading...` spun forever, and "Copy" during a
 * read copied the word. The wait is its own state now; the content is only
 * ever what the file holds.
 */

const g = globalThis as unknown as { window?: unknown };
const PROJECT = '/tmp/project';
const FILE = `${PROJECT}/notes/loading.txt`;

describe('CodePanel reading a file', () => {
  let read: ReturnType<typeof deferred<{ content: string; error?: string }>>;
  let writeText: ReturnType<typeof vi.fn>;
  let panel: Mount<ReturnType<typeof CodePanel>>;

  beforeEach(async () => {
    read = deferred();
    writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    g.window = {
      electronAPI: {
        project: { listFiles: vi.fn(async () => ({ success: true, files: ['README.md', 'notes/loading.txt'] })) },
        review: { diff: vi.fn(async () => ({ success: false })) },
        fs: { readTextFile: vi.fn(() => read.promise) },
      },
    };
    panel = mount(() => CodePanel({ projectPath: PROJECT }));
    await settle();
  });

  afterEach(() => {
    panel.unmount();
    delete g.window;
    vi.unstubAllGlobals();
  });

  // The file tree hands each file to the panel's own loader through onSelect.
  const select = (path: string) => {
    const tree = elements(panel.result).find(el => typeof el.props.onSelect === 'function');
    if (!tree) throw new Error('no file tree rendered');
    return (tree.props.onSelect as (p: string) => Promise<void>)(path);
  };
  const waitingMarks = () => ofType(panel.result, BrandSpinner).filter(el => el.props.label === 'Loading file');
  const shown = () => ofType(panel.result, Highlight).map(el => el.props.code);
  const copy = () => {
    const button = ofType(panel.result, 'button').find(b => b.props.title === 'Copy code with file path');
    if (!button) throw new Error('no copy button');
    return (button.props.onClick as () => Promise<void>)();
  };

  it('waits on the mark while the file is read, with nothing in the content to copy', async () => {
    void select(FILE);
    expect(waitingMarks()).toHaveLength(1);
    expect(shown()).toEqual([]);
    await copy();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('shows a file whose whole text is "Loading..." as that text, and stops waiting', async () => {
    const done = select(FILE);
    read.resolve({ content: 'Loading...' });
    await done;
    await settle();
    expect(waitingMarks()).toEqual([]);
    expect(shown()).toEqual(['Loading...']);
    await copy();
    expect(writeText).toHaveBeenCalledWith(`// ${FILE}\nLoading...`);
  });

  it('stops waiting when the read fails, and says so', async () => {
    const done = select(FILE);
    read.resolve({ content: '', error: 'EACCES: permission denied' });
    await done;
    await settle();
    expect(waitingMarks()).toEqual([]);
    expect(shown()).toEqual(['EACCES: permission denied']);
  });
});
