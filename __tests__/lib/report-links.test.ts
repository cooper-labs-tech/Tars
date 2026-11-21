import '../setup/home-guard';
import { describe, expect, it } from 'vitest';
import { reportLinkTarget } from '@/lib/report-links';

/**
 * Where a link or a picture in a project's report leads, in the Vault (2.0.4, #471's Audit L4; frame `Vault · project
 * folders · states`, "a link in a report"). An agent wrote the report, so nothing in it may reach outside its folder
 * or make the window fetch anything. Written before the code. Every way it can be wrong:
 * 1. A page (http, https, mailto) not opened as one, or anything else taken for one: javascript:, data:, file:,
 *    vbscript:, the app's own app: and local-file: schemes, or a scheme in another case or with spaces before it.
 * 2. A file of the folder not opened here: a bare name, ./name, a %-encoded name, a name with an #anchor after it.
 * 3. A link opened here that leads out of the folder: ../, a subfolder, an absolute path, ~, a Windows drive or a
 *    backslash, or a name the folder does not hold (a dead link made to look alive).
 * 4. An empty link, a lone #anchor, or a name that is only dots, taken for anything but text.
 * 5. A %-encoding that does not decode throwing, rather than being text.
 */

const NAMES = ['roadmap.md', 'my report.md', 'release.md', 'slot.sh'];
const page = (url: string) => ({ kind: 'page', url });
const file = (name: string) => ({ kind: 'file', name });
const TEXT = { kind: 'text' };

describe('reportLinkTarget', () => {
  it('opens http, https and mailto as pages, and nothing else (1)', () => {
    expect(reportLinkTarget('https://example.com/page', NAMES)).toEqual(page('https://example.com/page'));
    expect(reportLinkTarget('  http://example.com/a?b=c  ', NAMES)).toEqual(page('http://example.com/a?b=c'));
    expect(reportLinkTarget('mailto:someone@example.com', NAMES)).toEqual(page('mailto:someone@example.com'));
    expect(reportLinkTarget('HTTPS://EXAMPLE.COM/', NAMES)).toEqual(page('HTTPS://EXAMPLE.COM/'));
    for (const href of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'vbscript:x', 'app://-/index.html', 'local-file:///Users/x/.ssh/id_rsa']) {
      expect(reportLinkTarget(href, NAMES), href).toEqual(TEXT);
    }
  });

  it('opens a file of the folder here, by its bare name, ./name, %-encoded, or with an anchor (2)', () => {
    expect(reportLinkTarget('roadmap.md', NAMES)).toEqual(file('roadmap.md'));
    expect(reportLinkTarget('./release.md', NAMES)).toEqual(file('release.md'));
    expect(reportLinkTarget('my%20report.md', NAMES)).toEqual(file('my report.md'));
    expect(reportLinkTarget('roadmap.md#state', NAMES)).toEqual(file('roadmap.md'));
  });

  it('never opens here what leads out of the folder or is not in it (3)', () => {
    for (const href of ['../tools/slot.sh', 'notes/next.md', '/etc/passwd', '~/.ssh/id_rsa', 'C:\\Windows\\win.ini', '..\\slot.sh', 'missing.md', './../release.md']) {
      expect(reportLinkTarget(href, NAMES), href).toEqual(TEXT);
    }
  });

  it('keeps empty links, anchors and dots as text (4)', () => {
    for (const href of ['', '   ', '#top', '.', '..', './']) expect(reportLinkTarget(href, NAMES), JSON.stringify(href)).toEqual(TEXT);
  });

  it('takes a broken %-encoding for text without throwing (5)', () => {
    expect(reportLinkTarget('bad%E0%A4%A.md', NAMES)).toEqual(TEXT);
  });
});
