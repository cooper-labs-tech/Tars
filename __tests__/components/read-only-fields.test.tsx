import '../setup/home-guard';
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { compile } from 'tailwindcss';
import { Input, PasswordInput, Select, Textarea } from '../../src/components/ui/Field';
import { HermesSection } from '../../src/components/Settings/HermesSection';
import { DEFAULT_APP_SETTINGS } from '../../src/components/Settings/constants';

/**
 * A read-only field reads as read-only. The frame is `Settings · Connection`
 * (XFApe) in design/tars-redesign.pen, rows `row Gateway URL · Local` (kjeqD)
 * and the webhook URL (B85KKr): a read-only field has the panel's `surface`
 * fill (`--card`) where an editable one has `surface-raised` (`--secondary`),
 * its value in `text-secondary` and the default cursor. On focus, by click or
 * by keyboard, it takes the accent border every field takes: fields draw no
 * focus outline, so that border is the only sign one holds the focus. The Local Gateway URL row says how to type one, "Derived from the
 * port below. Switch to Remote to type a URL.", and says it whole.
 *
 * Settings > Hermes in Local mode, where a fresh install lands, showed that
 * field exactly like the editable one: same fill, same text, a text cursor and
 * the accent border on focus, so a click and a keystroke that changed nothing
 * read as a broken field. The hint that explains it was one truncated line.
 *
 * How it can fail:
 * 1. a read-only Input, PasswordInput or Textarea keeps the editable look: the
 *    `surface-raised` fill, `text-primary`, or a text cursor;
 * 2. focus shows nothing: fields draw no focus outline, so a read-only field
 *    that keeps its plain border when clicked or reached with Tab gives no sign
 *    it holds the focus. It takes the accent border, as an editable field does
 *    (frame XFApe, state `RKPfa`), on any focus: Chromium matches
 *    `:focus-visible` on a click into any text input, read-only included, so a
 *    keyboard-only border cannot be told from a click in CSS;
 * 2b. focus takes the read-only look away: the fill, the text colour or the
 *    cursor turn back to an editable field's when it is focused;
 * 3. a disabled field takes the read-only look: the browser matches
 *    `:read-only` on a disabled input too, so a rule gated on it alone paints
 *    every disabled field, whose own state is its 40% opacity;
 * 4. an editable field takes it, or loses its own focus border;
 * 5. a Select takes it: `:read-only` matches every `<select>`, so the look
 *    would land on every dropdown in the app;
 * 6. a class names a token the theme does not have (`bg-surface`), which
 *    Tailwind drops without a word and the field keeps its old look;
 * 7. the Local Gateway URL hint is the old half sentence, or is cut: one
 *    `truncate`d line, which ends in an ellipsis at the settings' width.
 *
 * The suite has no browser, so the look is resolved from the app's own
 * stylesheet: `src/app/globals.css` compiled by the Tailwind the app builds
 * with, for the classes the component really renders, and the rules that match
 * a field in a given state (read-only, disabled, focused by pointer, focused by
 * keyboard) applied in cascade order. A pointer focus matches `:focus` alone; a
 * keyboard focus matches `:focus` and `:focus-visible`. The screenshots of the
 * settings sections are the in-app measure.
 *
 * The one brittle part is the parser: `utilityRules` assumes Tailwind v4's
 * output, each utility a flat `.class:pseudo { ... }` rule inside
 * `@layer utilities`. A Tailwind that nests variants (`&:read-only { ... }`) or
 * renames that layer would make it skip the rules and turn these tests red while
 * the app is fine; look at `utilityRules` first when they all fail at once.
 */

// ─── The stylesheet, compiled as the app compiles it ────────────────────────

const require = createRequire(import.meta.url);
const GLOBALS = path.resolve(__dirname, '../../src/app/globals.css');

type Build = (candidates: string[]) => string;
let build: Build;

