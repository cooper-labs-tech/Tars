import * as fs from 'fs';
import * as path from 'path';
import { updateSharedJsonSync } from './shared-file';
import { trustsTooMuch } from './trust-too-much';

/**
 * A folder as gemini 0.70.0 compares the keys of its trustedFolders.json (`normalizePath`, read in its bundle on 24/11):
 * case-insensitively on macOS and Windows, as given elsewhere.
 */
function geminiKey(folder: string, platform: NodeJS.Platform): string {
  return platform === 'darwin' || platform === 'win32' ? folder.toLowerCase() : folder;
}

/**
 * The folders given trusted in gemini's own store, `<configDir>/trustedFolders.json` (`{ "<folder>": "TRUST_FOLDER" }`,
 * gemini 0.70.0's format, measured 24/11), each by its own path and by its real one: the folder alone, never its
 * parent, and never a folder that trusts too much (the home folder, the root: utils/trust-too-much.ts).
 *
 * The file is the user's, under the rule #634 set for gemini's settings file:
 * - only a folder the file says nothing about is added: an entry the user has for it, whatever its level, and in any case
 *   gemini reads as the same (macOS, Windows), is theirs and is kept;
 * - every other entry is kept; nothing is written when no folder is missing;
 * - a file Tars cannot read as JSON is left exactly as it is, and said: gemini reads its file as JSONC
 *   (`JSON.parse(stripJsonComments(...))`), so a commented file is one gemini reads and Tars cannot yet rewrite with its
 *   comments; this write moves to #634's updateSharedJsoncSync when the two meet, whichever lands second. The launch
 *   goes on, and gemini asks, which is the honest failure;
 * - a file that is JSON but not an object is left and said;
 * - written atomically, parsed again once written (utils/shared-file.ts), an existing file's mode kept, a new one at
 *   0600 as gemini's own saveTrustedFolders creates it.
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
  try {
    const outcome = updateSharedJsonSync<Record<string, unknown>>(file, (current) => {
      if (current !== undefined && (typeof current !== 'object' || current === null || Array.isArray(current))) {
        notAnObject = true;
        return undefined;
      }
      const known = new Set(Object.keys(current ?? {}).map((k) => geminiKey(k, platform)));
      const missing = [...new Map(wanted.map((f) => [geminiKey(f, platform), f])).entries()]
        .filter(([key]) => !known.has(key)).map(([, f]) => f);
      if (!missing.length) return undefined;
      return { ...(current ?? {}), ...Object.fromEntries(missing.map((f) => [f, 'TRUST_FOLDER'])) };
    }, { createMode: 0o600 });
    if (outcome === 'unreadable') console.warn(`[gemini] ${file} is not plain JSON (a comment, or not JSON): Tars left it as it is, the folders a gemini agent adds are not trusted there, and gemini will ask`);
    else if (notAnObject) console.warn(`[gemini] ${file} is not a JSON object: Tars left it as it is, and gemini will ask about the folders a gemini agent adds`);
    else if (outcome === 'busy' || outcome === 'refused') console.warn(`[gemini] ${file} ${outcome === 'busy' ? 'kept changing' : 'did not read back as written'}: the folders a gemini agent adds are not trusted there`);
  } catch (err) {
    console.warn(`[gemini] ${file} could not be read or written: the folders a gemini agent adds are not trusted there`, err instanceof Error ? err.message : err);
  }
}
