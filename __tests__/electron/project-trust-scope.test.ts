import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Tars never marks the home directory, the root, or anything above the home
 * directory as a trusted Claude Code workspace.
 *
 * ensureProjectTrusted writes `projects[<path>].hasTrustDialogAccepted` into
 * ~/.claude.json before an agent starts, so the trust dialog never shows.
 * Claude Code reads that flag for the working directory and for every
 * directory above it, so a flag on $HOME trusts every folder the account
 * owns, and one on `/` trusts the machine. An agent created with its project
 * set to the home directory, by a typo in the picker or through the API, did
 * exactly that, and silently: the one dialog meant to ask was the one Tars
 * had answered.
 *
 * The ways this can fail, each a case below:
 *  1. The home directory itself is trusted.
 *  2. The home directory spelled with a trailing separator is trusted.
 *  3. The root is trusted.
 *  4. A directory above the home directory is trusted.
 *  5. A link to the home directory is trusted under the link's name, which
 *     Claude Code resolves to the home directory when it starts there.
 *  6. The home directory spelled in another case is trusted on a filesystem
 *     that ignores case, the macOS default. Skipped where the filesystem
 *     does not (Linux), since that spelling is then a different directory.
 *  7. A relative path is trusted: it names whatever the app's working
 *     directory happens to be.
 *  8. Over-correction: an ordinary project below the home directory, or a
 *     directory elsewhere that merely starts with the home directory's
 *     name, is no longer trusted and every agent meets the dialog.
 *  9. A project reached through a link (anything under macOS's /var or /tmp,
 *     a checkout linked elsewhere) is trusted under the spelling Tars saved
 *     alone, while Claude Code starts in its real path and reads the flag
 *     there: the dialog shows, and the agent's first task answers it (the
 *     QA's CLI matrix with the system TMPDIR, 19/10: claude's first task went
 *     into the trust question, and it never called delegate_task).
 *
 * The negative witness for 1 to 7 is the product before this change, which
 * writes every one of them.
 */

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => '0.0.0', on: vi.fn() },
  BrowserWindow: Object.assign(vi.fn(), { getAllWindows: () => [] }),
  Notification: vi.fn(),
}));

import { ensureProjectTrusted } from '../../electron/core/agent-manager';

const home = () => os.homedir();
const claudeJson = () => path.join(home(), '.claude.json');

function trusted(): string[] {
  const config = JSON.parse(fs.readFileSync(claudeJson(), 'utf-8')) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
  return Object.entries(config.projects ?? {}).filter(([, p]) => p.hasTrustDialogAccepted === true).map(([k]) => k);
}

beforeEach(() => {
  fs.writeFileSync(claudeJson(), JSON.stringify({ numStartups: 3, projects: {} }), { mode: 0o600 });
});

describe('ensureProjectTrusted refuses a directory that would trust too much', () => {
  it('1. the home directory', () => {
    ensureProjectTrusted(home());
    expect(trusted()).toEqual([]);
  });

  it('2. the home directory with a trailing separator', () => {
    ensureProjectTrusted(home() + path.sep);
    expect(trusted()).toEqual([]);
  });

  it('3. the root', () => {
    ensureProjectTrusted(path.parse(home()).root);
    expect(trusted()).toEqual([]);
  });

  it('4. every directory above the home directory', () => {
    const above: string[] = [];
    for (let dir = path.dirname(home()); dir !== path.dirname(dir); dir = path.dirname(dir)) above.push(dir);
    expect(above.length, 'the throwaway home sits at the root, nothing is above it').toBeGreaterThan(0);

    for (const dir of above) ensureProjectTrusted(dir);

    expect(trusted()).toEqual([]);
  });

  it('5. a link to the home directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-trust-link-'));
    try {
      const link = path.join(dir, 'looks-like-a-project');
      // A junction: Windows lets any account make one, where a symlink needs a privilege; the type is ignored off Windows.
      fs.symlinkSync(home(), link, 'junction');

      ensureProjectTrusted(link);

      expect(trusted()).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const otherCase = home().replace(/[a-z]/, c => c.toUpperCase()) === home()
    ? home().replace(/[A-Z]/, c => c.toLowerCase())
    : home().replace(/[a-z]/, c => c.toUpperCase());
  const caseBlind = otherCase !== home() && fs.existsSync(otherCase);

  it.skipIf(!caseBlind)('6. the home directory spelled in another case, where the filesystem ignores case', () => {
    ensureProjectTrusted(otherCase);
    expect(trusted()).toEqual([]);
  });

  it('7. a relative path', () => {
    ensureProjectTrusted('.');
    ensureProjectTrusted('some/project');
    expect(trusted()).toEqual([]);
  });
});

describe('ensureProjectTrusted still trusts a project', () => {
  it('8. below the home directory, or beside it under a name that starts like it', () => {
    const project = path.join(home(), 'work', 'project');
    fs.mkdirSync(project, { recursive: true });
    const beside = `${home()}-other`;

    ensureProjectTrusted(project);
    ensureProjectTrusted(beside);

    // The project also under its real path when the throwaway home is reached through a link (case 9); `beside` does not exist.
    expect(trusted().sort()).toEqual([...new Set([beside, project, fs.realpathSync.native(project)])].sort());
  });
});

describe('ensureProjectTrusted trusts a project reached through a link', () => {
  it('9. under the path Claude Code reads, its real one, as well as the one Tars saved', () => {
    const real = path.join(home(), 'elsewhere', 'project');
    fs.mkdirSync(real, { recursive: true });
    const viaLink = path.join(home(), 'linked');
    fs.symlinkSync(path.join(home(), 'elsewhere'), viaLink, 'junction');
    const saved = path.join(viaLink, 'project');

    ensureProjectTrusted(saved);

    expect(trusted().sort()).toEqual([fs.realpathSync.native(saved), saved].sort());
  });
});