beforeAll(async () => {
  const compiler = await compile(fs.readFileSync(GLOBALS, 'utf-8'), {
    base: path.dirname(GLOBALS),
    loadStylesheet: async (id: string, base: string) => {
      const file = id === 'tailwindcss' ? require.resolve('tailwindcss/index.css') : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: fs.readFileSync(file, 'utf-8') };
    },
  });
  build = (candidates) => compiler.build(candidates);
}, 30_000);

interface Rule { className: string; pseudos: string[]; declarations: Array<[string, string]>; order: number }

/** The utility rules Tailwind emits for these classes, flat, in order. */
function utilityRules(classes: string[]): Rule[] {
  // The compiler keeps every class it was ever given and emits them all, so
  // the rules are narrowed to these classes below.
  const own = new Set(classes);
  const css = build(classes);
  const start = css.indexOf('@layer utilities {');
  expect(start, 'the compiled stylesheet has a utilities layer').toBeGreaterThanOrEqual(0);
  const rules: Rule[] = [];
  let i = start + '@layer utilities {'.length;
  for (;;) {
    while (/\s/.test(css[i])) i++;
    if (css[i] === '}') break;
    const open = css.indexOf('{', i);
    const selector = css.slice(i, open).trim();
    // The body up to its matching brace; only its top-level declarations style
    // the element itself (nested blocks are ::placeholder, @supports, @media).
    let depth = 1;
    let j = open + 1;
    let top = '';
    for (; depth > 0; j++) {
      const ch = css[j];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (depth === 1) top += ch;
    }
    i = j;
    const declarations = top.split(';').map(d => d.trim()).filter(d => d.includes(':') && !d.includes('{'))
      .map(d => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()] as [string, string]);
    // `.read-only\:enabled\:bg-card:read-only:enabled`: the class, then the
    // pseudo-classes it waits for.
    const m = /^\.((?:\\.|[^:\\])+)((?::[a-z-]+)*)$/.exec(selector);
    if (!m) continue; // a pseudo-element or a compound this field never matches
    const className = m[1].replace(/\\(.)/g, '$1');
    if (!own.has(className)) continue;
    rules.push({ className, pseudos: m[2].split(':').filter(Boolean).map(p => `:${p}`), declarations, order: rules.length });
  }
  return rules;
}

/** How a field holds the focus: not at all, from a click, or from the keyboard. */
type Focus = 'none' | 'pointer' | 'keyboard';
interface State { tag: string; readOnly: boolean; disabled: boolean; focus: Focus }

/** Whether a field in this state matches a pseudo-class, as the HTML spec says. */
function matches(pseudo: string, s: State): boolean {
  // :read-write is an input or textarea that is mutable: neither readonly nor
  // disabled. Everything else is :read-only, a <select> always.
  const readWrite = (s.tag === 'input' || s.tag === 'textarea') && !s.readOnly && !s.disabled;
  switch (pseudo) {
    case ':read-only': return !readWrite;
    case ':read-write': return readWrite;
    case ':enabled': return !s.disabled;
    case ':disabled': return s.disabled;
    case ':focus': return s.focus !== 'none';
    // As Chromium 152 (Electron 44) matches it, measured: on keyboard focus,
    // and on a click into an <input> or <textarea>, read-only ones included;
    // a click on a button does not match it.
    case ':focus-visible': return s.focus === 'keyboard' || (s.focus === 'pointer' && (s.tag === 'input' || s.tag === 'textarea'));
    case ':hover': return false;
    default: throw new Error(`a pseudo-class this test does not model: ${pseudo}`);
  }
}

/** The field element a component renders: its tag, classes and states. */
function field(element: ReactElement): { tag: string; classes: string[]; readOnly: boolean; disabled: boolean } {
  const markup = renderToStaticMarkup(element);
  const m = /<(input|textarea|select)\b([^>]*)>/.exec(markup);
  expect(m, `a field in ${markup}`).not.toBeNull();
  const attrs = m![2];
  const classes = (/class="([^"]*)"/.exec(attrs)?.[1] ?? '').split(/\s+/).filter(Boolean);
  // React writes the attribute as it is spelt in JSX, `readOnly=""`; HTML
  // attribute names are case-insensitive.
  return { tag: m![1], classes, readOnly: /\sreadonly=""/i.test(attrs), disabled: /\sdisabled=""/i.test(attrs) };
}

