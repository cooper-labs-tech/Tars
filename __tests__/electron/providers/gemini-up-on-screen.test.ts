import { describe, it, expect } from 'vitest';

import { GeminiProvider } from '../../../electron/providers/gemini-provider';

/**
 * A gemini agent takes a typed task once its input field is drawn, not 300 ms after its exec.
 *
 * Measured on gemini 0.70.0 (24/11), in the harness conformance (#638, the real gemini in a Tars agent's terminal):
 * started again on its session (`--resume <uuid>`), gemini took seconds to load and draw its field, and the task Tars
 * typed into it 300 ms after its exec (core/agent-launch.ts, sessionUp, the rule for a CLI with no SessionStart of
 * Claude Code's) was lost: no request reached the model, the delegation "going into its terminal: its turn has not begun
 * yet" for 200 s. Its field, once drawn: `> Type your message or @path/to/file` (`*` before it in yolo); while it asks
 * a question (folder trust, a tool approval), a box stands where the field was.
 *
 * How it fails, written before the code:
 * 1. Up before its field is drawn (the logo and the tips only): the typed task lost.
 * 2. Not up once the field is drawn, in its default mode or in yolo: every task waits for ever.
 * 3. Up while a question box is on the screen: the typed task answers the question and is lost.
 */

const LOADING = [
  ' ▝▜▄     Gemini CLI v0.70.0',
  '   ▝▜▄',
  '  ▗▟▀    Authenticated with gemini-api-key /auth',
  ' ▝▀',
  'Tips for getting started:',
  '1. Create GEMINI.md files to customize your interactions.',
];
const FIELD = [
  '? for shortcuts',
  '────────────────────────────────────────────────────────────',
  ' > Type your message or @path/to/file',
  '────────────────────────────────────────────────────────────',
  ' workspace (/directory)       sandbox          /model',
  ' ~/projects/project-a         no sandbox       gemini-2.5-flash',
];
const YOLO = FIELD.map((l) => l.replace(' > Type', ' * Type')).concat(' YOLO Ctrl+Y');
const QUESTION = [
  '╭──────────────────────────────────────────────────────────╮',
  '│ Do you trust the following folders being added to this workspace? │',
  '│ - /home/me/.tars                                            │',
  '│ ● 1. Yes                                                   │',
  '│   2. Yes, and remember the directories as trusted          │',
  '│   3. No                                                    │',
  '╰──────────────────────────────────────────────────────────╯',
];
const APPROVAL = [
  '│ Action Required                                            │',
  '│ Allow execution of MCP tool "whoami" from server "tars"?   │',
  '│ ● 1. Allow once                                            │',
];

const up = (lines: string[]) => new GeminiProvider().upOnScreen!(lines);

describe('a gemini agent is up once its input field is drawn (1, 2, 3)', () => {
  it('1. not up while it loads', () => {
    expect(up(LOADING)).toBe(false);
  });

  it('2. up once its field is drawn, in its default mode and in yolo', () => {
    expect(up([...LOADING, ...FIELD])).toBe(true);
    expect(up([...LOADING, ...YOLO])).toBe(true);
  });

  it('3. not up while a question box is on the screen, its field drawn or not', () => {
    expect(up([...LOADING, ...QUESTION])).toBe(false);
    expect(up([...LOADING, ...FIELD, ...APPROVAL])).toBe(false);
  });
});
