import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { DEFAULT_APP_SETTINGS } from '../../src/components/Settings/constants';

/**
 * No status line choice nobody made (1.7.4).
 *
 * The main process leaves `statusLineEnabled` out of its defaults on purpose:
 * unset means the switch was never touched, and the status line keeps the
 * behaviour it has for someone who never opened Settings. The renderer's
 * defaults said `false`, which reads as a decision the moment anything sends
 * these settings back whole. Settings only sends the delta today, so nothing
 * shows; this holds the renderer to the same absence as the main process.
 */
describe('the renderer settings defaults', () => {
  it('carry no statusLineEnabled, as the main process defaults do not', () => {
    expect(Object.keys(DEFAULT_APP_SETTINGS)).not.toContain('statusLineEnabled');
    expect((DEFAULT_APP_SETTINGS as Record<string, unknown>).statusLineEnabled).toBeUndefined();
  });

  it('are the object the Settings page reads, not an empty one', () => {
    // Without this the assertion above would pass on any object at all.
    expect(DEFAULT_APP_SETTINGS).toMatchObject({ terminalFontSize: 11, terminalTheme: 'dark' });
  });
});
