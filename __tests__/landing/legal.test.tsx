import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, parseMarkdown, type Block, type Span } from '../../landing/src/lib/markdown';
import { SiteFooter } from '../../landing/src/components/SiteFooter';

/**
 * The landing's privacy and terms pages (landing/src/app/privacy, terms), which
 * show Cooper Labs's two documents as they were written, the privacy policy of
 * 2026-09-28 and the terms of 2026-09-24, through a small renderer for the
 * markdown they use (landing/src/lib/markdown.tsx).
 * Written before the code, as the ways it can fail:
 * 1. a word of a document is dropped, changed or moved on its way to the page;
 * 2. markup reaches the page as characters: a `**`, a backtick, a `#` or a
 *    `- ` at the head of a line;
 * 3. the structure is lost: a heading comes out as a paragraph, a nested item
 *    is flattened into its parent list, the paragraph that continues an item
 *    leaves it or ends the list, two paragraphs run into one;
 * 4. bold that holds code loses one of the two, or an unmatched `**` or
 *    backtick turns the rest of its line bold or into code;
 * 5. text that looks like HTML is read as HTML;
 * 6. the document on the site is not the one that was reviewed: its title and
 *    its date are not the first things the page shows;
 * 7. a page cannot reach them: the footer, which every page has, links to
 *    neither, or a page has no footer.
 */

