import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * No part of the main process finds the home directory through Electron.
 *
 * On macOS app.getPath('home') ignores HOME: measured on 2026-09-16, with HOME
 * on a temp directory it still answered the account's own home, where os.homedir()
 * answered the temp directory. Everything that isolates a Tars (the sandbox
 * script, the e2e, a test) does it with HOME, so each such call was a way for
 * an isolated Tars to reach the real account: seven of them, handing agents the
 * real ~/.claude/mcp.json and writing a prompt file into the real ~/.tars.
 * Seven sites on one cause is a class, so the cause is what is checked.
 *
 * Read from disk with fs rather than with grep: a grep that skips binary files
 * would return nothing for a file it never read, and nothing is the answer
 * this test wants.
 */

const CALL = /getPath\(\s*['"`]home['"`]\s*\)/;

/** Every line of every .ts file under dir that asks Electron for the home path. */
function electronHomeCalls(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'dist' || entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        fs.readFileSync(full, 'utf-8').split('\n').forEach((line, i) => {
          if (CALL.test(line)) found.push(`${path.relative(dir, full)}:${i + 1}`);
        });
      }
    }
  };
  walk(dir);
  return found;
}

describe("the main process's idea of home", () => {
  it('is never asked of Electron', () => {
    expect(electronHomeCalls(path.join(process.cwd(), 'electron'))).toEqual([]);
  });

  it('would be caught if it were', () => {
    // The witness for the check above: an empty list from a scan that reads
    // nothing looks exactly like a clean tree.
    const planted = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-home-scan-'));
    fs.mkdirSync(path.join(planted, 'services'));
    fs.writeFileSync(path.join(planted, 'services', 'bot.ts'),
      "const a = 1;\nconst mcp = path.join(app.getPath('home'), '.claude', 'mcp.json');\n");
    fs.mkdirSync(path.join(planted, 'dist'));
    fs.writeFileSync(path.join(planted, 'dist', 'bot.ts'), "app.getPath('home')\n");

    expect(electronHomeCalls(planted)).toEqual([path.join('services', 'bot.ts') + ':2']);
  });
});
