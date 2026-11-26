import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * What the window may read and write on the disk (the Audit's Holes 1 and 2,
 * 2.0.4). The window is the renderer: a page with an XSS, or a dependency of it
 * gone bad, holds every channel the preload hands it.
 *
 * Hole 1: fs:write-text-file wrote any text under ~/.dorothy, ~/.claude,
 * ~/.codex, ~/.gemini, ~/.grok and every project: statusline.sh, which Claude
 * Code runs, bin/tars-mcp-node, which every Tars MCP server runs on, a CLI's
 * hooks or settings, a project's git hooks. One call ran code in every agent.
 * The one page that writes (the Brain) writes instruction files.
 *
 * Hole 2: local-file:// and fs:read-text-file served anything under ~/.tars
 * and ~/.claude, every key app-settings.json held and Claude Code's credentials
 * included.
 *
 * Every way it can fail, written before the code (2026-10-18):
 *  W1. A read hands the window a secret: the settings, the private file, the
 *      shared token (where it is and where it was), the Hermes files, a CLI's
 *      own credentials (~/.claude/.credentials.json, ~/.codex/auth.json,
 *      ~/.gemini/oauth_creds.json), anything under ~/.tars-private.
 *  W2. A secret reached another way: a symbolic link in a project, or a hard
 *      link to the private file, which has no path back to it.
 *  W3. Over-correction: the Brain cannot read what it shows (~/.claude/CLAUDE.md,
 *      ~/.claude/mcp.json, ~/.tars/CLAUDE.md, a project's CLAUDE.md), or the
 *      code panel a project's file.
 *  W4. A write lands on something that runs: statusline.sh, bin/tars-mcp-node,
 *      a hook of Tars's or of a CLI, a CLI's settings or config, a project's
 *      package.json or git hook, or any file that is not an instruction file.
 *  W5. Over-correction: the Brain cannot save an instruction file it edits
 *      (~/.claude/CLAUDE.md, ~/.tars/CLAUDE.md, a project's CLAUDE.md or
 *      .claude/CLAUDE.md).
 *  W6. local-file:// serves outside what a page may show (vault attachments,
 *      the project-files folders, Claude Code's memory folders), or serves a
 *      secret through a link placed in one of those.
 *  W7. (The Audit's mutant W3 on #466, added 2026-10-19) local-file:// serves
 *      a file with a second name outside the private folder, which no name and
 *      no inode check of Tars's knows: an agent's hard link, in its project's
 *      folder of files, to an SSH key or a CLI's credentials.
 * Added before their code after the Audit's L1 on #466 (2026-10-19):
 *  W8. A folder of credentials taken for a project, added from a page or
 *      written into the projects' list, which lives in ~/.tars, every
 *      agent's: ~/.ssh, ~/.gnupg, ~/.aws, ~/.config (GitHub's hosts.yml),
 *      ~/.kube, ~/.docker, or a folder under one, or a link to one, and the
 *      window reads what it holds. Or, over-correcting, a real project refused.
 *  W9. A project's .env.local or .env.production read: only .env was a secret.
 *  W10. A CLI's settings that hold a key read: ~/.claude/settings.json and
 *      settings.local.json (their env), a project's .claude/settings.local.json,
 *      Grok CLI's ~/.grok/user-settings.json.
 * Added before their code after the Audit's L3 on #648 (2026-11-26):
 *  W11. A folder of the home whose name starts with a dot, other than the four
 *      CLI folders the window reads (~/.claude, ~/.codex, ~/.gemini, ~/.grok),
 *      taken for a project, or one inside it: ~/.azure, ~/.terraform.d,
 *      ~/.wrangler, ~/.cargo, ~/.m2, ~/.qwen, ~/.pi, ~/.kimi-code; or the
 *      application folders, ~/Library and ~/AppData, or one inside them; and
 *      the window reads, as a project's, what such a folder holds.
 *  W12. Over-correction: one of the four CLI folders, or a project inside one,
 *      refused; or a project in iCloud Drive (~/Library/Mobile Documents) or in
 *      a cloud drive's folder (~/Library/CloudStorage), where people keep their
 *      documents.
 * Extended before their code after the Audit's L1 and I-1 on #648 (2026-11-26):
 *  W11 also: an application's own iCloud container in ~/Library/Mobile
 *      Documents (iCloud~<bundle>), application storage as Application Support
 *      is, taken for a documents folder; and a folder of the home whose name
 *      starts with two dots (`..x`) taken for one outside the home.
 *  W12 also: a vault in Obsidian's own iCloud folder
 *      (Mobile Documents/iCloud~md~obsidian/Documents) refused.
 * Added before their code after the Audit's M3 on #648 (2026-11-26):
 *  W11 also: a documents folder that is another name for a refused one (a
 *      link, or on Windows a junction, where the documents folder would be)
 *      exempts what lies in the refused one: an application folder of
 *      ~/Library or AppData taken for a project and read, or a markdown file
 *      in a folder of credentials read through a link in a project.
 */

import { windowMayRead, windowMayWrite, localFileServes, mayBeProject } from '../../../electron/utils/window-file-access';
import { DATA_DIR, PRIVATE_DIR } from '../../../electron/constants';

const home = () => os.homedir();
const at = (...p: string[]) => path.join(home(), ...p);
const put = (file: string, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
let project: string;

beforeEach(() => {
  for (const d of ['.tars', '.tars-private', '.claude', '.codex', '.gemini', '.grok', '.ssh', '.gnupg', '.aws', '.config', '.kube', '.docker', 'proj', 'kube-link',
    '.azure', '.terraform.d', '.wrangler', '.cargo', '.m2', '.qwen', '.pi', '.kimi-code', 'Library', 'AppData', '..x']) fs.rmSync(at(d), { recursive: true, force: true });
  project = at('proj');
  fs.mkdirSync(project, { recursive: true });
});

describe('what the window reads', () => {
  it('W1. no secret, wherever it is', () => {
    const secrets = [
      put(path.join(DATA_DIR, 'app-settings.json'), '{"deepSeekApiKey":"k"}'),
      put(path.join(DATA_DIR, 'app-settings.json.bak')),
      put(path.join(DATA_DIR, 'api-token')),
      put(path.join(DATA_DIR, 'hermes-session.json')),
      put(path.join(PRIVATE_DIR, 'settings-secrets.json')),
      put(path.join(PRIVATE_DIR, 'api-token')),
      put(path.join(PRIVATE_DIR, 'notes.md')),
      put(at('.claude', '.credentials.json')),
      put(at('.codex', 'auth.json')),
      put(at('.gemini', 'oauth_creds.json')),
    ];
    for (const s of secrets) expect(windowMayRead(s, [project]), s).toBe(false);
    // Nor the rest of ~/.tars: it is not one of the window's roots any more.
    expect(windowMayRead(put(path.join(DATA_DIR, 'agents.json')), [project])).toBe(false);
  });

  it('W2. no secret through a link in a project, a symbolic or a hard one', () => {
    const secret = put(path.join(PRIVATE_DIR, 'settings-secrets.json'), '{"k":"v"}');
    fs.symlinkSync(secret, path.join(project, 'soft.json'));
    fs.linkSync(secret, path.join(project, 'hard.txt'));
    expect(windowMayRead(path.join(project, 'soft.json'), [project])).toBe(false);
    expect(windowMayRead(path.join(project, 'hard.txt'), [project])).toBe(false);
  });

  it('W3. what the Brain and the code panel show', () => {
    for (const f of [at('.claude', 'CLAUDE.md'), at('.claude', 'mcp.json'), path.join(DATA_DIR, 'CLAUDE.md'), path.join(project, 'CLAUDE.md'), path.join(project, 'src', 'a.ts')]) {
      expect(windowMayRead(put(f), [project]), f).toBe(true);
    }
  });
});

describe('what the window writes', () => {
  it('W4. nothing that runs, nothing that is not an instruction file', () => {
    const refused = [
      path.join(DATA_DIR, 'statusline.sh'), path.join(DATA_DIR, 'bin', 'tars-mcp-node'), path.join(DATA_DIR, 'hooks', 'on-stop.sh'),
      path.join(DATA_DIR, 'agents.json'), path.join(DATA_DIR, 'notes.md'),
      at('.claude', 'settings.json'), at('.claude', 'hooks', 'a.sh'), at('.claude', 'agents', 'x.md'),
      at('.codex', 'config.toml'), at('.gemini', 'settings.json'), at('.gemini', 'GEMINI.md'),
      path.join(project, 'package.json'), path.join(project, '.git', 'hooks', 'pre-commit'), path.join(project, 'docs', 'CLAUDE.md'),
      path.join(PRIVATE_DIR, 'CLAUDE.md'),
    ];
    for (const f of refused) expect(windowMayWrite(put(f), [project]), f).toBe(false);
  });

  it('W5. the instruction files the Brain edits', () => {
    for (const f of [at('.claude', 'CLAUDE.md'), path.join(DATA_DIR, 'CLAUDE.md'), path.join(project, 'CLAUDE.md'), path.join(project, '.claude', 'CLAUDE.md')]) {
      expect(windowMayWrite(put(f), [project]), f).toBe(true);
    }
    // One of them linked to the private file is refused.
    fs.rmSync(path.join(project, 'CLAUDE.md'));
    fs.symlinkSync(put(path.join(PRIVATE_DIR, 'settings-secrets.json')), path.join(project, 'CLAUDE.md'));
    expect(windowMayWrite(path.join(project, 'CLAUDE.md'), [project])).toBe(false);
  });
});

describe('what local-file:// serves', () => {
  it('W6. the vault\'s attachments, the project files, Claude Code\'s memory, and nothing else', () => {
    const served = [
      path.join(DATA_DIR, 'vault', 'attachments', 'a-photo.png'),
      path.join(DATA_DIR, 'project-files', 'tars-1', 'reports', 'r.md'),
      at('.claude', 'projects', '-Users-x-proj', 'memory', 'MEMORY.md'),
    ];
    for (const f of served) expect(localFileServes(put(f)), f).toBe(true);
    const refused = [
      path.join(DATA_DIR, 'app-settings.json'), path.join(DATA_DIR, 'agents.json'), path.join(PRIVATE_DIR, 'settings-secrets.json'),
      path.join(PRIVATE_DIR, 'api-token'), at('.claude', '.credentials.json'), at('.claude', 'projects', '-Users-x-proj', 'abc.jsonl'),
      path.join(project, 'a.png'),
    ];
    for (const f of refused) expect(localFileServes(put(f)), f).toBe(false);
    const link = path.join(DATA_DIR, 'vault', 'attachments', 'b.png');
    fs.symlinkSync(path.join(PRIVATE_DIR, 'settings-secrets.json'), link);
    expect(localFileServes(link)).toBe(false);
    const hard = path.join(DATA_DIR, 'project-files', 'tars-1', 'h.md');
    fs.linkSync(path.join(PRIVATE_DIR, 'api-token'), hard);
    expect(localFileServes(hard)).toBe(false);
  });

  it('W7. no file with a second name, wherever the other one is', () => {
    const outside = [put(at('.ssh', 'id_ed25519'), 'PRIVATE KEY'), put(at('.claude', '.credentials.json'), '{"t":"x"}')];
    outside.forEach((secret, i) => {
      const hard = path.join(DATA_DIR, 'project-files', 'tars-1', 'reports', `notes-${i}.md`);
      fs.mkdirSync(path.dirname(hard), { recursive: true });
      fs.linkSync(secret, hard);
      expect(localFileServes(hard), hard).toBe(false);
    });
  });
});

describe('credentials, whatever the project (the Audit\'s L1 on #466)', () => {
  it('W8. no folder of credentials is a project, under its name, under another, or a level down', () => {
    const places = [at('.ssh'), at('.gnupg'), at('.aws'), at('.config', 'gh'), at('.config'), at('.kube'), at('.docker')];
    for (const place of places) {
      const file = put(path.join(place, 'hosts.yml'), 'oauth_token: gho_x');
      expect(mayBeProject(place), place).toBe(false);
      expect(windowMayRead(file, [place]), file).toBe(false);
    }
    fs.symlinkSync(at('.kube'), at('kube-link'));
    expect(mayBeProject(at('kube-link'))).toBe(false);
    expect(windowMayRead(path.join(at('kube-link'), 'hosts.yml'), [at('kube-link')])).toBe(false);
    // A real project still is one, and the code panel still reads it.
    expect(mayBeProject(project)).toBe(true);
    expect(windowMayRead(put(path.join(project, 'src', 'b.ts')), [project])).toBe(true);
  });

  it('W9. no .env of any kind', () => {
    for (const name of ['.env.local', '.env.production', '.env.development.local']) {
      expect(windowMayRead(put(path.join(project, name), 'KEY=1'), [project]), name).toBe(false);
    }
  });

  it('W10. no CLI settings that hold a key', () => {
    for (const f of [at('.claude', 'settings.json'), at('.claude', 'settings.local.json'), path.join(project, '.claude', 'settings.local.json'), at('.grok', 'user-settings.json')]) {
      expect(windowMayRead(put(f, '{"env":{"ANTHROPIC_API_KEY":"k"}}'), [project]), f).toBe(false);
    }
  });
});

describe('the project rule and the home\'s other folders (the Audit\'s L3 on #648)', () => {
  it('W11. no dot folder of the home but the four CLI folders, and no application folder, is a project', () => {
    const places = [
      at('.azure'), at('.terraform.d'), at('.wrangler'), at('.cargo', 'registry'), at('.m2'), at('.qwen'), at('.pi'), at('.kimi-code'),
      at('Library'), at('Library', 'Application Support', 'gh'), at('AppData'), at('AppData', 'Roaming', 'gcloud'),
      at('Library', 'Mobile Documents', 'iCloud~com~example~shell'), at('Library', 'Mobile Documents', 'iCloud~md~obsidian'), at('..x'),
    ];
    for (const place of places) {
      const file = put(path.join(place, 'notes.md'), 'a token');
      expect(mayBeProject(place), place).toBe(false);
      expect(windowMayRead(file, [place]), file).toBe(false);
    }
  });

  it('W12. the four CLI folders, a project in one, and the cloud documents folders still are', () => {
    for (const place of [at('.claude'), at('.codex'), at('.gemini'), at('.grok'), at('.claude', 'plugins', 'mine'),
      at('Library', 'Mobile Documents', 'com~apple~CloudDocs', 'work'), at('Library', 'CloudStorage', 'Dropbox', 'work'),
      at('Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents', 'Notes')]) {
      fs.mkdirSync(place, { recursive: true });
      expect(mayBeProject(place), place).toBe(true);
    }
    const doc = put(at('Library', 'Mobile Documents', 'com~apple~CloudDocs', 'work', 'src', 'a.ts'));
    expect(windowMayRead(doc, [at('Library', 'Mobile Documents', 'com~apple~CloudDocs', 'work')])).toBe(true);
  });

  it('W11 also: a documents folder that is another name for a refused one exempts nothing', () => {
    const app = put(at('Library', 'Application Support', 'SomeApp', 'notes.md'), 'a token');
    const roaming = put(at('AppData', 'Roaming', 'gcloud', 'notes.md'), 'a token');
    const aws = put(at('.aws', 'notes.md'), 'a token');
    const obsidianDocs = at('Library', 'Mobile Documents', 'iCloud~md~obsidian', 'Documents');
    const cloud = at('Library', 'CloudStorage');
    // A junction where the type is read (Windows), a link elsewhere.
    const pointing = (link: string, to: string, check: () => void) => {
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(to, link, 'junction');
      try { check(); } finally { fs.unlinkSync(link); }
    };
    for (const link of [obsidianDocs, cloud]) {
      pointing(link, at('Library'), () => {
        expect(mayBeProject(path.dirname(app)), link).toBe(false);
        expect(windowMayRead(app, [path.dirname(app)]), link).toBe(false);
      });
    }
    pointing(cloud, at('AppData'), () => {
      expect(mayBeProject(path.dirname(roaming))).toBe(false);
      expect(windowMayRead(roaming, [path.dirname(roaming)])).toBe(false);
    });
    fs.symlinkSync(aws, path.join(project, 'notes.md'));
    pointing(obsidianDocs, at('.aws'), () => {
      expect(windowMayRead(path.join(project, 'notes.md'), [project])).toBe(false);
    });
  });
});

