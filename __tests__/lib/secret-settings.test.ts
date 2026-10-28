import { describe, it, expect } from 'vitest';
import { WINDOW_SECRETS, SECRET_MASK as WINDOW_MASK, withoutSecrets, secretIsSet, withSecretState } from '../../src/lib/secret-settings';
import { SECRET_FIELDS, WINDOW_SET_FIELDS, SECRET_MASK } from '../../electron/services/settings-secrets';
import { computeProviderAvailability } from '../../src/lib/providers';

/**
 * The window's side of #466 (2.0.4): Settings holds no secret. A page reads whether one is set from `secretsSet`,
 * sets or clears it through secrets.set, and a save through app:saveSettings carries none, whatever the page holds.
 *
 * Written before src/lib/secret-settings.ts. The ways it can fail:
 * 1. A save sends a secret back as the mask the page was shown. Main keeps a key it gets back as the exact mask, but a
 *    mask a field let the user type into (`••••••••x`) is a new key, written over the real one.
 * 2. A save sends a key typed into a page: it reaches the settings through app:saveSettings, past secrets.set, the one
 *    channel that answers set or not, so the page cannot know what it did.
 * 3. A save sends a secret as '' for "untouched": main keeps the key, and the page believes it cleared.
 * 4. A save sends `secretsSet`, what app:getSettings adds, back into the settings.
 * 5. Taking the secrets out drops a setting whose value is falsy: false, 0, '' or [] (a switch turned off, a path
 *    emptied), so the change is never saved.
 * 6. The window's list of secrets drifts from main's: a secret added to settings-secrets.ts and not here goes back
 *    out with every save that carries it.
 * 7. Whether a secret is set is read from its value: the mask is truthy, '' is not, and a main that stops sending the
 *    mask (or sends it for a secret it no longer holds) turns the page's answer wrong. Only `secretsSet` says.
 * 8. After secrets.set answers, the page's copy keeps the old answer, or takes the typed value in, or loses what it
 *    said of the other secrets.
 * 9. A provider reads as usable from its key's value: the mask for a key main no longer holds makes New agent offer a
 *    provider that cannot start, and a key set with no value in the window hides one that can.
 * 10. The mask the window sends for "the token Tars keeps" (Discord's invite link) is not the one main hands it and
 *     takes back, so main makes the link from the mask itself.
 */

describe('a save never sends a secret (1, 2, 3, 4)', () => {
  it('takes out a secret sent back as the mask, and keeps the rest', () => {
    expect(withoutSecrets({ slackBotToken: SECRET_MASK, slackEnabled: true })).toEqual({ slackEnabled: true });
  });
  it('takes out a mask a field let the user type into', () => {
    expect(withoutSecrets({ slackBotToken: `${SECRET_MASK}x` })).toEqual({});
  });
  it('takes out a key typed into a page', () => {
    expect(withoutSecrets({ openRouterApiKey: 'sk-or-typed', openRouterEnabled: true })).toEqual({ openRouterEnabled: true });
  });
  it('takes out an empty secret, which would not clear it', () => {
    expect(withoutSecrets({ slackAppToken: '', slackEnabled: false })).toEqual({ slackEnabled: false });
  });
  it('takes out secretsSet', () => {
    expect(withoutSecrets({ secretsSet: { slackBotToken: true }, notifyOnError: false })).toEqual({ notifyOnError: false });
  });
});

describe('what is not a secret goes through as it is (5)', () => {
  it('keeps false, 0, an empty string and an empty list', () => {
    const updates = { discordEnabled: false, terminalFontSize: 0, defaultProjectPath: '', hiddenProjects: [] as string[] };
    expect(withoutSecrets(updates)).toEqual(updates);
  });
  it('returns a new object and leaves the one it was given alone', () => {
    const updates = { discordBotToken: 'typed', discordEnabled: true };
    withoutSecrets(updates);
    expect(updates).toEqual({ discordBotToken: 'typed', discordEnabled: true });
  });
});

describe("the window's list is main's (6)", () => {
  it('holds every secret of the settings and every one the window sets', () => {
    for (const f of [...SECRET_FIELDS, ...WINDOW_SET_FIELDS]) expect(WINDOW_SECRETS).toContain(f);
  });
  it('takes every one of them out of a save', () => {
    const all = Object.fromEntries([...SECRET_FIELDS, ...WINDOW_SET_FIELDS].map((f) => [f, 'typed']));
    expect(withoutSecrets(all)).toEqual({});
  });
});

describe('whether a secret is set is what secretsSet says (7)', () => {
  it('reads not set for the mask when secretsSet says not', () => {
    expect(secretIsSet({ discordBotToken: SECRET_MASK, secretsSet: { discordBotToken: false } }, 'discordBotToken')).toBe(false);
  });
  it('reads set with no value in the window', () => {
    expect(secretIsSet({ discordBotToken: '', secretsSet: { discordBotToken: true } }, 'discordBotToken')).toBe(true);
  });
  it('reads not set when secretsSet is missing, whatever the value', () => {
    expect(secretIsSet({ discordBotToken: SECRET_MASK }, 'discordBotToken')).toBe(false);
    expect(secretIsSet(null, 'discordBotToken')).toBe(false);
  });
});

describe("the page's copy after secrets.set (8)", () => {
  it('takes the answer for that secret, keeps the others, and never a value', () => {
    const before = { discordBotToken: '', discordEnabled: true, secretsSet: { discordBotToken: false, slackBotToken: true } };
    const after = withSecretState(before, 'discordBotToken', true);
    expect(after.secretsSet).toEqual({ discordBotToken: true, slackBotToken: true });
    expect(after.discordBotToken).toBe('');
    expect(after.discordEnabled).toBe(true);
    expect(before.secretsSet.discordBotToken).toBe(false);
  });
  it('says a cleared secret is not set', () => {
    expect(withSecretState({ secretsSet: { deepSeekApiKey: true } }, 'deepSeekApiKey', false).secretsSet).toEqual({ deepSeekApiKey: false });
  });
});

describe('a provider is usable from secretsSet, never from a value (9)', () => {
  it('reads a provider enabled with the mask but no key as not usable', () => {
    const a = computeProviderAvailability({}, { deepSeekEnabled: true, deepSeekApiKey: SECRET_MASK, secretsSet: { deepSeekApiKey: false } });
    expect(a.deepseek).toBe(false);
  });
  it('reads a provider enabled with a key set as usable, with no value in the window', () => {
    const a = computeProviderAvailability({}, { veniceEnabled: true, veniceApiKey: '', secretsSet: { veniceApiKey: true } });
    expect(a.venice).toBe(true);
  });
  it('reads OpenRouter, the fallback, the same way', () => {
    const on = computeProviderAvailability({}, { openRouterEnabled: true, secretsSet: { openRouterApiKey: true } });
    expect([on.openrouter, on.qwen, on.moonshot]).toEqual([true, true, true]);
    const off = computeProviderAvailability({}, { openRouterEnabled: true, openRouterApiKey: SECRET_MASK, secretsSet: { openRouterApiKey: false } });
    expect([off.openrouter, off.qwen]).toEqual([false, false]);
  });
});

describe("the mask is main's (10)", () => {
  it('is the very string main hands the window and takes back', () => {
    expect(WINDOW_MASK).toBe(SECRET_MASK);
  });
});
