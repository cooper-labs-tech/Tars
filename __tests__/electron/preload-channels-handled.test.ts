import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Every channel the preload hands the window has a handler in the main
 * process.
 *
 * The preload exposed hermes.testWebhook ('hermes:testWebhook') with no handler
 * behind it and no caller: a page that called it got Electron's "No handler
 * registered for 'hermes:testWebhook'" (#660, 27/11).
 *
 * How it can fail, written before the fix (2026-11-27):
 * 1. The preload invokes or sends on a channel no ipcMain.handle / ipcMain.on
 *    of the main process answers.
 * 2. The check misses a channel because of how it is written: send rather than
 *    invoke, or the channel's name on the line after the call.
 * 3. The check counts as missing the two channels Sentry's own SDK answers
 *    (@sentry/electron/main registers sentry-ipc.start and sentry-ipc.envelope
 *    with ipcMain.on, under its createKey).
 * 4. The check reads nothing (a path that moved) and passes on an empty list.
 */

const root = path.resolve(__dirname, '..', '..');
const CALL = /ipcRenderer\.(?:invoke|send|sendSync)\(\s*'([^']+)'/g;
const HANDLER = /ipcMain\.(?:handle|handleOnce|on|once)\(\s*'([^']+)'/g;
/** Answered by @sentry/electron/main (main/ipc.js: ipcMain.on(ipcUtil.createKey('start' | 'envelope'))). */
const SENTRY_SDK = new Set(['sentry-ipc.start', 'sentry-ipc.envelope']);

function channels(source: string, pattern: RegExp): Set<string> {
  return new Set(Array.from(source.matchAll(pattern), m => m[1]));
}

function mainProcessSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'dist' || entry.name === 'node_modules' ? [] : mainProcessSources(full);
    return entry.name.endsWith('.ts') && full !== path.join(root, 'electron', 'preload.ts') ? [fs.readFileSync(full, 'utf-8')] : [];
  });
}

describe('the preload\'s channels', () => {
  const called = channels(fs.readFileSync(path.join(root, 'electron', 'preload.ts'), 'utf-8'), CALL);
  const handled = new Set(mainProcessSources(path.join(root, 'electron')).flatMap(source => [...channels(source, HANDLER)]));

  it('are read, both sides (4)', () => {
    expect(called.size).toBeGreaterThan(200);
    expect(handled.size).toBeGreaterThan(200);
    expect(called.has('sentry-ipc.envelope')).toBe(true); // a send, not an invoke
    // A name on the line after the call is read too: none is written so today, and a later one would not hide.
    expect(channels("ipcRenderer.invoke(\n      'later:channel', params)", CALL)).toEqual(new Set(['later:channel']));
  });

  it('each have a handler in the main process, or are Sentry\'s own (1, 2, 3)', () => {
    const unanswered = [...called].filter(channel => !handled.has(channel) && !SENTRY_SDK.has(channel));
    expect(unanswered).toEqual([]);
  });
});
