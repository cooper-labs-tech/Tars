import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { GetTars, HeroDownload } from '../../landing/src/components/Downloads';
import type { Builds } from '../../landing/src/lib/platforms';

/**
 * The landing's downloads as the visitor sees them (landing/src/components/
 * Downloads.tsx, used by landing/src/app/page.tsx), against the frames that
 * specify them in design/landing.pen: `Landing · desktop` (a Mac today: its
 * hero and its Get Tars cards) and `Landing · downloads per OS` (each state).
 * Written before the code, as the ways it can fail:
 * 1. a word of a frame is dropped, changed or moved on its way to the page:
 *    the hero's line, a card's system or what it runs on, Get Tars's sentence;
 * 2. a visitor is offered a button for a file no release has, or a link that
 *    does not name the system it offers;
 * 3. a system that has a build is said to come later, or one without a build
 *    is linked;
 * 4. the visitor's architecture is lost on its way to the link;
 * 5. a visitor whose system is not known is offered one system's file rather
 *    than the list of all three;
 * 6. the download counter shows 0, or shows when GitHub did not answer;
 * 7. the page still says "Download for Mac" or "macOS desktop app" of its own,
 *    beside or instead of these;
 * 8. (the Audit's Medium on #430, before its code) a version promised after it
 *    is out without the system's build: 2.0.3 published with no Windows setup,
 *    and 2.0.3 still promised in the hero, its line or a card; or the page not
 *    handing the newest release from /api/stats down to them.
 */

const ROOT = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
/** What a reader sees: tags dropped (links sit inside sentences), entities read, spaces collapsed. */
const textOf = (markup: string) => markup
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ')
  .trim();
/** Each link's target and words. */
const linksOf = (markup: string) => [...markup.matchAll(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map(m => [m[1].replace(/&amp;/g, '&'), textOf(m[2])]);

type PenNode = { id?: string; name?: string; type?: string; content?: string; children?: PenNode[] };
const PEN = JSON.parse(read('design/landing.pen')) as { children: PenNode[] };
const rootNamed = (name: string) => {
  const root = PEN.children.find(r => r.name === name);
  if (!root) throw new Error(`design/landing.pen has no root named ${name}`);
  return root;
};
const find = (node: PenNode, name: string): PenNode | undefined => {
  if (node.name === name) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, name);
    if (hit) return hit;
  }
  return undefined;
};
/** The words of a frame, in order, its pieces joined as the frame lays them side by side. */
const wordsOf = (node: PenNode): string[] => (node.type === 'text' ? [node.content ?? ''] : (node.children ?? []).flatMap(wordsOf));
const lineOf = (node: PenNode | undefined) => {
  if (!node) throw new Error('the frame has no such part');
  return wordsOf(node).join('');
};
const STATES = rootNamed('Landing · downloads per OS');
const state = (n: number) => {
  const s = find(STATES, `state ${n}`);
  if (!s) throw new Error(`Landing · downloads per OS has no state ${n}`);
  return s;
};

const TODAY: Builds = { mac: '2.0.2', windows: null, linux: null };
const ALL_OUT: Builds = { mac: '2.0.4', windows: '2.0.4', linux: '2.0.4' };
const hero = (props: Partial<Parameters<typeof HeroDownload>[0]>) => renderToStaticMarkup(<HeroDownload visitor={null} builds={TODAY} latest="2.0.2" count={5} {...props} />);

describe('the hero, state by state, as the frame draws it (1, 2, 3, 5)', () => {
  it('a Mac, today: its download, and when Windows and Linux come', () => {
    const markup = hero({ visitor: 'mac' });
    expect(linksOf(markup)).toContainEqual(['/api/download?os=mac', 'Download for Mac']);
    expect(textOf(markup)).toContain(lineOf(find(state(1), 'others')));
    expect(textOf(markup)).toContain(lineOf(find(rootNamed('Landing · desktop'), 'others')));
    expect(markup).not.toMatch(/os=windows|os=linux/);
  });

  it('Windows, before its build: no button for a file that is not there, macOS offered', () => {
    const markup = hero({ visitor: 'windows' });
    expect(textOf(markup)).toContain(lineOf(find(state(2), 'soon')));
    expect(textOf(markup)).toContain(lineOf(find(state(2), 'others')));
    expect(markup).not.toContain('os=windows');
    expect(linksOf(markup)).toContainEqual(['/api/download?os=mac', 'macOS']);
  });

  it('Linux, before its build', () => {
    const markup = hero({ visitor: 'linux' });
    expect(textOf(markup)).toContain(lineOf(find(state(3), 'soon')));
    expect(textOf(markup)).toContain(lineOf(find(state(3), 'others')));
    expect(markup).not.toContain('os=linux');
  });

  it('Windows, once all three have a build: its download, and the other two offered', () => {
    const markup = hero({ visitor: 'windows', builds: ALL_OUT, latest: '2.0.4' });
    expect(linksOf(markup)).toContainEqual(['/api/download?os=windows', lineOf(find(find(state(4), 'cta')!, 'dl'))]);
    expect(textOf(markup)).toContain(lineOf(find(state(4), 'others')));
    expect(linksOf(markup)).toEqual(expect.arrayContaining([['/api/download?os=mac', 'macOS'], ['/api/download?os=linux', 'Linux']]));
  });

  it('a phone, or a system Tars does not run on: Download goes to the list, and no line', () => {
    const markup = hero({ visitor: null });
    expect(linksOf(markup)).toContainEqual(['#download', lineOf(find(find(state(5), 'cta')!, 'dl'))]);
    expect(markup).not.toContain('/api/download');
    expect(textOf(markup)).not.toMatch(/Also for|come with|comes with/);
  });
});

