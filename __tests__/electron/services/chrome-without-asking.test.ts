/**
 * The owner's switch "Claude in Chrome acts without asking" (electron/services/chrome-without-asking.ts): Claude in
 * Chrome acts with no question for every agent, JeanBrasse's decision of 09/11 ("on autorise claude in chrome sans
 * question, en full automatique", "il faut appliquer pour tous les projets"). Measured on claude 2.1.321: under the
 * server's flag tengu_cowork_chrome_automode_default (true on the owner's account), Claude Code takes Claude in
 * Chrome's calls out of bypass and hands them to the auto mode classifier; CLAUDE_CHROME_CLASSIFIER_FLOOR=0 in the
 * CLI's environment puts them back under bypass, and Claude Code then tells the extension to skip its own site checks.
 *
 * How it fails, written before the code (10/11):
 * 1. The switch is on and Tars sets nothing: the server's flag keeps Claude in Chrome out of bypass.
 * 2. Tars sets it for a CLI that is not claude, which reads no such variable and runs no Claude in Chrome.
 * 3. Tars sets it while the switch is off (the default), or for a value that is not exactly true: Tars allows
 *    nothing by itself unless the owner said so.
 * 4. A tool is taken for Claude in Chrome's when its name only holds the server's name further in, or is the server's
 *    name alone.
 * And from the Audit's M1 on #582 (at 97444406d), written before the code:
 * 5. The switch is read from ~/.tars/app-settings.json, which every agent is handed and can write: an agent, or a page
 *    steering one, turns the classifier off for every agent started after it. It lives in ~/.tars-private, which no
 *    agent is handed, and a key in app-settings.json turns nothing on.
 * 6. Two sources: the launch reads one, the route another, so an off in one stays on in the other, and a later save
 *    writes the old value back. One source: what Tars loaded from the private file, changed only by the window's own
 *    channel, read by the launch and the route alike.
 * 7. A hand edit of the private file while Tars runs is taken at once (by an agent too): it is taken at Tars's next
 *    start, the owner's way to turn it on until Settings has a switch (quit Tars, edit, start Tars).
 * 8. The window's channel takes anything but true or false, or forgets what it set across a start.
 * 9. A private file that cannot be read, or holds anything but true, turns it on, or throws at a launch.
 * And from the Audit's re-check of #582 (L3, at 6ad523a6b), written before the code:
 * 10. The switch is read at its first use (the first claude launch or the first Chrome question), not at Tars's start:
 *     a bypass agent that writes the file between the start and that first use turns it on for the current run. It is
 *     read once at the start, before any agent is loaded or launched (main.ts calls loadChromeSwitch before
 *     loadAgents), and a write after the start changes nothing until the next one.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CHROME_SWITCH_FILE, chromeActsWithoutAsking, chromeLaunchEnv, isClaudeInChromeTool, registerChromeSwitchHandlers,
  resetChromeSwitch, setChromeActsWithoutAsking,
} from '../../../electron/services/chrome-without-asking';
import { APP_SETTINGS_FILE, PRIVATE_DIR } from '../../../electron/constants';

/** What a start of Tars does (its test seam): forget what was held, and read the private file again. */
const restart = () => resetChromeSwitch();
const writeByHand = (file: string, body: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };

beforeEach(() => {
  fs.rmSync(CHROME_SWITCH_FILE, { force: true });
  fs.rmSync(APP_SETTINGS_FILE, { force: true });
  restart();
});

