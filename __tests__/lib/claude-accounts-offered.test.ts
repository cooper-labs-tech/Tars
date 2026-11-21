import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { SECTION_GROUPS } from '../../src/components/Settings/constants';
import { offeredSettingsGroups, settingsSectionOffered } from '../../src/lib/claude-accounts-offered';

/**
 * The renderer's half of keeping Claude accounts off on Windows: on a Windows build
 * Settings does not offer Claude accounts until they are ported. Main's half,
 * which keeps the option off whatever the registry says, is
 * electron/claude-accounts/windows-off.test.ts.
 *
 * How it fails, written before the code:
 * 1. The Settings sidebar (and its narrow-screen select) lists Claude accounts
 *    on win32, so a user turns on something that cannot sign in.
 * 2. A link to /settings?section=claude-accounts opens the section on win32.
 * 3. Over-correction: a Mac or Linux window loses the entry or the link, or
 *    another section goes missing on win32.
 */

const ids = (groups: typeof SECTION_GROUPS) => groups.flatMap(g => g.children.map(c => c.id));

describe('Claude accounts in Settings', () => {
  it('1. is not in the sections a win32 window lists, and nothing else is gone', () => {
    const all = ids(SECTION_GROUPS);
    expect(all).toContain('claude-accounts');
    expect(ids(offeredSettingsGroups(SECTION_GROUPS, 'win32'))).toEqual(all.filter(id => id !== 'claude-accounts'));
  });

  it('2. is not opened by a link on win32; any other section is', () => {
    expect(settingsSectionOffered('claude-accounts', 'win32')).toBe(false);
    expect(settingsSectionOffered('ai-providers', 'win32')).toBe(true);
  });

  it.each(['darwin', 'linux'])('3. is listed and opened by a link on %s, as before', (platform) => {
    expect(offeredSettingsGroups(SECTION_GROUPS, platform)).toBe(SECTION_GROUPS);
    expect(settingsSectionOffered('claude-accounts', platform)).toBe(true);
  });
});
