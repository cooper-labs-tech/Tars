import { execFile } from 'child_process';
import * as os from 'os';
import { safeGit } from '../utils/safe-git';
import { usablePersonName } from './trace-scrub';

export { usablePersonName };

/**
 * The names Tars knows, which the upload masks as `<PERSON_n>` (trace-scrub.ts, trace feature B3, 27/11):
 *
 * - the authors and committers of the project's git history, every branch, as written and as its .mailmap maps
 *   them (`git log --all`, the newest 20,000 commits, through safe-git: execFile, an argv array, no program of the
 *   repository's run);
 * - the account's own name: git's `user.name` as the project's folder reads it, the full name the system keeps
 *   (`id -F` on macOS, the passwd entry's comment on Linux; none read on Windows), and the login name.
 *
 * Not used: GitHub handles, the co-authors a commit message names, names typed in chats or channels, agents' names,
 * the labels of the Claude accounts, an address book (Tars has none). A name no person has (a bot, a service, a
 * generic account) or too short to be told from a word is left out (usablePersonName).
 *
 * Read off the upload's path: the uploader prepares a project's names before it builds that project's session
 * (preparePersonNames), and the scrubber reads them from the cache, so building a session stays synchronous.
 */

export interface NameSources {
  /** The login name, or undefined. */
  login(): string | undefined;
  /** The account's full name as the system keeps it, or undefined. */
  fullName(): Promise<string | undefined>;
}

function run(file: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: 'utf8', timeout: 3000, windowsHide: true }, (err, stdout) => resolve(err ? undefined : String(stdout).trim() || undefined));
  });
}

/** The account's full name: macOS's `id -F`, the comment of Linux's passwd entry; none on Windows. */
async function systemFullName(): Promise<string | undefined> {
  if (process.platform === 'darwin') return run('/usr/bin/id', ['-F']);
  if (process.platform !== 'linux') return undefined;
  let uid: number;
  try { uid = os.userInfo().uid; } catch { return undefined; }
  const entry = await run('getent', ['passwd', String(uid)]);
  const comment = entry?.split(':')[4];
  return comment?.split(',')[0]?.trim() || undefined;
}

export const systemNameSources: NameSources = {
  login: () => { try { return os.userInfo().username; } catch { return undefined; } },
  fullName: systemFullName,
};

const MAX_NAMES = 2000;

/** The names Tars knows for a project: its git history's people and the account's own name, usable ones only. */
export async function personNamesOf(projectPath: string, sources: NameSources = systemNameSources): Promise<string[]> {
  const git = (args: string[]) => safeGit(projectPath, args, { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 }).then(r => r.stdout, () => '');
  const [history, userName, fullName] = await Promise.all([
    git(['log', '--all', '-n', '20000', '--format=%an%x1f%aN%x1f%cn%x1f%cN']),
    git(['config', '--get', 'user.name']),
    sources.fullName().catch(() => undefined),
  ]);
  const found = [...history.split(/[\n\x1f]/), userName, fullName, sources.login()];
  const names = new Set<string>();
  for (const raw of found) {
    if (typeof raw !== 'string') continue;
    const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
    if (name && usablePersonName(name)) names.add(name);
    if (names.size >= MAX_NAMES) break;
  }
  return [...names];
}

/** How long a project's names are kept before they are read again. */
const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; names: string[] }>();
const reading = new Map<string, Promise<string[]>>();

/** A project's names, read now unless read in the last ten minutes. Never rejects. */
export function preparePersonNames(projectPath: string, now = Date.now()): Promise<string[]> {
  const held = cache.get(projectPath);
  if (held && now - held.at < TTL_MS) return Promise.resolve(held.names);
  const pending = reading.get(projectPath);
  if (pending) return pending;
  const read = personNamesOf(projectPath)
    .catch(() => [] as string[])
    .then((names) => { cache.set(projectPath, { at: Date.now(), names }); reading.delete(projectPath); return names; });
  reading.set(projectPath, read);
  return read;
}

/** The names last read for a project, none when never read. */
export function cachedPersonNames(projectPath: string): string[] {
  return cache.get(projectPath)?.names ?? [];
}
