/**
 * The folders an agent is given besides its own (its secondary folder, a template's vaults), as each CLI can take
 * them, and the refusal of one it never could, said where it is set (the Audit's read of #636 at aef730f1c, L1, I-4).
 *
 * Read in their bundles: gemini 0.70.0 (coerceCommaSeparated) and Qwen Code 0.28.4 (its include-directories coerce)
 * split every --include-directories value at commas and trim each piece, with no escape. A folder named "Acme, Inc"
 * reaches either as two other folders, which it asks about or cannot find: no spelling passes it whole. grok 1.0.92 has
 * no flag for a secondary folder at all (grok-provider.ts), and is handed none.
 */

/** The providers whose CLI splits its added folders at commas: gemini, and Qwen Code, gemini-cli's fork. */
const SPLITS_AT_COMMAS: Record<string, string> = { gemini: 'gemini', 'qwen-code': 'Qwen Code' };

/** A folder such a CLI can never take whole: a comma in its path, or a space at its end, which the split trims. */
export function splitOnItsLine(folder: string): boolean {
  return /,|\s$/.test(folder);
}

/** Why `folder` is not in the agent's workspace, in the window's words, for a CLI that splits at commas. */
export function splitFolderSentence(cli: string, folder: string): string {
  return `${cli} splits the folders it is given at commas, so ${folder} is not in this agent's workspace: rename the folder, or give the agent another`;
}

/**
 * The refusal of a folder the agent's CLI could never see, or null: for gemini or Qwen Code, a secondary folder or a
 * vault whose path holds a comma or ends in a space; for grok, any secondary folder. One sentence, in the window's
 * words, as planModeRefusal answers (providers/plan-mode.ts).
 */
export function addedFolderRefusal(provider: string | undefined, folders: { secondary?: string | null; vaults?: string[] | null }): string | null {
  if (!provider) return null;
  if (provider === 'grok' && folders.secondary) {
    return 'grok takes no secondary folder: it has no flag for one, so it would never see it. Clear the secondary folder, or give this agent another CLI';
  }
  const cli = SPLITS_AT_COMMAS[provider];
  if (!cli) return null;
  const split = [folders.secondary ?? undefined, ...(folders.vaults ?? [])].find((f): f is string => !!f && splitOnItsLine(f));
  return split ? splitFolderSentence(cli, split) : null;
}
