import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreviewSection } from '../../landing/src/components/PreviewSection';
import { CHANGELOG } from '../../src/data/changelog';
import { DEFAULT_APP_SETTINGS, SECTIONS } from '../../src/components/Settings/constants';

/**
 * The landing's section on projects and chats (landing/src/components/
 * PreviewSection.tsx), as `Landing · desktop` draws it in design/landing.pen,
 * its Preview section: the preview of 2.0.0, Tars's only interface since 2.1.0.
 * Written before the code, as the ways it can fail:
 * 1. a word of the frame's section is dropped, changed or moved on its way to
 *    the page;
 * 4. the home page does not show it, shows it twice, or elsewhere than
 *    between What it does and How it works, where the frame has it.
 *
 * 2 and 3 said, until 2.1.0, that the section must call the new interface
 * off until turned on, and name the switch as the app had it. With the switch
 * gone (the owner's decision of 26/11), QA rewrote them as the Frontend
 * proposed, after the landing's own change (92e3baebe), their bite shown on
 * mutants:
 * 2. the app still has a newInterface setting, or the section still says it
 *    is off until turned on or names the New interface switch; or its eyebrow
 *    does not name the version that shipped it, 2.1.0, a version of the
 *    changelog;
 * 3. it puts the theme somewhere the app does not: the Appearance row of
 *    GeneralSection.tsx, Dark and Light, in the section Settings lists as
 *    Preferences; or it promises a digit for every page while NewShell's
 *    SHORTCUTS do not hold all ten, 0 to 9.
 *
 * Added after the code, for a mutant of its bench that survived (A2):
 * 5. the row is renamed while its switch keeps the name, and the landing
 *    names a row Settings no longer shows (case 3 read both until 2.1.0; it
 *    reads the Appearance row's label and its control's since).
 *
 * Added with the pictures of 2.0.0, before them:
 * 6. the frame's picture is not on the page, or another one is: the image its
 *    Preview section names under landing/src/assets is missing, is not a PNG
 *    of the app at least 1440 wide (e2e/new-interface-pictures.mjs takes it),
 *    is not the one the home page imports and hands to the section, or has no
 *    words for whoever cannot see it; or the section shows it elsewhere than
 *    between its head and its points.
 */

const ROOT = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
/** What a reader sees: tags part words, entities read as their characters. */
const textOf = (markup: string) => markup
  .replace(/<[^>]+>/g, ' ')
  .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ').trim();

type Node = { type?: string; name?: string; content?: string; fill?: { type?: string; url?: string }; children?: Node[] };
/** The texts of the frame's Preview section, in the order the page reads them. */
function frameTexts(): string[] {
  const doc = JSON.parse(read('design/landing.pen')) as { children: Node[] };
  const page = doc.children.find(c => c.name === 'Landing · desktop');
  const section = page?.children?.find(c => c.name === 'Preview');
  if (!section) throw new Error('Landing · desktop has no Preview section');
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.type === 'text' && n.content) out.push(n.content);
    (n.children ?? []).forEach(walk);
  };
  walk(section);
  return out;
}

/** The picture the frame's Preview section shows, as a path from the repository's root. */
function framePicture(): string {
  const doc = JSON.parse(read('design/landing.pen')) as { children: Node[] };
  const section = doc.children.find(c => c.name === 'Landing · desktop')?.children?.find(c => c.name === 'Preview');
  const urls: string[] = [];
  const walk = (n: Node) => {
    if (n.fill?.type === 'image' && n.fill.url) urls.push(n.fill.url);
    (n.children ?? []).forEach(walk);
  };
  if (section) walk(section);
  if (urls.length !== 1) throw new Error(`the Preview section shows ${urls.length} pictures, not 1`);
  return path.posix.normalize(path.posix.join('design', urls[0]));
}

const shown = textOf(renderToStaticMarkup(<PreviewSection />));