describe("the owner's Claude in Chrome switch", () => {
  it('1. on, a claude terminal gets the classifier floor off', () => {
    expect(setChromeActsWithoutAsking(true)).toEqual({ success: true, on: true });
    expect(chromeLaunchEnv('claude')).toEqual({ CLAUDE_CHROME_CLASSIFIER_FLOOR: '0' });
  });

  it('2. never for another CLI', () => {
    setChromeActsWithoutAsking(true);
    for (const cli of ['codex', 'gemini', 'opencode', 'pi', 'qwen', 'grok', '']) expect(chromeLaunchEnv(cli), cli).toEqual({});
  });

  it('3, 9. off by default, and on only for true itself', () => {
    expect(chromeActsWithoutAsking()).toBe(false);
    expect(chromeLaunchEnv('claude')).toEqual({});
    for (const body of ['{"chromeActsWithoutAsking": "true"}', '{"chromeActsWithoutAsking": 1}', '{"chromeActsWithoutAsking": false}', '[true]', 'not json', '']) {
      writeByHand(CHROME_SWITCH_FILE, body);
      restart();
      expect(chromeActsWithoutAsking(), body).toBe(false);
      expect(chromeLaunchEnv('claude'), body).toEqual({});
    }
  });

  it("4. names Claude in Chrome's own tools only", () => {
    for (const tool of ['mcp__claude-in-chrome__navigate', 'mcp__claude-in-chrome__javascript_tool', 'mcp__claude-in-chrome__tabs_context_mcp']) {
      expect(isClaudeInChromeTool(tool), tool).toBe(true);
    }
    for (const tool of ['mcp__evil__claude-in-chrome__navigate', 'mcp__claude-in-chrome', 'mcp__claude-in-chrome__', 'claude-in-chrome__navigate', 'Bash', '']) {
      expect(isClaudeInChromeTool(tool), tool).toBe(false);
    }
  });

  it('5. lives in ~/.tars-private; the key in app-settings.json, which agents can write, turns nothing on', () => {
    expect(CHROME_SWITCH_FILE.startsWith(PRIVATE_DIR + path.sep)).toBe(true);
    writeByHand(APP_SETTINGS_FILE, JSON.stringify({ chromeActsWithoutAsking: true }));
    restart();
    expect(chromeActsWithoutAsking()).toBe(false);
    expect(chromeLaunchEnv('claude')).toEqual({});
    setChromeActsWithoutAsking(true);
    expect(JSON.parse(fs.readFileSync(CHROME_SWITCH_FILE, 'utf8'))).toMatchObject({ chromeActsWithoutAsking: true });
    if (process.platform !== 'win32') expect(fs.statSync(CHROME_SWITCH_FILE).mode & 0o777).toBe(0o600);
  });

  it('6, 8. one source, set by the window\'s own channel and kept across a start', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    registerChromeSwitchHandlers({ handle: (channel, fn) => { handlers.set(channel, fn); } });
    expect(await handlers.get('chromeWithoutAsking:get')!({})).toEqual({ on: false });
    expect(await handlers.get('chromeWithoutAsking:set')!({}, true)).toEqual({ success: true, on: true });
    expect(chromeActsWithoutAsking()).toBe(true);
    expect(chromeLaunchEnv('claude')).toEqual({ CLAUDE_CHROME_CLASSIFIER_FLOOR: '0' });
    for (const value of ['true', 1, null, undefined, {}]) {
      expect(await handlers.get('chromeWithoutAsking:set')!({}, value), JSON.stringify(value)).toMatchObject({ success: false, on: true });
    }
    restart();
    expect(await handlers.get('chromeWithoutAsking:get')!({})).toEqual({ on: true });
    expect(await handlers.get('chromeWithoutAsking:set')!({}, false)).toEqual({ success: true, on: false });
    restart();
    expect(chromeActsWithoutAsking()).toBe(false);
  });

  it('10. read at Tars\'s start, before any agent: a write between the start and the first use changes nothing', () => {
    restart();
    writeByHand(CHROME_SWITCH_FILE, '{ "chromeActsWithoutAsking": true }\n');
    expect(chromeActsWithoutAsking()).toBe(false);
    expect(chromeLaunchEnv('claude')).toEqual({});
    restart();
    expect(chromeActsWithoutAsking()).toBe(true);
    // main.ts reads it before it loads the agents, so before any launch or question.
    const main = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'electron', 'main.ts'), 'utf8');
    const read = main.indexOf('loadChromeSwitch();');
    expect(read, 'main.ts reads the switch at its start').toBeGreaterThan(-1);
    expect(read).toBeLessThan(main.indexOf('loadAgents();'));
  });

  it('7. a hand edit of the private file is taken at the next start, not before', () => {
    expect(chromeActsWithoutAsking()).toBe(false);
    writeByHand(CHROME_SWITCH_FILE, '{ "chromeActsWithoutAsking": true }\n');
    expect(chromeActsWithoutAsking()).toBe(false);
    expect(chromeLaunchEnv('claude')).toEqual({});
    restart();
    expect(chromeActsWithoutAsking()).toBe(true);
    writeByHand(CHROME_SWITCH_FILE, '{ "chromeActsWithoutAsking": false }\n');
    expect(chromeActsWithoutAsking()).toBe(true);
    restart();
    expect(chromeActsWithoutAsking()).toBe(false);
  });
});