type Look = { background?: string; color?: string; cursor?: string; border?: string; opacity?: string };

/** What the stylesheet gives this field: at rest, focused by a click, focused by the keyboard. */
function look(element: ReactElement): { rest: Look; focused: Look; keyboard: Look; classes: string[] } {
  const f = field(element);
  const rules = utilityRules(f.classes);
  const resolve = (focus: Focus): Look => {
    const state: State = { tag: f.tag, readOnly: f.readOnly, disabled: f.disabled, focus };
    const won = new Map<string, { value: string; specificity: number; order: number }>();
    for (const rule of rules) {
      if (!rule.pseudos.every(p => matches(p, state))) continue;
      const specificity = 1 + rule.pseudos.length;
      for (const [prop, value] of rule.declarations) {
        const held = won.get(prop);
        if (!held || specificity > held.specificity || (specificity === held.specificity && rule.order > held.order)) {
          won.set(prop, { value, specificity, order: rule.order });
        }
      }
    }
    const v = (prop: string) => won.get(prop)?.value;
    return { background: v('background-color'), color: v('color'), cursor: v('cursor'), border: v('border-color'), opacity: v('opacity') };
  };
  return { rest: resolve('none'), focused: resolve('pointer'), keyboard: resolve('keyboard'), classes: f.classes };
}

const noop = () => {};
const READ_ONLY_LOOK = { background: 'var(--card)', color: 'var(--text-secondary)', cursor: 'default', border: 'var(--border)' };
/** Focused, it keeps the read-only fill, text and cursor, and takes the accent border every field takes. */
const FOCUSED_READ_ONLY_LOOK = { ...READ_ONLY_LOOK, border: 'var(--primary)' };

// ─── The fields ─────────────────────────────────────────────────────────────

describe('a read-only field reads as read-only', () => {
  it('a read-only Input has the surface fill, secondary text and the default cursor (1)', () => {
    const { rest } = look(<Input readOnly value="http://127.0.0.1:9119" onChange={noop} />);
    expect(rest).toMatchObject(READ_ONLY_LOOK);
  });

  it('takes the accent border on any focus, click or keyboard, the one sign it holds the focus (2)', () => {
    const { focused, keyboard } = look(<Input readOnly value="http://127.0.0.1:9119" onChange={noop} />);
    expect(focused.border).toBe('var(--primary)');
    expect(keyboard.border).toBe('var(--primary)');
  });

  it('keeps the rest of the read-only look while focused (2b)', () => {
    const { focused, keyboard } = look(<Input readOnly value="http://127.0.0.1:9119" onChange={noop} />);
    expect(focused).toMatchObject(FOCUSED_READ_ONLY_LOOK);
    expect(keyboard).toMatchObject(FOCUSED_READ_ONLY_LOOK);
  });

  it('so do a read-only PasswordInput and Textarea (1, 2, 2b)', () => {
    for (const element of [
      <PasswordInput key="p" readOnly value="secret" onChange={noop} />,
      <Textarea key="t" readOnly value="a note" onChange={noop} />,
    ]) {
      const { rest, focused, keyboard } = look(element);
      expect(rest).toMatchObject(READ_ONLY_LOOK);
      expect(focused).toMatchObject(FOCUSED_READ_ONLY_LOOK);
      expect(keyboard).toMatchObject(FOCUSED_READ_ONLY_LOOK);
    }
  });

  it('a disabled Input keeps its own look, not the read-only one (3)', () => {
    const { rest } = look(<Input disabled value="off" onChange={noop} />);
    expect(rest.background).toBe('var(--secondary)');
    expect(rest.color).toBe('var(--foreground)');
    expect(rest.cursor).toBe('not-allowed');
    expect(rest.opacity).toBe('40%');
  });

  it('a disabled read-only Input keeps the disabled look too (3)', () => {
    const { rest } = look(<Input disabled readOnly value="off" onChange={noop} />);
    expect(rest.background).toBe('var(--secondary)');
    expect(rest.cursor).toBe('not-allowed');
  });

  it('an editable Input keeps the field fill, its text and its focus border (4)', () => {
    const { rest, focused, keyboard } = look(<Input value="http://100.64.0.7:9119" onChange={noop} />);
    expect(rest.background).toBe('var(--secondary)');
    expect(rest.color).toBe('var(--foreground)');
    expect(rest.cursor).toBeUndefined();
    expect(rest.border).toBe('var(--border)');
    expect(focused.border).toBe('var(--primary)');
    expect(keyboard.border).toBe('var(--primary)');
  });

  it('a Select never takes the read-only look, though it always matches :read-only (5)', () => {
    const { rest, focused, classes } = look(<Select value="a" onChange={noop}><option value="a">A</option></Select>);
    expect(classes.some(c => c.startsWith('read-only:'))).toBe(false);
    expect(rest.background).toBe('var(--secondary)');
    expect(rest.color).toBe('var(--foreground)');
    expect(focused.border).toBe('var(--primary)');
  });

  it('every read-only class the fields carry compiles to a rule (6)', () => {
    const { classes } = look(<Input readOnly value="x" onChange={noop} />);
    const readOnly = classes.filter(c => c.startsWith('read-only:'));
    expect(readOnly.length).toBeGreaterThan(0);
    const compiled = new Set(utilityRules(readOnly).map(r => r.className));
    expect(readOnly.filter(c => !compiled.has(c))).toEqual([]);
  });
});

