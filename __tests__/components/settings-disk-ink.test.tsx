import '../setup/home-guard';
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { mount, settle, ofType, textOf } from './hook-runtime';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * The Disk line of Settings, System: the free space the main process reports,
 * in the waiting ink when the disk is under the floor Tars warns at, as the
 * frame `Settings · System · folders no agent owns` draws it. Only the low flag
 * behind it was tested (__tests__/lib/orphan-folders.test.ts): nothing read the
 * ink the line is drawn in (the Audit's Info at the gate of #341, 2026-10-07).
 *
 * How it fails:
 * 1. A disk under the floor reads its free space in the muted ink: the one
 *    warning the line gives is gone, and the line reads like any other.
 * 2. A disk at the floor or over it reads in the waiting ink: a warning for
 *    nothing, on every machine with room to spare.
 * 3. The line names another figure than the free space that was reported.
 */

import { SystemSection } from '../../src/components/Settings/SystemSection';
import { SettingsRow } from '../../src/components/Settings/SettingsRow';

const g = globalThis as unknown as { window?: unknown };
const GB = 1024 ** 3;

afterEach(() => {
  delete g.window;
});

/** The Disk row's value, as SystemSection draws it once the main process has answered. */
async function diskValue(freeGb: number): Promise<{ text: string; inks: string[] }> {
  g.window = {
    electronAPI: {
      system: { disk: async () => ({ freeBytes: freeGb * GB, totalBytes: 460 * GB, floorBytes: 30 * GB }) },
    },
  };
  const m = mount(() => SystemSection({ info: null, appSettings: {} as never, onSaveAppSettings: () => {} }));
  await settle();
  const row = ofType(m.result, SettingsRow).find(r => r.props.label === 'Disk');
  m.unmount();
  expect(row, 'the Disk line is drawn once the main process has answered').toBeDefined();
  const value = row!.props.control as ReactElement<{ className?: string }>;
  return { text: textOf(value), inks: (value.props.className ?? '').split(/\s+/) };
}

describe('the Disk line of Settings, System', () => {
  it('1, 3. reads the free space in the waiting ink under the floor', async () => {
    const value = await diskValue(9);
    expect(value.text).toBe('9 GB free');
    expect(value.inks).toContain('text-status-waiting');
    expect(value.inks).not.toContain('text-muted-foreground');
  });

  it('2, 3. reads it in the muted ink at the floor and over it', async () => {
    for (const gb of [30, 68, 123]) {
      const value = await diskValue(gb);
      expect(value.text, `${gb} GB`).toBe(`${gb} GB free`);
      expect(value.inks, `${gb} GB`).toContain('text-muted-foreground');
      expect(value.inks, `${gb} GB`).not.toContain('text-status-waiting');
    }
  });
});