const LANDING = path.resolve(__dirname, '../../landing');
const doc = (name: string) => fs.readFileSync(path.join(LANDING, 'src', 'content', `${name}.md`), 'utf8');
const html = (source: string) => renderToStaticMarkup(<Markdown source={source} />);
/** What a reader sees: block tags part words, inline ones do not. */
const textOf = (markup: string) => markup
  .replace(/<\/?(strong|code)[^>]*>/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();
/** The words of a document, its markup taken out. */
const wordsOf = (source: string) => source
  .replace(/^#+ /gm, '').replace(/^\s*- /gm, '').replace(/\*\*/g, '').replace(/`/g, '')
  .replace(/\s+/g, ' ').trim();
const plain = (spans: Span[]) => spans.map(s => s.text).join('');
const text = (block: Block) => (block.kind === 'list' ? '' : plain(block.spans));
const lists = (blocks: Block[]) => blocks.filter((b): b is Extract<Block, { kind: 'list' }> => b.kind === 'list');

describe('the documents, word for word (1, 2)', () => {
  it.each(['privacy', 'terms'])('the %s page shows every word of its document, in order, and none of its markup', (name) => {
    const source = doc(name);
    expect(source.length).toBeGreaterThan(3000);
    expect(textOf(html(source))).toBe(wordsOf(source));
  });
});

describe('the structure of a document (3)', () => {
  const privacy = parseMarkdown(doc('privacy'));
  const terms = parseMarkdown(doc('terms'));

  it('makes a heading of every heading line, at its level', () => {
    for (const [blocks, name] of [[privacy, 'privacy'], [terms, 'terms']] as const) {
      const headings = blocks.filter(b => b.kind === 'heading').map(b => `${b.kind === 'heading' ? b.level : 0} ${text(b)}`);
      const lines = doc(name).split('\n').filter(l => /^#+ /.test(l)).map(l => `${l.indexOf(' ')} ${l.replace(/^#+ /, '')}`);
      expect(headings).toEqual(lines);
      expect(headings.length).toBeGreaterThan(8);
    }
    expect(html('## Who runs what')).toMatch(/^<h2[^>]*>Who runs what<\/h2>$/);
  });

  it('keeps a nested list, and the paragraph that continues an item, inside that item', () => {
    const stays = lists(privacy).find(l => text(l.items[0][0]).startsWith('~/.dorothy/'))!;
    expect(stays.items).toHaveLength(6);
    const [dorothy, , claude] = stays.items;
    expect(dorothy.map(b => b.kind)).toEqual(['paragraph', 'list', 'paragraph']);
    expect(lists(dorothy)[0].items).toHaveLength(13);
    expect(text(dorothy[2])).toMatch(/^At every start, Tars closes this folder/);
    expect(claude.map(b => b.kind)).toEqual(['paragraph', 'list', 'paragraph']);
    expect(text(claude[2])).toMatch(/^Claude Code writes its own conversation transcripts/);
    // An item with a nested list and four paragraphs after it keeps all of them (the agents' tool errors' since 2.0.4).
    const leaves = lists(privacy).find(l => text(l.items[0][0]).startsWith('AI coding CLIs you installed'))!;
    const errors = leaves.items.find(item => text(item[0]).startsWith('Error reports, to Sentry'))!;
    expect(errors.map(b => b.kind)).toEqual(['paragraph', 'list', 'paragraph', 'paragraph', 'paragraph', 'paragraph']);
    expect(lists(errors)[0].items).toHaveLength(5);
    expect(text(errors[3])).toMatch(/^When Tars refuses a tool call one of your agents made to it/);
    expect(text(errors[5])).toMatch(/^Like any connection, the report reaches Sentry/);
    // The list ends where the unindented paragraph starts.
    expect(text(privacy[privacy.indexOf(stays) + 1])).toBe('Local traffic stays local. Tars listens on 127.0.0.1 only: port 31415 for its hooks and tools, and 31416 for its OpenAI-compatible bridge. It does not accept connections from other machines.');
    // The lists, items and paragraphs of the markup, every other tag and attribute out.
    const shape = (markup: string) => markup.replace(/<\/?(?!(?:ul|li|p)\b)[a-z0-9]+[^>]*>/g, '').replace(/<(\/?[a-z0-9]+)[^>]*>/g, '<$1>');
    expect(shape(html('- alpha\n  - beta\n\n  gamma\n- delta'))).toBe('<ul><li>alpha<ul><li>beta</li></ul><p>gamma</p></li><li>delta</li></ul>');
  });

  it('keeps paragraphs apart', () => {
    const responsible = terms.findIndex(b => b.kind === 'heading' && text(b) === '3. You are responsible for what your agents do');
    const next = terms.slice(responsible + 1).findIndex(b => b.kind === 'heading');
    expect(terms.slice(responsible + 1, responsible + 1 + next).map(b => b.kind))
      .toEqual(['paragraph', 'list', 'paragraph', 'paragraph', 'list', 'paragraph']);
  });
});

describe('bold, code and what is not markup (4, 5)', () => {
  it('keeps both when bold holds code', () => {
    const [p] = parseMarkdown('**`~/.dorothy/`** (the folder keeps the project\'s former name).');
    expect(p.kind === 'paragraph' && p.spans).toEqual([
      { text: '~/.dorothy/', strong: true, code: true },
      { text: ' (the folder keeps the project\'s former name).', strong: false, code: false },
    ]);
    expect(html('**`~/.dorothy/`** holds')).toMatch(/<strong[^>]*><code[^>]*>~\/\.dorothy\/<\/code><\/strong> holds/);
  });

  it('leaves an unmatched ** or backtick as it was typed', () => {
    const [p] = parseMarkdown('2 ** 3 is not bold, and a ` is not code');
    expect(p.kind === 'paragraph' && p.spans).toEqual([{ text: '2 ** 3 is not bold, and a ` is not code', strong: false, code: false }]);
  });

  it('shows text that looks like HTML as text', () => {
    const markup = html('a <img src=x onerror=alert(1)> and `<script>`');
    expect(markup).not.toMatch(/<img|<script/);
    expect(textOf(markup)).toBe('a <img src=x onerror=alert(1)> and <script>');
  });
});

// Both dated 2026-10-28 since 2.0.5's text (92c6f03ee, #545: Telegram through the owner's Hermes, no bot of Tars's own),
// taken for the owner by the project's orchestrator on 28/10 (t-79a1f60c), the owner free to revise before a deployment.
describe('the reviewed documents (6)', () => {
  it.each([['privacy', 'Tars Privacy Policy', '2026-10-28'], ['terms', 'Tars Terms of Use', '2026-10-28']])('the %s page opens on its title, then its date', (name, title, day) => {
    const [heading, date] = parseMarkdown(doc(name));
    expect(heading).toEqual({ kind: 'heading', level: 1, spans: [{ text: title, strong: false, code: false }] });
    expect(date).toEqual({ kind: 'paragraph', spans: [{ text: `Last updated: ${day}.`, strong: false, code: false }] });
    expect(html(doc(name))).toMatch(new RegExp(`^<h1[^>]*>${title}</h1><p[^>]*>Last updated: ${day}\\.</p>`));
  });
});

describe('every page reaches them (7)', () => {
  const APP = path.join(LANDING, 'src', 'app');
  const pages = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return pages(full);
    return /^(page|not-found)\.tsx$/.test(e.name) ? [full] : [];
  });

  it('has a footer that links to the privacy policy and the terms', () => {
    const footer = renderToStaticMarkup(<SiteFooter />);
    expect(footer).toMatch(/<a[^>]*href="\/privacy"[^>]*>privacy<\/a>/);
    expect(footer).toMatch(/<a[^>]*href="\/terms"[^>]*>terms<\/a>/);
  });

  it('puts the footer on every page, the two documents included', () => {
    const found = pages(APP).map(f => path.relative(APP, f)).sort();
    expect(found).toEqual(['not-found.tsx', 'page.tsx', path.join('privacy', 'page.tsx'), path.join('terms', 'page.tsx')]);
    const legalPage = fs.readFileSync(path.join(LANDING, 'src', 'components', 'LegalPage.tsx'), 'utf8');
    expect(legalPage).toMatch(/<SiteFooter \/>/);
    for (const f of found) {
      expect(fs.readFileSync(path.join(APP, f), 'utf8'), f).toMatch(/<SiteFooter \/>|<LegalPage doc="(privacy|terms)" \/>/);
    }
  });
});
