import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loginShellValue, sameFolder, tilde } from '../providers/codex-cli';
import { geminiCliHome } from '../providers/gemini-provider';
import { grokHome } from '../providers/grok-provider';

/**
 * Why a gemini or a grok agent will ask to sign in, when it is this (the Audit's L3 on #645), as codexSignInGap says it
 * for codex (codex-cli.ts). Tars hands each the home it writes (GEMINI_CLI_HOME, GROK_HOME, else the default), and a
 * Tars started from the Dock or Finder reads no rc file: a user whose shell exports another home, where their sign-in
 * is, gets agents with Tars's hooks and servers that ask to sign in. The login shell's value is read once per run, only
 * to say so.
 */

export type HomeCli = 'gemini' | 'grok';

const VARIABLE: Record<HomeCli, string> = { gemini: 'GEMINI_CLI_HOME', grok: 'GROK_HOME' };
const NAME: Record<HomeCli, string> = { gemini: 'gemini', grok: 'grok' };

/**
 * Whether the CLI keeps a sign-in in this home, where it keeps one: gemini 0.70.0 in .gemini/oauth_creds.json under
 * GEMINI_CLI_HOME, grok 1.0.92 in auth.json in GROK_HOME (both read in their own files).
 */
export function signedInAt(cli: HomeCli, home: string): boolean {
  return fs.existsSync(cli === 'gemini' ? path.join(home, '.gemini', 'oauth_creds.json') : path.join(home, 'auth.json'));
}

/**
 * The sentence for the agent's status, or undefined: Tars's home signed in, a key from Settings (which the CLI takes
 * instead of a sign-in), a shell that sets no other home (or a relative one, or the same folder), or that other home
 * not signed in either.
 */
export async function homeSignInGap(opts: {
  cli: HomeCli;
  home: string;
  keyed: boolean;
  shellHome: () => Promise<string | undefined>;
  homeDir?: string;
  signedIn?: (cli: HomeCli, home: string) => boolean;
}): Promise<string | undefined> {
  if (opts.keyed) return undefined;
  const signedIn = opts.signedIn ?? signedInAt;
  if (signedIn(opts.cli, opts.home)) return undefined;
  const other = await opts.shellHome();
  if (!other || !path.isAbsolute(other) || sameFolder(other, opts.home)) return undefined;
  if (!signedIn(opts.cli, other)) return undefined;
  const homeDir = opts.homeDir ?? os.homedir();
  return `${NAME[opts.cli]} asks to sign in: Tars starts it on ${tilde(opts.home, homeDir)}, and your sign-in is in ${tilde(other, homeDir)}, the ${VARIABLE[opts.cli]} your shell sets. Start Tars from that shell, or sign in from this terminal.`;
}

/** What the launch hook needs from the app (main.ts): whether a key from Settings serves the CLI, and how to say it. */
export interface HomeGapDeps {
  keyed: (cli: HomeCli) => boolean;
  notSignedIn: (agentId: string, text: string) => void;
}

let deps: HomeGapDeps | undefined;

export function setHomeGapDeps(next: HomeGapDeps): void {
  deps = next;
}

/** At each gemini or grok launch (core/agent-manager.ts, core/agent-pty.ts): asked off the main thread, said if so. */
export function noteHomeLaunch(agentId: string, cli: HomeCli): void {
  const known = deps;
  if (!known) return;
  const home = cli === 'gemini' ? geminiCliHome() : grokHome();
  homeSignInGap({ cli, home, keyed: known.keyed(cli), shellHome: () => loginShellValue(VARIABLE[cli]) }).then(
    (text) => { if (text) known.notSignedIn(agentId, text); },
    () => { /* nothing known to say */ },
  );
}