describe('the link keeps the visitor\'s architecture (4)', () => {
  it('asks for arm64 when the visitor is on arm64, and nothing more otherwise', () => {
    expect(hero({ visitor: 'linux', arch: 'arm64', builds: ALL_OUT, latest: '2.0.4' })).toContain('/api/download?os=linux&amp;arch=arm64');
    expect(hero({ visitor: 'linux', arch: 'x64', builds: ALL_OUT, latest: '2.0.4' })).toContain('href="/api/download?os=linux"');
  });
});

describe('the counter (6)', () => {
  it('shows GitHub\'s count, and nothing at 0 or when GitHub did not answer', () => {
    expect(textOf(hero({ visitor: 'mac', count: 5 }))).toContain('5 downloads');
    expect(textOf(hero({ visitor: 'mac', count: 0 }))).not.toContain('downloads');
    expect(textOf(hero({ visitor: 'mac', count: null }))).not.toContain('downloads');
  });
});

describe('Get Tars, as the frames draw it (1, 2, 3)', () => {
  const desktop = rootNamed('Landing · desktop');

  it('says what Tars is in the frame\'s sentence, and has a card per system in its order', () => {
    const markup = renderToStaticMarkup(<GetTars builds={TODAY} latest="2.0.2" />);
    // The section itself, a child of the page: the nav has a link named Download too.
    const section = desktop.children?.find(child => child.name === 'Download');
    expect(textOf(markup)).toContain(lineOf(find(section!, 'p')));
    const cards = (find(section!, 'oses')?.children ?? []).map(card => wordsOf(card));
    expect(cards).toHaveLength(3);
    let at = 0;
    for (const words of cards) {
      for (const word of words) {
        const found = textOf(markup).indexOf(word, at);
        expect(found, `${word} after what came before`).toBeGreaterThanOrEqual(0);
        at = found;
      }
    }
  });

  it('links only the systems that have a build today, and says when the others come', () => {
    const markup = renderToStaticMarkup(<GetTars builds={TODAY} latest="2.0.2" />);
    expect(linksOf(markup)).toEqual([['/api/download?os=mac', 'Download for Mac']]);
    expect(textOf(markup).match(/Comes with \d+\.\d+\.\d+/g)).toHaveLength(2);
  });

  it('has each card its own download once all three have a build', () => {
    const markup = renderToStaticMarkup(<GetTars builds={ALL_OUT} latest="2.0.4" />);
    const cards = (find(state(6), 'oses')?.children ?? []).map(card => lineOf(find(card, 'dl')));
    expect(linksOf(markup).map(([, words]) => words)).toEqual(cards);
    expect(linksOf(markup).map(([href]) => href)).toEqual(['/api/download?os=mac', '/api/download?os=windows', '/api/download?os=linux']);
  });

  it('links every system when GitHub did not answer, and lets the route decide', () => {
    const markup = renderToStaticMarkup(<GetTars builds={null} latest={null} />);
    expect(linksOf(markup).map(([href]) => href)).toEqual(['/api/download?os=mac', '/api/download?os=windows', '/api/download?os=linux']);
    expect(textOf(markup)).not.toContain('Comes with');
  });
});

describe('once 2.0.3 is out without its Windows setup, as state 7 draws it (8)', () => {
  const AFTER: Builds = { mac: '2.0.3', windows: null, linux: null };

  it('tells a Windows visitor Tars for Windows is coming, with no version, and keeps Linux\'s', () => {
    const markup = hero({ visitor: 'windows', builds: AFTER, latest: '2.0.3' });
    expect(textOf(markup)).toContain(lineOf(find(state(7), 'soon')));
    expect(textOf(markup)).toContain(lineOf(find(state(7), 'others')));
    expect(textOf(markup)).not.toContain('2.0.3');
  });

  it('says Coming on the Windows card, Comes with 2.0.4 on Linux\'s, and 2.0.3 nowhere', () => {
    const markup = renderToStaticMarkup(<GetTars builds={AFTER} latest="2.0.3" />);
    const cards = (find(state(7), 'oses')?.children ?? []).map(card => wordsOf(card));
    let at = 0;
    for (const words of cards) {
      for (const word of words) {
        const found = textOf(markup).indexOf(word, at);
        expect(found, `${word} after what came before`).toBeGreaterThanOrEqual(0);
        at = found;
      }
    }
    expect(textOf(markup)).not.toContain('2.0.3');
  });

  it('is handed the newest release by the page, from /api/stats', () => {
    const page = read('landing/src/app/page.tsx');
    expect(page.match(/latest=\{stats\?\.latest \?\? null\}/g)).toHaveLength(2);
  });
});

describe('the page (7)', () => {
  const page = read('landing/src/app/page.tsx');

  it('shows these, and says nothing of one system of its own', () => {
    expect(page).toMatch(/<HeroDownload\b/);
    expect(page).toMatch(/<GetTars\b/);
    expect(page).not.toContain('Download for Mac');
    expect(page).not.toContain('macOS desktop app');
  });
});
