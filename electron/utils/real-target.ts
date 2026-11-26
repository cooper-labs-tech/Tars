import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DATA_DIR_NAME, PRIVATE_DIR_NAME } from '../constants';
import { LEGACY_DATA_DIR_NAME } from '../core/data-dir-move';
import { isUnder, samePath } from '../platform/path-compare';
import { isWithinDir } from './path-identity';
import { fileId, isUnderSafeRoot, withoutHomeCover, type HomeRootDeps } from './home-root';

/**
 * Where a read or a write of a path really lands, and whether that is under a
 * root that is not the home nor above it.
 *
 * The file handlers (fs:read-text-file, fs:write-text-file,
 * fs:read-project-files, local-file://, /api/local-file) judged the path as
 * spelled, then readFileSync / writeFileSync / a read stream followed every
 * link on the way. ~/.tars is one of their roots and every agent is handed
 * it: one symlink in it to the home opened ~/.ssh and ~/.tars-private, to read
 * and to write, and a symlink in a cloned repository did the same through its
 * project. So the target is followed as the call will follow it, and its real
 * location must lie under the real location of a root, on top of the spelled
 * check.
 *
 * A target that does not exist yet (a write that creates it) is judged by its
 * nearest existing folder, the one the file will be created in. A link to
 * nothing, in its place or on the way, is refused: realpath cannot follow it,
 * and a write would, creating the file wherever it points. A loop of links is
 * refused the same way.
 *
 * "Under" is by identity (device and inode, as BigInt) or by the spelling of
 * both real paths, so a root that is itself a link, a case variant or the
 * Data volume's firmlink compares as the folder it names.
 *
 * Only the roots the target or its real path is under by spelling are looked
 * at on the disk, as isUnderSafeRoot does.
 *
 * One exception, asked for by name (`linkedMarkdown`), and only by the
 * renderer's reads and writes of instruction files (fs:read-text-file,
 * fs:write-text-file, fs:read-project-files: the Brain page). /api/local-file,
 * which takes no token, and local-file:// stay strict: there it would serve
 * any note in the home through a link planted under ~/.tars. The exception
 * is for `~/.claude/CLAUDE.md`, or a project's CLAUDE.md or AGENTS.md, linked
 * to a file in a dotfiles repository outside every root, which many Claude
 * Code users keep. The target's last name may be a FILE link out of every root
 * when everything above it really lies in a root (a folder link on the way is
 * the escape itself: ~/.tars/h linked to the home) and the file it finally
 * leads to passes linkedFileAllowed.
 *
 * What remains: the check and the read or write that follows are two calls,
 * so a link swapped in between is followed. Whoever can swap it runs as the
 * same user and can open the file directly (SECURITY.md §1). A hard link has
 * no path back to the file it names and passes (SECURITY.md §5); the one
 * caller that takes no token, /api/local-file, refuses a file with more than
 * one name.
 */

const code = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code;

/**
 * The real path of `target`, links followed; for a target that does not exist,
 * the real path of its nearest existing folder with the missing names after
 * it. Undefined when that cannot be told: a link to nothing on the way, a
 * loop, a folder that cannot be read.
 */
