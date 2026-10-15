import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, ofType, textOf, type Mount } from './hook-runtime';
import { GeneralSection } from '../../src/components/Settings/GeneralSection';
import { SettingsRow } from '../../src/components/Settings/SettingsRow';
import { Toggle } from '../../src/components/Settings/Toggle';
import { DEFAULT_APP_SETTINGS } from '../../src/components/Settings/constants';
import type { AppSettings } from '../../src/components/Settings/types';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * Settings > Preferences, "Send error reports": step 1 of the Sentry plan JeanBrasse
 * approved on 2026-09-24 (public, opt-in). The contract with the main process
 * is one AppSettings key, `errorReportsEnabled`, false by default, saved through
 * the settings flow like every other switch; main follows it live. Frames:
 * `Settings · Preferences` and its light copy, in design/tars-redesign.pen.
 * Written before the row, as the ways it can fail:
 * 1. the switch reads on while nothing is sent, or off while reports go out:
 *    it must show `errorReportsEnabled` itself, and off when the key is
 *    missing, as it is in every settings file written before it. The reading
 *    the rows above it use for their default-on keys (`!== false`) shows it on;
 * 2. the page's own defaults, which it shows until main's settings arrive,
 *    have it on;
 * 3. flipping it saves something other than that one key with its new value:
 *    the whole snapshot, which overwrites what other paths changed since, or
 *    the value it already had;
 * 4. the row does not say what a report holds and what it never holds, or has
 *    no way to the privacy policy, or a link that would open in Tars's own
 *    window rather than in the browser; or it promises what is not true: the
 *    Audit's gate found it said a report never holds files or paths, when #221
 *    sends a path under home as ~/... and one outside it whole;
 * 5. the switch has no name of its own for assistive technology.
 */

type El = { type: unknown; props: Record<string, unknown> };
const g = globalThis as unknown as { window?: unknown };
let page: Mount<unknown> | null = null;
afterEach(() => {
  page?.unmount();
  page = null;
  delete g.window;
});

/** Preferences on these settings, with every save recorded. */
function preferences(appSettings: AppSettings) {
  g.window = {};
  const saved: Array<Partial<AppSettings>> = [];
  page = mount(() => GeneralSection({ info: null, appSettings, onSaveAppSettings: (updates) => { saved.push(updates); } }));
  const row = () => {
    const found = (ofType(page!.result, SettingsRow) as unknown as El[]).filter(el => el.props.label === 'Send error reports');
    expect(found).toHaveLength(1);
    return found[0];
  };
  const toggle = () => {
    const control = row().props.control as El;
    expect(control.type).toBe(Toggle);
    return control;
  };
  return { saved, row, toggle };
}

/** The settings as a file written before the switch existed has them. */
const withoutTheKey = (): AppSettings => {
  const older: Record<string, unknown> = { ...DEFAULT_APP_SETTINGS };
  delete older.errorReportsEnabled;
  return older as unknown as AppSettings;
};
const withTheKey = (errorReportsEnabled: boolean): AppSettings => ({ ...DEFAULT_APP_SETTINGS, errorReportsEnabled } as AppSettings);

describe('the switch shows the setting (1, 2)', () => {
  it('reads off from the page defaults, before main has answered', () => {
    expect(preferences(DEFAULT_APP_SETTINGS as AppSettings).toggle().props.enabled).toBe(false);
  });

  it('reads off when the settings have no such key', () => {
    expect(preferences(withoutTheKey()).toggle().props.enabled).toBe(false);
  });

  it('reads on when the setting is on, and off when it is off', () => {
    expect(preferences(withTheKey(true)).toggle().props.enabled).toBe(true);
    page!.unmount();
    expect(preferences(withTheKey(false)).toggle().props.enabled).toBe(false);
  });
});

describe('flipping it saves that key alone (3)', () => {
  it.each([
    ['off', () => withTheKey(false), true],
    ['on', () => withTheKey(true), false],
    ['missing', withoutTheKey, true],
  ] as const)('from %s, it saves errorReportsEnabled and nothing else', (_state, settings, next) => {
    const p = preferences(settings());
    (p.toggle().props.onChange as () => void)();
    expect(p.saved).toEqual([{ errorReportsEnabled: next }]);
  });
});

describe('what the row tells (4, 5)', () => {
  it('says what a report holds, and what it never holds, and promises nothing a report carries', () => {
    const said = textOf(preferences(withoutTheKey()).row().props.description as never);
    for (const sent of ['the error', "where it happened in Tars's code", 'the version', 'the system', 'a random install id']) {
      expect(said).toContain(sent);
    }
    expect(said).toContain('File paths keep their names, with your home folder shown as ~.');
    expect(said).toContain('Never your code, prompts, conversations or keys.');
    expect(said).not.toMatch(/never[^.]*\b(files?|paths?)\b/i);
  });

  it('links to the privacy policy, opened in the browser', () => {
    const links = ofType(preferences(withoutTheKey()).row().props.description, 'a') as unknown as El[];
    expect(links).toHaveLength(1);
    const [link] = links;
    expect(textOf(link as never)).toBe('Privacy policy');
    expect(link.props.href).toMatch(/^https:\/\/[^/]+\/.*privacy/);
    expect(link.props.target).toBe('_blank');
    expect(String(link.props.rel)).toContain('noopener');
  });

  it('names the switch for assistive technology', () => {
    expect(preferences(withoutTheKey()).toggle().props.label).toBe('Send error reports');
  });
});
