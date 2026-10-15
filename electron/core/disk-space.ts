import * as fs from 'fs';
import * as os from 'os';

/**
 * No agent starts on a nearly full disk (JeanBrasse, 05/10). On 2026-10-01 the Mac
 * stopped with 68 MB free: worktrees, transcripts and builds kept writing
 * until there was nothing left. Under LAUNCH_MIN_FREE_BYTES a launch is
 * refused, and the refusal says how much is free and what the floor is.
 *
 * A disk whose free space cannot be read refuses nothing: the check guards
 * against one known failure, it is not a reason to stop every launch.
 */
export const LAUNCH_MIN_FREE_BYTES = 2 * 1024 ** 3;

let reader: (() => number | null) | undefined;

/** Test seam: what the free space reads as. */
export function setFreeSpaceReader(fn: (() => number | null) | undefined): void {
  reader = fn;
}

/** Bytes free to the user on the disk the home is on, or null when it cannot be read. */
export function freeSpace(): number | null {
  if (reader) return reader();
  try {
    const stat = fs.statfsSync(os.homedir());
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

function human(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${Number(gb.toFixed(1))} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Why a launch is refused with `free` bytes free, or null when it is not. */
export function diskRefusal(free: number | null): string | null {
  if (free === null || free >= LAUNCH_MIN_FREE_BYTES) return null;
  return `Only ${human(free)} free on this disk: Tars starts no agent under ${human(LAUNCH_MIN_FREE_BYTES)}, since a full disk stops the Mac. Free some space (old worktrees, node_modules, release/) and start it again.`;
}

/** Throws the refusal when the disk is nearly full. */
export function refuseOnFullDisk(): void {
  const why = diskRefusal(freeSpace());
  if (why) throw new Error(why);
}