// ─── Settings > Hermes, Local mode ──────────────────────────────────────────

describe('the Local Gateway URL row says how to type a URL, whole', () => {
  const SENTENCE = 'Derived from the port below. Switch to Remote to type a URL.';

  /** Settings > Hermes as a fresh install first renders it: Local mode. */
  function gatewayRow(): { hint: { classes: string[]; text: string }; readOnly: boolean; field: ReturnType<typeof look> } {
    const markup = renderToStaticMarkup(
      <HermesSection appSettings={DEFAULT_APP_SETTINGS} onSaveAppSettings={noop} onUpdateLocalSettings={noop} />,
    );
    const rows = markup.split('<div data-settings-row').slice(1);
    const row = rows.find(r => r.includes('>Gateway URL</p>'));
    expect(row, 'a Gateway URL row').toBeDefined();
    const hint = /<p data-settings-hint="[^"]*" class="([^"]*)">([^<]*)<\/p>/.exec(row!);
    expect(hint, 'the row has a hint').not.toBeNull();
    const input = /<input\b[^>]*>/.exec(row!)![0];
    const readOnly = /\sreadonly=""/i.test(input);
    return {
      hint: { classes: hint![1].split(/\s+/), text: hint![2] },
      readOnly,
      field: look(<input className={/class="([^"]*)"/.exec(input)![1]} readOnly={readOnly} />),
    };
  }

  it('the hint is the whole sentence (7)', () => {
    expect(gatewayRow().hint.text).toBe(SENTENCE);
  });

  it('the hint wraps instead of being cut with an ellipsis (7)', () => {
    const { classes } = gatewayRow().hint;
    expect(classes).not.toContain('truncate');
    const css = utilityRules(classes).flatMap(r => r.declarations);
    expect(css.filter(([prop, value]) => (prop === 'text-overflow' && value === 'ellipsis')
      || (prop === 'white-space' && value === 'nowrap')
      || (prop === 'overflow' && value === 'hidden'))).toEqual([]);
  });

  it('the Local field itself is read-only and reads as such (1, 2, 2b)', () => {
    const { readOnly, field: local } = gatewayRow();
    expect(readOnly).toBe(true);
    expect(local.rest).toMatchObject(READ_ONLY_LOOK);
    expect(local.focused).toMatchObject(FOCUSED_READ_ONLY_LOOK);
    expect(local.keyboard).toMatchObject(FOCUSED_READ_ONLY_LOOK);
  });
});
