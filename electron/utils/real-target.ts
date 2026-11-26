import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DATA_DIR_NAME, PRIVATE_DIR_NAME } from '../constants';
import { LEGACY_DATA_DIR_NAME } from '../core/data-dir-move';
import { isUnder, samePath } from '../platform/path-compare';
import { isWithinDir } from './path-identity';
import { fileId, isUnderSafeRoot, withoutHomeCover, type FileId, type HomeRootDeps } from './home-root';

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
 * Below ~/Library, the folders of the user's own documents, not of an application's: iCloud Drive's own folder,
 * Obsidian's folder in iCloud Drive (where Obsidian keeps every vault it syncs through iCloud), and the cloud drives.
 * The rest of Mobile Documents is applications' iCloud storage, as Application Support is their local one.
 */
const DOCUMENTS_BELOW_LIBRARY = [
  path.join('Mobile Documents', 'com~apple~CloudDocs'), path.join('Mobile Documents', 'iCloud~md~obsidian', 'Documents'), 'CloudStorage',
];
const inDocuments = (below: string | undefined) => below !== undefined && DOCUMENTS_BELOW_LIBRARY.some(d => samePath(below, d) || isUnder(below, d));

const underPlace = (p: string, place: string) => p === place || p.startsWith(place + path.sep) || isWithinDir(p, place);
const byName = (p: string, folder: string) => samePath(p, folder) || isUnder(p, folder);
const sameId = (a: FileId | undefined, b: FileId | undefined) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;

/** `real` and every folder above it, nearest first. */
function upFrom(real: string): string[] {
  const out: string[] = [];
  for (let p = real; ; p = path.dirname(p)) {
    out.push(p);
    if (path.dirname(p) === p) return out;
  }
}

/**
 * Where `p` lies below `dir`, found by identity: `p`'s real path walked up to the folder that is `dir` (its device
 * and inode, `dir` followed when it is a link), and the names below that folder. Undefined when `p` is not in `dir`
 * or cannot be followed. Whatever spelling either has, the same folder is the same folder.
 */
function belowByIdentity(p: string, dir: string): string | undefined {
  const id = fileId(dir);
  const real = realTarget(p);
  if (!id || !real) return undefined;
  for (const up of upFrom(real)) if (sameId(fileId(up), id)) return path.relative(up, real);
  return undefined;
}

/**
 * The name of the home's folder `p` is in or is, found by identity: `p`'s real path walked up to the folder whose
 * parent is the home (its device and inode). A home reached by another spelling is the same home. Undefined for the
 * home itself, outside it, or when it cannot be told.
 */
export function homeFolderOf(p: string, deps: { home?: string } = {}): string | undefined {
  const home = fileId(deps.home ?? os.homedir());
  const real = realTarget(p);
  if (!home || !real) return undefined;
  const ups = upFrom(real);
  for (let i = 0; i + 1 < ups.length; i++) if (sameId(fileId(ups[i + 1]), home)) return path.basename(ups[i]);
  return undefined;
}

/**
 * `p` is in `place` (by spelling or by identity), and not, when `place` is ~/Library, in one of the user's documents
 * folders there: told by the names below ~/Library where `p` really lies, ~/Library found by identity. The documents
 * exception is ~/Library's alone: a credential folder kept in a documents folder stays refused, and a documents folder
 * that is another name for a refused one exempts nothing (the Audit's M3 and M4 on #648).
 */
const inBlocked = (p: string, place: string, library: string) =>
  underPlace(p, place) && !(place === library && inDocuments(belowByIdentity(p, place)));

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
  const library = path.join(home, 'Library');
  return blockedPlaces(home).filter(place => !own.has(place)).some(place => [target, real].some(p => !!p && inBlocked(p, place, library)));
}

const fileIdAsync = (p: string): Promise<FileId | undefined> => fs.promises.stat(p, { bigint: true })
  .then(st => (st.ino === BigInt(0) ? undefined : { dev: st.dev, ino: st.ino }), () => undefined);

/** A place inPlaceTaken compares with: its names, its identity, and whether it is ~/Library. */
export interface PlaceTaken { names: string[]; id?: FileId; library: boolean }

/** The places inCredentialPlace judges, taken without blocking: what inPlaceTaken compares a path with. */
export interface PlacesTaken { homes: string[]; places: PlaceTaken[]; home?: FileId; own: FileId[] }

/**
 * The credential places for a caller that must not block the main thread (fs:list-projects, Review's scan and search),
 * taken once per listing: the home, Tars's own folders and each place followed asynchronously. Each place is compared
 * by its names under the home as spelled, under its real path, and where the place itself really lies, and by its
 * identity, as inCredentialPlace compares it.
 */
export async function takePlaces(deps: { home?: string } = {}): Promise<PlacesTaken> {
  const home = deps.home ?? os.homedir();
  const homes = [...new Set([home, await fs.promises.realpath(home).catch(() => home)])];
  const own = new Set(['.claude', DATA_DIR_NAME, PRIVATE_DIR_NAME]);
  const places = await Promise.all(blockedPlaces(home).filter(place => !own.has(path.basename(place))).map(async (place) => {
    const below = path.relative(home, place);
    const real = await fs.promises.realpath(place).catch(() => undefined);
    return { names: [...new Set([...homes.map(h => path.join(h, below)), ...(real ? [real] : [])])], id: await fileIdAsync(place), library: below === 'Library' };
  }));
  const [homeId, ...ownIds] = await Promise.all([home, path.join(home, DATA_DIR_NAME), path.join(home, PRIVATE_DIR_NAME)].map(fileIdAsync));
  return { homes, places, home: homeId, own: ownIds.filter((o): o is FileId => !!o) };
}

/** A real path and each folder above it, nearest first, with their identities: taken once per project, without blocking. */
export type Ancestry = Array<{ path: string; id?: FileId }>;

export async function takeAncestry(real: string): Promise<Ancestry> {
  return Promise.all(upFrom(real).map(async (p) => ({ path: p, id: await fileIdAsync(p) })));
}

/** inCredentialPlace against places taken by takePlaces and the real path's ancestry: no disk is looked at. */
export function inPlaceTaken(target: string, real: string, taken: PlacesTaken, ancestry: Ancestry): boolean {
  return taken.places.some((place) => {
    const exempt = (below: string) => place.library && inDocuments(below);
    for (const p of [target, real]) {
      const name = place.names.find(n => byName(p, n));
      if (name && !exempt(path.relative(name, p))) return true;
    }
    const at = place.id ? ancestry.find(a => sameId(a.id, place.id)) : undefined;
    return !!at && !exempt(path.relative(at.path, real));
  });
}

/** homeFolderOf, from an ancestry taken without blocking. */
export function homeFolderIn(ancestry: Ancestry, home: FileId | undefined): string | undefined {
  for (let i = 0; i + 1 < ancestry.length; i++) if (sameId(ancestry[i + 1].id, home)) return path.basename(ancestry[i].path);
  return undefined;
}

/** Whether a real path is in, or is, one of `own` (Tars's folders), by identity, from its ancestry. */
export const ownIn = (ancestry: Ancestry, own: FileId[]) => ancestry.some(a => own.some(o => sameId(a.id, o)));

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
  const library = path.join(home, 'Library');
  return !blockedPlaces(home).some(place => inBlocked(realFile, place, library));
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
