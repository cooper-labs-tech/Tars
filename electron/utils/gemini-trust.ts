import * as fs from 'fs';
import * as path from 'path';
import { updateSharedJsonSync } from './shared-file';
import { trustsTooMuch } from './trust-too-much';

type GeminiTrustLevel = 'TRUST_FOLDER' | 'TRUST_PARENT' | 'DO_NOT_TRUST';
const LEVELS: readonly string[] = ['TRUST_FOLDER', 'TRUST_PARENT', 'DO_NOT_TRUST'];

/** The path module gemini uses on the platform: path.win32 on Windows, else POSIX paths. */
const pathsOf = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path.posix);

/** A folder's real path when it exists, else the folder as written, as gemini resolves it (`getRealPath`). */
function realOf(folder: string): string {
  try {
    return fs.existsSync(folder) ? fs.realpathSync(folder) : folder;
  } catch {
    return folder;
  }
}

/** gemini's `normalizePath`: resolved, `\` made `/`, lower case on macOS and Windows. */
function normalise(folder: string, platform: NodeJS.Platform): string {
  const resolved = pathsOf(platform).resolve(folder).replace(/\\/g, '/');
  return platform === 'darwin' || platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** gemini's `isSubpath`: the child is the parent or lies under it. */
function isUnder(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const paths = pathsOf(platform);
  let p = paths.resolve(parent);
  let c = paths.resolve(child);
  if (platform === 'win32' && (p.includes('~') || c.includes('~'))) {
    try {
      p = fs.realpathSync.native(p);
      c = fs.realpathSync.native(c);
    } catch {
      // gemini keeps the paths as they are when a short name does not resolve
    }
  }
  if (platform === 'darwin') {
    p = p.toLowerCase();
    c = c.toLowerCase();
  }
  const relative = paths.relative(p, c);
  return !relative.startsWith(`..${paths.sep}`) && relative !== '..' && !paths.isAbsolute(relative);
}

/**
 * What gemini 0.70.0 decides about a folder from the rules of its trustedFolders.json (`loadTrustedFolders` and
 * `isPathTrusted`, read in its bundle on 24/11): each key normalised as the file is loaded, a later key that normalises
 * the same replacing the earlier one; a TRUST_PARENT rule taken as its parent folder; each rule's real path; and the
 * longest key whose folder holds the folder decides. True for either trust, false for DO_NOT_TRUST, undefined when no
 * rule covers the folder, where gemini asks.
 */
export function geminiDecides(folder: string, rules: Record<string, unknown>, platform: NodeJS.Platform = process.platform): boolean | undefined {
  const loaded = loadRules(rules, platform);
  const location = normalise(realOf(folder), platform);
  let longest = -1;
  let decision: GeminiTrustLevel | undefined;
  for (const [key, level] of loaded) {
    const ruled = level === 'TRUST_PARENT' ? pathsOf(platform).dirname(key) : key;
    if (isUnder(normalise(realOf(ruled), platform), location, platform) && key.length > longest) {
      longest = key.length;
      decision = level;
    }
  }
  if (decision === 'DO_NOT_TRUST') return false;
  return decision ? true : undefined;
}

/** The rules as gemini's loadTrustedFolders keeps them: each key normalised, a later one replacing an earlier. */
function loadRules(rules: Record<string, unknown>, platform: NodeJS.Platform): Map<string, GeminiTrustLevel> {
  const loaded = new Map<string, GeminiTrustLevel>();
  for (const [key, level] of Object.entries(rules)) {
    if (typeof level === 'string' && LEVELS.includes(level)) loaded.set(normalise(key, platform), level as GeminiTrustLevel);
  }
  return loaded;
}

/**
 * Whether an entry for `folder` would outrank a refusal of a folder inside it (the Audit's L1 on c4a084a0f): a
 * DO_NOT_TRUST rule whose real folder lies under `folder`, written under a key no longer than the one Tars would write
 * (a link to `folder`, a short name on Windows). gemini takes the longest key that holds a folder, so Tars's would
 * then decide that inner folder, and trust it. A key of the same length is outranked too once gemini rewrites the file
 * in another order, so it counts.
 */
function outranksARefusalInside(folder: string, rules: Record<string, unknown>, platform: NodeJS.Platform): boolean {
  const own = normalise(folder, platform);
  const ownReal = normalise(realOf(folder), platform);
  for (const [key, level] of loadRules(rules, platform)) {
    if (level !== 'DO_NOT_TRUST' || key.length > own.length) continue;
    const ruled = normalise(realOf(key), platform);
    if (ruled !== ownReal && isUnder(ownReal, ruled, platform)) return true;
  }
  return false;
}

/**
 * The folders given trusted in gemini's own store, `<configDir>/trustedFolders.json` (`{ "<folder>": "TRUST_FOLDER" }`,
 * gemini 0.70.0's format, measured 24/11), each under the spelling it is given: gemini resolves a key's real path, so
 * that entry covers the folder's real spelling too, and the real one is never written beside it. The folder alone,
 * never its parent, and never a folder that trusts too much (the home folder, the root: utils/trust-too-much.ts).
 *
 * The file is the user's, under the rule #634 set for gemini's settings file:
 * - a folder is added only when no rule of the file covers it, decided as gemini decides (`geminiDecides`): a rule of
 *   the user's on the folder or on a parent, under any spelling gemini reads as the same, trust or refusal, is theirs
 *   and decides. A folder the user refused is left untrusted, and said once: gemini then leaves it out of the agent's
 *   workspace without a question;
 * - nor when its entry would outrank a refusal of a folder inside it written under a shorter spelling
 *   (`outranksARefusalInside`): the added folder is left untrusted then, and said, so that no decision of the user's
 *   changes (the Audit's L1 on c4a084a0f);
 * - a file holding a value that is not one of gemini's three levels, which gemini's own start refuses, or a relative
 *   key, which gemini reads from the agent's folder and this writer cannot (it is not told that folder), is left as it
 *   is and said (L2, I-1): writing beside either could turn the user's refusal into trust;
 * - every other entry is kept; nothing is written when no folder is missing;
 * - a file Tars cannot read as JSON is left exactly as it is, and said: gemini reads its file as JSONC
 *   (`JSON.parse(stripJsonComments(...))`), so a commented file is one gemini reads and Tars cannot yet rewrite with its
 *   comments; this write moves to #634's updateSharedJsoncSync when the two meet, whichever lands second. The launch
 *   goes on, and gemini asks, which is the honest failure;
 * - a file that is JSON but not an object is left and said;
 * - written atomically, parsed again once written (utils/shared-file.ts), an existing file's mode kept, a new one at
 *   0600 as gemini's own saveTrustedFolders creates it.
 * The entries Tars adds stay when the agent, or its secondary folder, is removed: Tars cannot tell its own entry from
 * the same entry the user wrote, so it never removes one (SPECS, gemini's row; SECURITY).
 */
export function trustGeminiFolders(folders: string[], configDir: string, platform: NodeJS.Platform = process.platform): void {
  const wanted = [...new Set(folders.filter((f) => f && !trustsTooMuch(f)).flatMap((f) => {
    try {
      const real = fs.realpathSync(f);
      return trustsTooMuch(real) ? [] : [f, real];
    } catch {
      return [];
    }
  }))];
  if (!wanted.length) return;
  const file = path.join(configDir, 'trustedFolders.json');
  let notAnObject = false;
  let unreadKeys: 'level' | 'relative' | undefined;
  let refused: string[] = [];
  let inside: string[] = [];
  try {
    const outcome = updateSharedJsonSync<Record<string, unknown>>(file, (current) => {
      unreadKeys = undefined;
      if (current !== undefined && (typeof current !== 'object' || current === null || Array.isArray(current))) {
        notAnObject = true;
        return undefined;
      }
      const entries = Object.entries(current ?? {});
      if (entries.some(([, level]) => typeof level !== 'string' || !LEVELS.includes(level))) { unreadKeys = 'level'; return undefined; }
      if (entries.some(([key]) => !pathsOf(platform).isAbsolute(key))) { unreadKeys = 'relative'; return undefined; }
      const next: Record<string, unknown> = { ...(current ?? {}) };
      refused = [];
      inside = [];
      let added = false;
      for (const folder of wanted) {
        const decided = geminiDecides(folder, next, platform);
        if (decided === false) refused.push(folder);
        if (decided !== undefined) continue;
        if (outranksARefusalInside(folder, next, platform)) { inside.push(folder); continue; }
        next[folder] = 'TRUST_FOLDER';
        added = true;
      }
      return added ? next : undefined;
    }, { createMode: 0o600 });
    if (outcome === 'unreadable') console.warn(`[gemini] ${file} is not plain JSON (a comment, or not JSON): Tars left it as it is, the folders a gemini agent adds are not trusted there, and gemini will ask`);
    else if (notAnObject) console.warn(`[gemini] ${file} is not a JSON object: Tars left it as it is, and gemini will ask about the folders a gemini agent adds`);
    else if (unreadKeys === 'level') console.warn(`[gemini] ${file} holds a value that is not one of gemini's trust levels (TRUST_FOLDER, TRUST_PARENT, DO_NOT_TRUST), which gemini's own start refuses: Tars left it as it is, and gemini will ask about the folders a gemini agent adds`);
    else if (unreadKeys === 'relative') console.warn(`[gemini] ${file} holds a relative folder, which gemini reads from the agent's own folder: Tars left it as it is, and gemini will ask about the folders a gemini agent adds`);
    else if (outcome === 'busy' || outcome === 'refused') console.warn(`[gemini] ${file} ${outcome === 'busy' ? 'kept changing' : 'did not read back as written'}: the folders a gemini agent adds are not trusted there`);
    if (refused.length && outcome !== 'unreadable' && !notAnObject) console.warn(`[gemini] ${file} does not trust ${refused.join(', ')}: Tars left ${refused.length > 1 ? 'them' : 'it'} untrusted, as the user said, and gemini leaves ${refused.length > 1 ? 'them' : 'it'} out of a gemini agent's workspace`);
    if (inside.length && outcome !== 'unreadable' && !notAnObject && !unreadKeys) console.warn(`[gemini] ${file} refuses a folder inside ${inside.join(', ')} under a shorter spelling, which Tars's entry would outrank: Tars left ${inside.length > 1 ? 'them' : 'it'} untrusted, and gemini will ask about ${inside.length > 1 ? 'them' : 'it'}`);
  } catch (err) {
    console.warn(`[gemini] ${file} could not be read or written: the folders a gemini agent adds are not trusted there`, err instanceof Error ? err.message : err);
  }
}