export function realTarget(target: string): string | undefined {
  try {
    return fs.realpathSync.native(target);
  } catch (err) {
    if (code(err) !== 'ENOENT') return undefined;
  }
  const missing: string[] = [];
  for (let dir = target; ;) {
    // Missing to realpath, present to lstat: a link to nothing.
    try {
      fs.lstatSync(dir);
      return undefined;
    } catch (err) {
      if (code(err) !== 'ENOENT') return undefined;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    missing.unshift(path.basename(dir));
    dir = parent;
    try {
      return path.join(fs.realpathSync.native(dir), ...missing);
    } catch (err) {
      if (code(err) !== 'ENOENT') return undefined;
    }
  }
}

function realPath(p: string): string | undefined {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
}

type Inside = (root: string, target: string) => boolean;

/** `real` (a real path) is a safe root, or inside one, among those `spelled` or `real` is under by spelling. */
function inRealRoot(spelled: string, real: string, roots: string[], isInside: Inside, deps: HomeRootDeps): boolean {
  const candidates = withoutHomeCover(roots.filter(root => isInside(root, spelled) || isInside(root, real)), deps)
    .map(root => ({ real: realPath(root), id: fileId(root) }))
    .filter(root => root.real || root.id);
  for (let dir = real; ; dir = path.dirname(dir)) {
    const id = fileId(dir);
    if (candidates.some(root => root.real === dir
      || (id && root.id && id.dev === root.id.dev && id.ino === root.id.ino))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

/**
 * Places a linked file may never lead into: the home's credential folders and
 * Tars's own stores, `~/.config/gh` inside them.
 */
function blockedPlaces(home: string): string[] {
  return [
    '.ssh', '.gnupg', '.aws', '.claude', '.env', DATA_DIR_NAME, LEGACY_DATA_DIR_NAME, PRIVATE_DIR_NAME,
    '.config', '.kube', '.docker', '.netrc', '.git-credentials',
    // The home's application folders (2.0.7): macOS's ~/Library and Windows's AppData keep applications' settings
    // and sign-ins, gh's and gcloud's among them.
    'Library', 'AppData',
  ].map(name => path.join(home, name));
}

/**
 * Inside ~/Library, the folders of the user's own documents, not of an application's: iCloud Drive's own folder,
 * Obsidian's folder in iCloud Drive (where Obsidian keeps every vault it syncs through iCloud), and the cloud drives.
 * The rest of Mobile Documents is applications' iCloud storage, as Application Support is their local one.
 */
function userDocuments(home: string): string[] {
  const icloud = path.join(home, 'Library', 'Mobile Documents');
  return [path.join(icloud, 'com~apple~CloudDocs'), path.join(icloud, 'iCloud~md~obsidian', 'Documents'), path.join(home, 'Library', 'CloudStorage')];
}

const underPlace = (p: string, place: string) => p === place || p.startsWith(place + path.sep) || isWithinDir(p, place);
const byName = (p: string, folder: string) => samePath(p, folder) || isUnder(p, folder);

/**
 * The documents folders by name only, under the home as spelled and where it really lies. Never by identity: a
 * documents folder that is another name for a refused one exempts nothing (the Audit's M3 on #648).
 */
function documentsByName(home: string): string[] {
  return [...new Set([home, realPath(home) ?? home])].flatMap(userDocuments);
}

/** `p` is in `place` (by identity too), and not in one of the user's documents folders inside it (by name). */
const inBlocked = (p: string, place: string, docs: string[]) => underPlace(p, place) && !docs.some(d => byName(p, d));

/**
 * Whether `target` is in a folder of credentials (~/.ssh, ~/.gnupg, ~/.aws,
 * ~/.config, ~/.kube, ~/.docker..., and since 2.0.7 the application folders
 * ~/Library and ~/AppData, but for the documents folders in ~/Library) or is
 * one, as spelled or where it really lies (`real`, its real path, when it has
 * one): the window reads none of them, whatever names it as a project (the
 * Audit's L1 on #466). ~/.claude,
 * ~/.tars and ~/.tars-private, also blocked to a link, have rules of their
 * own (window-file-access.ts).
 */
export function inCredentialPlace(target: string, real: string | null, deps: { home?: string } = {}): boolean {
  const home = deps.home ?? os.homedir();
  const own = new Set(['.claude', DATA_DIR_NAME, PRIVATE_DIR_NAME].map(name => path.join(home, name)));
  const docs = documentsByName(home);
  return blockedPlaces(home).filter(place => !own.has(place)).some(place => [target, real].some(p => !!p && inBlocked(p, place, docs)));
}

/** The places inCredentialPlace judges, taken without blocking: what inPlaceTaken compares a path with. */
export interface PlacesTaken { homes: string[]; places: string[]; docs: string[] }

/**
 * The credential places for a caller that must not block the main thread (fs:list-projects, Review's scan and search),
 * taken once per listing: the home and each place followed asynchronously, each place compared under the home as
 * spelled, under its real path, and where the place itself really lies, so a place that is another name for a folder
 * elsewhere covers that folder, as inCredentialPlace's identity does; the documents folders by name only.
 */
export async function takePlaces(deps: { home?: string } = {}): Promise<PlacesTaken> {
  const home = deps.home ?? os.homedir();
  const homes = [...new Set([home, await fs.promises.realpath(home).catch(() => home)])];
  const own = new Set(['.claude', DATA_DIR_NAME, PRIVATE_DIR_NAME]);
  const mine = (h: string) => blockedPlaces(h).filter(place => !own.has(path.basename(place)));
  const reals = await Promise.all(mine(home).map(place => fs.promises.realpath(place).catch(() => undefined)));
  const places = [...new Set([...homes.flatMap(mine), ...reals.filter((r): r is string => !!r)])];
  return { homes, places, docs: homes.flatMap(userDocuments) };
}

/** inCredentialPlace against places taken by takePlaces: no disk is looked at. */
export function inPlaceTaken(target: string, real: string, taken: PlacesTaken): boolean {
  return taken.places.some(place => [target, real].some(p => byName(p, place) && !taken.docs.some(d => byName(p, d))));
}

const MARKDOWN = /\.(md|markdown|mdx)$/i;

/**
 * Whether a file a link leads to (`realFile`, its real path) may be read and
 * written through that link from outside every root: a regular file, named as
 * markdown, in no blocked place (by spelling, and by identity for a place
 * reached under another name).
 *
 * Markdown only: the Brain page reads and saves CLAUDE.md, AGENTS.md, SKILL.md
 * and README.md, and a credential is not kept in one. The link's own name is
 * whatever the link's maker chose and says nothing; the name of the file it
 * leads to is the file's. So a link to ~/.npmrc, a shell history or a key is
 * refused wherever it lives, not only in the places listed.
 */
export function linkedFileAllowed(realFile: string, deps: { home?: string } = {}): boolean {
  const home = deps.home ?? os.homedir();
  if (!MARKDOWN.test(path.basename(realFile))) return false;
  try {
    if (!fs.statSync(realFile).isFile()) return false;
  } catch {
    return false;
  }
  const docs = documentsByName(home);
  return !blockedPlaces(home).some(place => inBlocked(realFile, place, docs));
}

export interface LandsOptions extends HomeRootDeps {
  /** The dotfiles exception: one file link to a markdown file. Off unless asked for. */
  linkedMarkdown?: boolean;
}

/**
 * isUnderSafeRoot, and the target's real location under the real location of
 * one of `roots` that is not the home nor above it, or, when asked for, the
 * one exception above. `isInside(root, target)` is the caller's own test, by
 * spelling.
 */
export function landsUnderSafeRoot(target: string, roots: string[], isInside: Inside, deps: LandsOptions = {}): boolean {
  if (!isUnderSafeRoot(target, roots, isInside, deps)) return false;
  const real = realTarget(target);
  if (!real) return false;
  if (inRealRoot(target, real, roots, isInside, deps)) return true;
  if (deps.linkedMarkdown !== true) return false;
  // The exception. The folder the target sits in really lies in a root, so
  // only its last name can lead out: a file link (a folder link on the way
  // makes the parent's real path leave every root, and is refused here).
  const parent = path.dirname(target);
  const realParent = realTarget(parent);
  return !!realParent && inRealRoot(parent, realParent, roots, isInside, deps)
    && linkedFileAllowed(real, { home: deps.home });
}
