import '../setup/home-guard';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, settle, elements, ofType, textOf, type Mount } from './hook-runtime';
import { HermesSection } from '../../src/components/Settings/HermesSection';
import { Button, PasswordInput, SegmentedControl, StatusSquare } from '../../src/components/ui';
import type { AppSettings } from '../../src/components/Settings/types';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * Settings > Hermes, the notice under Gateway URL when an import left the token
 * behind. Frame: `row Import · token not imported` (b68ixt) in `Settings ·
 * Connection`, design/tars-redesign.pen. Hermes Desktop keeps the token
 * encrypted with its own safeStorage key when its keychain encryption is on,
 * and Tars cannot read it; the import brought the URL and said "Imported", so
 * the Status row went on to ask for a sign-in nobody had been told about.
 * Written before the notice, as the ways it can fail:
 * 1. an import whose result says the token was not imported shows no notice,
 *    or shows other words than the frame's, or no waiting square;
 * 2. an import that brought its token, or had none to bring, shows the notice;
 * 3. the notice outlives what answers it: a token typed in the field, a
 *    sign-in that succeeds, an import run again that brought the token, or a
 *    change of mode, after which the token field it asks for may be gone;
 * 4. it goes before one of those: on a failed sign-in, or on its own.
 */

const COPY = 'Token not imported: Hermes Desktop keeps it encrypted. Sign in or paste it.';
const REMOTE = { mode: 'remote', url: 'http://box.example:9119', authMode: 'token' };

type El = { type: unknown; props: Record<string, unknown> };
const g = globalThis as unknown as { window?: unknown };

let page: Mount<unknown> | null = null;
afterEach(() => {
  page?.unmount();
  page = null;
  delete g.window;
});

/** The section with Hermes Desktop found, its import answering `imports` in turn. */
async function section(imports: Array<Record<string, unknown>>, signIn: { success: boolean; error?: string } = { success: true }) {
  const queue = [...imports];
  g.window = {
    electronAPI: {
      hermes: {
        getConnection: async () => ({ connection: { mode: 'local', localPort: 9119, authMode: 'token' }, baseUrl: '', desktopConfigAvailable: true }),
        getConnectionInfo: async () => null,
        importDesktopConnection: async () => queue.shift(),
        signIn: async () => signIn,
      },
    },
  };
  const settings = {} as unknown as AppSettings;
  page = mount(() => HermesSection({ appSettings: settings, onSaveAppSettings: () => {}, onUpdateLocalSettings: () => {} }));
  await settle();
  const button = (word: string) => (ofType(page!.result, Button) as unknown as El[]).find(b => textOf(b.props.children as never) === word)!;
  return {
    notice: () => (elements(page!.result) as unknown as El[]).find(el => el.type === 'div' && textOf(el.props.children as never) === COPY) ?? null,
    importIt: async () => { (button('import').props.onClick as () => Promise<void>)(); await settle(); },
    typeToken: (value: string) => {
      const field = (ofType(page!.result, PasswordInput) as unknown as El[]).find(p => p.props['aria-label'] === 'Hermes session token')!;
      (field.props.onChange as (e: unknown) => void)({ target: { value } });
      page!.rerender();
    },
    pickMode: (mode: string) => {
      const control = (ofType(page!.result, SegmentedControl) as unknown as El[]).find(c => c.props.ariaLabel === 'Hermes connection mode')!;
      (control.props.onChange as (m: string) => void)(mode);
      page!.rerender();
    },
    signIn: async () => { (button('Sign in').props.onClick as () => Promise<void>)(); await settle(); },
  };
}

const notImported = { success: true, connection: REMOTE, baseUrl: REMOTE.url, tokenNotImported: true };
const imported = { success: true, connection: { ...REMOTE, token: 'tok' }, baseUrl: REMOTE.url };

describe('the notice that an import left the token behind', () => {
  it('shows the frame\'s words, with a waiting square, when the token was not imported (1)', async () => {
    const s = await section([notImported]);
    expect(s.notice()).toBeNull();
    await s.importIt();
    const notice = s.notice();
    expect(notice).not.toBeNull();
    expect((ofType(notice, StatusSquare) as unknown as El[]).map(q => q.props.tone)).toEqual(['waiting']);
  });

  it('is not shown for an import that brought its token, or had none (2)', async () => {
    const s = await section([imported, { success: true, connection: REMOTE, baseUrl: REMOTE.url, tokenNotImported: false }]);
    await s.importIt();
    expect(s.notice()).toBeNull();
    await s.importIt();
    expect(s.notice()).toBeNull();
  });

  it('goes once a token is typed (3)', async () => {
    const s = await section([notImported]);
    await s.importIt();
    s.typeToken('pasted');
    expect(s.notice()).toBeNull();
  });

  it('goes once a sign-in succeeds, and stays after one that fails (3, 4)', async () => {
    const failed = await section([notImported], { success: false, error: 'bad password' });
    await failed.importIt();
    await failed.signIn();
    expect(failed.notice()).not.toBeNull();
    page!.unmount();

    const s = await section([notImported]);
    await s.importIt();
    await s.signIn();
    expect(s.notice()).toBeNull();
  });

  it('goes when the mode changes (3)', async () => {
    const s = await section([notImported]);
    await s.importIt();
    s.pickMode('ssh');
    expect(s.notice()).toBeNull();
  });

  it('goes when an import run again brings the token (3)', async () => {
    const s = await section([notImported, imported]);
    await s.importIt();
    expect(s.notice()).not.toBeNull();
    await s.importIt();
    expect(s.notice()).toBeNull();
  });
});
