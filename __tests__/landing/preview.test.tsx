import '../setup/home-guard';
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { PreviewSection } from '../../landing/src/components/PreviewSection';
import { DEFAULT_APP_SETTINGS, SECTIONS } from '../../src/components/Settings/constants';

/**
 * The landing's section on the preview of 2.0.0 (landing/src/components/
 * PreviewSection.tsx), as `Landing · desktop` draws it in design/landing.pen,
 * its Preview section: projects and chats, off until Settings turns it on.
 * Written before the code, as the ways it can fail:
 * 1. a word of the frame's section is dropped, changed or moved on its way to
 *    the page;
 * 2. it says the new interface is on, or not that it is off until turned on,
 *    while the app's default is off (src/components/Settings/constants.ts);
 * 3. it names a switch the app does not have, or puts it somewhere else: the
 *    row's label in GeneralSection.tsx, in the section Settings lists as
 *    Preferences;
 * 4. the home page does not show it, shows it twice, or elsewhere than
 *    between What it does and How it works, where the frame has it.
 *
 * Added after the code, for a mutant of its bench that survived (A2):
 * 5. the row is renamed while its switch keeps the name, and the landing
 *    names a row Settings no longer shows (case 3 reads both).
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

  it('says it is off until turned on, as the app\'s default is (2)', () => {
    expect(DEFAULT_APP_SETTINGS.newInterface).toBe(false);
    expect(shown).toContain('off until you turn it on');
    expect(shown).not.toMatch(/\bon by default\b/i);
  });

  it('names the switch the app has, where the app has it (3)', () => {
    const general = read('src/components/Settings/GeneralSection.tsx');
    const at = general.indexOf('newInterface: ');
    // The row that sets it: the name it shows, and its switch's.
    const row = general.slice(general.lastIndexOf('<SettingsRow', at), at);
    const labels = [...row.matchAll(/label="([^"]+)"/g)].map(m => m[1]);
    expect(labels.length).toBeGreaterThan(1);
    expect(new Set(labels).size, 'the row and its switch say the same').toBe(1);
    const label = labels[0];
    expect(label).toBe('New interface');
    // The page GeneralSection draws, as Settings lists it: Preferences, under General.
    const page = SECTIONS.find(s => s.id === 'general')?.label;
    expect(page).toBe('Preferences');
    expect(shown).toContain(`Settings, ${page}, ${label}.`);
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
