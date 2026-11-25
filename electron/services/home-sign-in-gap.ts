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
 * Where gemini 0.70.0 keeps its sign-in, for one environment (read in its bundle): `plain`, .gemini/oauth_creds.json,
 * with its encrypted storage off; `file`, .gemini/gemini-credentials.json, with GEMINI_FORCE_ENCRYPTED_FILE_STORAGE and
 * GEMINI_FORCE_FILE_STORAGE both "true"; `keychain` with the first alone (or that file, when no keychain answers). A
 * keychain sign-in serves every home, so no home can be said not signed in then.
 */
export type GeminiStorage = 'plain' | 'file' | 'keychain';

export function geminiStorage(env: Record<string, string | undefined>): GeminiStorage {
  if (env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE !== 'true') return 'plain';
  return env.GEMINI_FORCE_FILE_STORAGE === 'true' ? 'file' : 'keychain';
}

/**
 * Whether the CLI keeps a sign-in in this home, where it reads one: gemini 0.70.0 in .gemini/oauth_creds.json under
 * GEMINI_CLI_HOME; under its file storage in .gemini/gemini-credentials.json (measured isolated on 25/11: a planted one
 * is what gemini read at its start), or in that oauth_creds.json still, which gemini moves into its store while the
 * store is empty (loadCredentials, then migrateFromFileStorage, read in its bundle; the Audit's L1 on #645 at
 * e2b9af494); grok 1.0.92 in auth.json in GROK_HOME. The keychain is never read: no `security`, no keychain call. That
 * case is not seen here, and homeSignInGap claims nothing when it is possible.
 */
export function signedInAt(cli: HomeCli, home: string, storage: GeminiStorage = 'plain'): boolean {
  if (cli === 'grok') return fs.existsSync(path.join(home, 'auth.json'));
  if (storage === 'keychain') return false;
  const files = storage === 'file' ? ['gemini-credentials.json', 'oauth_creds.json'] : ['oauth_creds.json'];
  return files.some((file) => fs.existsSync(path.join(home, '.gemini', file)));
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
  signedIn?: (cli: HomeCli, home: string, storage: GeminiStorage) => boolean;
  /** gemini's storage as Tars's own environment says it: a cheap check, asked first. */
  storage?: GeminiStorage;
  /** gemini's storage as its CLI runs with it (an rc file may set it), asked only once the cheap checks leave it open. */
  storageAsRun?: () => Promise<GeminiStorage>;
}): Promise<string | undefined> {
  if (opts.keyed) return undefined;
  const signedIn = opts.signedIn ?? signedInAt;
  // The cheap checks first, on Tars's own environment: no login shell is started for them (the Audit's I-2 on #645).
  const cheap = opts.cli === 'gemini' ? opts.storage ?? 'plain' : 'plain';
  if (cheap === 'keychain' || signedIn(opts.cli, opts.home, cheap)) return undefined;
  const storage = opts.cli === 'gemini' && opts.storageAsRun ? await opts.storageAsRun() : cheap;
  if (storage === 'keychain') return undefined;
  if (storage !== cheap && signedIn(opts.cli, opts.home, storage)) return undefined;
  const other = await opts.shellHome();
  if (!other || !path.isAbsolute(other) || sameFolder(other, opts.home)) return undefined;
  if (!signedIn(opts.cli, other, storage)) return undefined;
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

/**
 * At each gemini or grok launch (core/agent-manager.ts, core/agent-pty.ts): asked off the main thread, said if so.
 * Its promise settles once it has said or decided nothing is to be said, for whoever waits; the launches do not.
 */
export function noteHomeLaunch(agentId: string, cli: HomeCli): Promise<void> {
  const known = deps;
  if (!known) return Promise.resolve();
  const home = cli === 'gemini' ? geminiCliHome() : grokHome();
  // gemini's storage as its CLI runs with it: the login shell's value, which starts from Tars's environment and so
  // gives Tars's own where no rc file sets one (once per run each); Tars's own on Windows, where none is read.
  const asRun = async () => geminiStorage({
    GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: (await loginShellValue('GEMINI_FORCE_ENCRYPTED_FILE_STORAGE')) ?? process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE,
    GEMINI_FORCE_FILE_STORAGE: (await loginShellValue('GEMINI_FORCE_FILE_STORAGE')) ?? process.env.GEMINI_FORCE_FILE_STORAGE,
  });
  return homeSignInGap({
    cli, home, keyed: known.keyed(cli), storage: geminiStorage(process.env), storageAsRun: asRun,
    shellHome: () => loginShellValue(VARIABLE[cli]),
  }).then(
    (text) => { if (text) known.notSignedIn(agentId, text); },
    () => { /* nothing known to say */ },
  );
}
