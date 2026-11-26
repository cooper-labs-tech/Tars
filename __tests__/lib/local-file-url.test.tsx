import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { localFileUrl } from '../../src/lib/local-file-url';
import { SimpleMarkdown } from '../../src/components/VaultView/components/MarkdownRenderer';
import DocumentViewer from '../../src/components/VaultView/components/DocumentViewer';
import type { VaultAttachmentElectron, VaultDocumentElectron } from '../../src/types/electron';

/**
 * A vault note's local picture and an attachment's link, when the window knows no API port of its own.
 *
 * localFileUrl (src/lib/local-file-url.ts) builds `http://127.0.0.1:<electronAPI.apiPort>/api/local-file?path=...`,
 * and gives null when the window was told no port: a window main did not open, or a preload with no apiPort. The
 * null branch is the one that keeps a picture from being asked of another port, 31415 above all, where the user's
 * other Tars may answer (QA's finding on #651, and the Audit's Info there: that branch had no test).
 *
 * What would be wrong, each asserted below:
 * 1. a URL on some other port when the window knows none (no window, no electronAPI, apiPort null, apiPort 0);
 * 2. the URL on the wrong port when the window knows its own;
 * 3. a note's local picture given a source anyway, 31415 or other, when no port is known (it shows its alt text, as a
 *    missing picture does);
 * 4. an attachment's row given an address anyway when no port is known (it stays a row, with no link);
 * 5. with a port known, the picture's source or the row's link on another port.
 * Shown on a mutant of localFileUrl that falls back to 31415 when no port is known: 1, 3 and 4 red.
 */

const PORT = 31499;
const PICTURE = '/Users/qa/notes/chart.png';
const ATTACHED = '/Users/qa/.tars/vault/attachments/report.pdf';

const DOCUMENT: VaultDocumentElectron = {
  id: 'd1', title: 'A note', content: `Before.\n\n![chart](${PICTURE})\n\nAfter.`, folder_id: null, author: 'qa', agent_id: null,
  tags: '[]', created_at: '2026-11-26T08:00:00.000Z', updated_at: '2026-11-26T08:00:00.000Z',
};
const ATTACHMENT: VaultAttachmentElectron = {
  id: 'a1', document_id: 'd1', filename: 'report.pdf', filepath: ATTACHED, mimetype: 'application/pdf', size: 1024,
  created_at: '2026-11-26T08:00:00.000Z',
};

/** The window as a test makes it: electronAPI with the given apiPort, or none at all. */
function windowWith(electronAPI: Record<string, unknown> | undefined): void {
  vi.stubGlobal('window', electronAPI === undefined ? {} : { electronAPI });
}

const viewer = () => renderToStaticMarkup(
  <DocumentViewer document={DOCUMENT} attachments={[ATTACHMENT]} onBack={() => {}} onEdit={() => {}} onDelete={() => {}} />,
);
/** The attachment's own anchor: the tag that carries its title. */
const attachmentAnchor = (markup: string) => markup.match(/<a\b[^>]*title="Open report\.pdf"[^>]*>/)?.[0] ?? '';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('localFileUrl, with no API port known (1)', () => {
  it('gives null with no window at all', () => {
    expect(localFileUrl(PICTURE)).toBeNull();
  });
  it('gives null with no electronAPI, with apiPort null, and with apiPort 0', () => {
    windowWith(undefined);
    expect(localFileUrl(PICTURE)).toBeNull();
    windowWith({});
    expect(localFileUrl(PICTURE)).toBeNull();
    windowWith({ apiPort: null });
    expect(localFileUrl(PICTURE)).toBeNull();
    windowWith({ apiPort: 0 });
    expect(localFileUrl(PICTURE)).toBeNull();
  });
});

describe('localFileUrl, with the window\'s own API port (2)', () => {
  it('asks that port\'s /api/local-file, the path encoded', () => {
    windowWith({ apiPort: PORT });
    expect(localFileUrl(PICTURE)).toBe(`http://127.0.0.1:${PORT}/api/local-file?path=${encodeURIComponent(PICTURE)}`);
  });
});

describe('a note\'s local picture (3, 5)', () => {
  it('has no source when no port is known, and shows its alt text', () => {
    windowWith({ apiPort: null });
    const markup = renderToStaticMarkup(<SimpleMarkdown content={DOCUMENT.content} />);
    const img = markup.match(/<img\b[^>]*alt="chart"[^>]*>/)?.[0] ?? '';
    expect(img, 'the picture is still drawn').not.toBe('');
    expect(img, 'no source').not.toMatch(/\bsrc=/);
    expect(markup, 'no address of any port').not.toContain('/api/local-file');
  });
  it('is read from the window\'s own port when it is known', () => {
    windowWith({ apiPort: PORT });
    const markup = renderToStaticMarkup(<SimpleMarkdown content={DOCUMENT.content} />);
    expect(markup).toContain(`src="http://127.0.0.1:${PORT}/api/local-file?path=${encodeURIComponent(PICTURE)}"`);
    expect(markup).not.toContain('31415');
  });
});

describe('an attachment\'s row (4, 5)', () => {
  it('is no link when no port is known', () => {
    windowWith({ apiPort: null });
    const markup = viewer();
    const anchor = attachmentAnchor(markup);
    expect(anchor, 'the row is still there').not.toBe('');
    expect(anchor, 'no address').not.toMatch(/\bhref=/);
    expect(markup, 'no address of any port').not.toContain('/api/local-file');
  });
  it('links to the window\'s own port when it is known', () => {
    windowWith({ apiPort: PORT });
    const anchor = attachmentAnchor(viewer());
    expect(anchor).toContain(`href="http://127.0.0.1:${PORT}/api/local-file?path=${encodeURIComponent(ATTACHED)}"`);
  });
});
