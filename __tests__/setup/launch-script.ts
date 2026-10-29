import * as fs from 'node:fs';

/**
 * A line typed into a shell, read as the command it runs: a line holding a line break goes in as a launch script the
 * shell sources (`. '<file>.sh'`, core/pty-manager.ts shellLine), and the script's first line removes it. Since 2.0.6 a
 * bot's launch prompt has its sender line (the Audit's M3 on #569), so it goes in that way. The script is replaced by
 * its command; a script already gone is left as typed.
 */
export function withLaunchScripts(typed: string): string {
  return typed.replace(/\. '((?:[^']|'\\'')+\.sh)'/g, (whole, quoted: string) => {
    const file = quoted.replace(/'\\''/g, "'");
    if (!fs.existsSync(file)) return whole;
    return fs.readFileSync(file, 'utf8').split('\n').slice(1).join('\n').replace(/\n$/, '');
  });
}
