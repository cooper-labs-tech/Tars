import * as fs from 'fs';
import * as path from 'path';
import { updateSharedJsonSync } from './shared-file';
import { trustsTooMuch } from './trust-too-much';

/**
 * The folders given trusted in gemini's own store, `<configDir>/trustedFolders.json` (`{ "<folder>": "TRUST_FOLDER" }`,
 * gemini 0.70.0's format, measured 24/11), each by its own path and by its real one: the folder alone, never its
 * parent, and never a folder that trusts too much (the home folder, the root: utils/trust-too-much.ts). The user's own
 * entries are kept; a file that is not JSON is left as it was, and gemini then asks; nothing is written when every
 * folder is already there.
 */
export function trustGeminiFolders(folders: string[], configDir: string): void {
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
  try {
    const outcome = updateSharedJsonSync<Record<string, unknown>>(file, (current) => {
      if (current !== undefined && (typeof current !== 'object' || current === null || Array.isArray(current))) return undefined;
      const missing = wanted.filter((f) => current?.[f] !== 'TRUST_FOLDER');
      if (!missing.length) return undefined;
      return { ...(current ?? {}), ...Object.fromEntries(missing.map((f) => [f, 'TRUST_FOLDER'])) };
    }, { createMode: 0o644 });
    if (outcome === 'unreadable') console.warn(`[gemini] ${file} is not JSON: the folders a gemini agent adds are not trusted there, and gemini will ask`);
    else if (outcome === 'busy') console.warn(`[gemini] ${file} kept changing: the folders a gemini agent adds are not trusted there`);
  } catch (err) {
    console.warn(`[gemini] ${file} could not be read or written: the folders a gemini agent adds are not trusted there`, err instanceof Error ? err.message : err);
  }
}
