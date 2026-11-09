import * as fs from 'fs';
import { privatePath } from '../constants';
import { writeSecretFileSync } from '../utils/secret-file';

/**
 * The owner's switch "Claude in Chrome acts without asking" (2.0.7, off by default): Claude in Chrome acts with no
 * question, for every agent of every project. JeanBrasse's decision of 09/11, "on autorise claude in chrome sans
 * question, en full automatique", "il faut appliquer pour tous les projets". It goes against "Tars allows nothing by
 * itself", which is why it is the owner's to turn on, and SECURITY.md, "Claude in Chrome without asking", says what it
 * opens.
 *
 * Two halves, both measured on claude 2.1.321:
 * - An agent in bypass. Under the server's flag tengu_cowork_chrome_automode_default (true on the owner's account),
 *   Claude Code takes Claude in Chrome's calls out of bypass and hands each to the auto mode classifier, which may
 *   refuse it or put it to a person. CLAUDE_CHROME_CLASSIFIER_FLOOR=0 in the CLI's environment puts them back under
 *   bypass, and Claude Code then tells the extension to skip its own site checks (set_permission_mode
 *   skip_all_permission_checks). Set when the terminal starts: an agent started before the switch was turned on keeps
 *   the classifier until its next start.
 * - Any other agent, or a Chrome call that still reaches a dialog: the state mod asks Tars, and Tars allows a call of
 *   Claude in Chrome's own tools at once (hooks-routes.ts), writing who decided in permissions.log. Not a withheld one:
 *   what the window cannot show whole is never allowed by anyone but the terminal.
 *
 * One source, out of the agents' folders (the Audit's M1 on #582): ~/.tars-private/owner-switches.json, which no agent
 * is handed (~/.tars, where app-settings.json is, is in every agent's --add-dir). Read once, at its first use after
 * Tars starts, and changed only by the window's own channel (chromeWithoutAsking:set), which writes the file and what
 * Tars holds together; the launch and the route read what Tars holds. A hand edit, or anything else that writes the
 * file while Tars runs, is taken at Tars's next start, never at once.
 */

/** The owner's switches, kept where no agent is handed them. */
export const CHROME_SWITCH_FILE = privatePath('owner-switches.json');
const KEY = 'chromeActsWithoutAsking';

/** What Tars holds: undefined until its first use, then what the private file said, then what the window set. */
let held: boolean | undefined;

/** The private file's word: on only for `true` itself; a file missing, unreadable or holding anything else is off. */
function readSwitch(): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(CHROME_SWITCH_FILE, 'utf-8'));
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed[KEY] === true;
  } catch {
    return false;
  }
}

export function chromeActsWithoutAsking(): boolean {
  if (held === undefined) held = readSwitch();
  return held;
}

/** The window's change: true or false only, written to the private file, then held. */
export function setChromeActsWithoutAsking(value: unknown): { success: true; on: boolean } | { success: false; on: boolean; error: string } {
  if (typeof value !== 'boolean') return { success: false, on: chromeActsWithoutAsking(), error: 'on or off: true or false' };
  try {
    writeSecretFileSync(CHROME_SWITCH_FILE, `${JSON.stringify({ [KEY]: value }, null, 2)}\n`);
  } catch (err) {
    return { success: false, on: chromeActsWithoutAsking(), error: `${CHROME_SWITCH_FILE} could not be written: ${err instanceof Error ? err.message : String(err)}` };
  }
  held = value;
  console.log(`[chrome] Claude in Chrome acts without asking: ${value ? 'on' : 'off'}, set from the window`);
  return { success: true, on: value };
}

/** The window's own channel: what the switch is, and its change. No API route reaches it, so no agent does. */
export function registerChromeSwitchHandlers(ipc: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void }): void {
  ipc.handle('chromeWithoutAsking:get', () => ({ on: chromeActsWithoutAsking() }));
  ipc.handle('chromeWithoutAsking:set', (_event, value) => setChromeActsWithoutAsking(value));
}

/** The prefix of Claude in Chrome's tools in Claude Code: the server `claude-in-chrome`, then the tool's name. */
const CHROME_TOOL = /^mcp__claude-in-chrome__[A-Za-z0-9_-]+$/;

/**
 * A call of Claude in Chrome's own tools. The name is enough: claude 2.1.321 reserves the server name
 * claude-in-chrome for its built-in server and loads no other under it (measured: `--mcp-config` warns "is a
 * reserved MCP server name and was not loaded", and a project's .mcp.json server of that name never loads, while the
 * same server under another name does).
 */
export function isClaudeInChromeTool(tool: string): boolean {
  return CHROME_TOOL.test(tool);
}

/** What a claude terminal's launch adds while the switch is on (core/agent-pty.ts): the classifier floor off. */
export function chromeLaunchEnv(binaryName: string): Record<string, string> {
  return binaryName === 'claude' && chromeActsWithoutAsking() ? { CLAUDE_CHROME_CLASSIFIER_FLOOR: '0' } : {};
}

/** Test seam: forget what Tars holds, as a start of Tars does. */
export function resetChromeSwitch(): void {
  held = undefined;
}