describe('the landing\'s preview of 2.0.0', () => {
  it('shows every word of the frame\'s section, in order (1)', () => {
    const words = frameTexts();
    expect(words.length).toBeGreaterThan(10);
    expect(shown).toBe(words.join(' ').replace(/\s+/g, ' ').trim());
  });

  it('says it is the interface since 2.1.0, with no switch left to turn it on (2)', () => {
    expect('newInterface' in DEFAULT_APP_SETTINGS, 'no newInterface setting').toBe(false);
    expect(shown).not.toContain('off until you turn it on');
    expect(shown).not.toContain('New interface');
    // The eyebrow, the section's first words: the version that shipped it, one the changelog has.
    const eyebrow = /^New in (\d+\.\d+\.\d+) /.exec(shown)?.[1];
    expect(eyebrow).toBe('2.1.0');
    expect(CHANGELOG.map(r => r.version)).toContain(eyebrow);
  });

  it('puts the theme where the app has it, and promises a digit only for the pages that have one (3)', () => {
    const general = read('src/components/Settings/GeneralSection.tsx');
    const at = general.indexOf('label="Appearance"');
    expect(at, 'GeneralSection has an Appearance row').toBeGreaterThan(-1);
    // The row and its control: the name it shows, the control's, and its two choices.
    const row = general.slice(general.lastIndexOf('<SettingsRow', at), general.indexOf('<SettingsRow', at));
    expect([...row.matchAll(/(?:label|ariaLabel)="([^"]+)"/g)].map(m => m[1])).toEqual(['Appearance', 'Appearance']);
    expect([...row.matchAll(/\{ value: '(\w+)', label: '(\w+)' \}/g)].map(m => [m[1], m[2]])).toEqual([['dark', 'Dark'], ['light', 'Light']]);
    // The page GeneralSection draws, as Settings lists it: Preferences, under General.
    const page = SECTIONS.find(s => s.id === 'general')?.label;
    expect(page).toBe('Preferences');
    expect(shown).toContain(`Settings, ${page}, Appearance.`);
    // A digit for every page: NewShell's SHORTCUTS hold all ten.
    const shell = read('src/components/NewShell/NewShell.tsx');
    const from = shell.indexOf('const SHORTCUTS');
    const table = shell.slice(from, shell.indexOf('\n};', from));
    expect([...table.matchAll(/^ {2}'(\d)': \{/gm)].map(m => m[1]).sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(shown).toContain('Cmd and a digit (Ctrl on Windows) opens a page');
  });

  it('shows the picture its frame names, from the app, between its head and its points (6)', () => {
    const file = framePicture();
    expect(file).toMatch(/^landing\/src\/assets\/[\w.-]+\.png$/);
    const png = fs.readFileSync(path.join(ROOT, file));
    expect(png.subarray(1, 4).toString('latin1'), `${file} is a PNG`).toBe('PNG');
    expect(png.readUInt32BE(16), `${file} is at least 1440 wide`).toBeGreaterThanOrEqual(1440);

    // The home page imports it and hands it to the section, with words for whoever cannot see it.
    const home = read('landing/src/app/page.tsx');
    const asset = file.replace(/^landing\/src\//, '@/');
    const imported = home.match(new RegExp(`import (\\w+) from '${asset.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}';`))?.[1];
    expect(imported, `page.tsx imports ${asset}`).toBeTruthy();
    const element = home.slice(home.indexOf('<PreviewSection'), home.indexOf('id="how"'));
    expect(element).toContain(`src={${imported}}`);
    expect(element).toMatch(/alt="[^"]{20,}"/);

    // The section shows what it is handed, between its head and its points.
    const markup = renderToStaticMarkup(<PreviewSection picture={<span data-picture="">A chat&apos;s page</span>} />);
    const at = markup.indexOf('data-picture');
    expect(at).toBeGreaterThan(markup.indexOf('Projects and chats'));
    expect(at).toBeLessThan(markup.indexOf('Every chat, in one list'));
  });

  it('sits once on the home page, between What it does and How it works (4)', () => {
    const home = read('landing/src/app/page.tsx');
    const features = home.indexOf('id="features"');
    const preview = home.indexOf('<PreviewSection');
    const how = home.indexOf('id="how"');
    expect(home.split('<PreviewSection').length - 1).toBe(1);
    expect(features).toBeGreaterThan(-1);
    expect(preview).toBeGreaterThan(features);
    expect(how).toBeGreaterThan(preview);
  });
});
