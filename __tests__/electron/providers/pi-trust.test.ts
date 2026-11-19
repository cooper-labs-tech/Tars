import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A pi agent's folder is trusted before its pi starts, as codex's and Claude Code's are (ensureCodexProjectTrusted,
 * ensureProjectTrusted).
 *
 * Measured on pi 1.5.2 (20/11, the harness conformance run of #601): started in a folder with pi resources of its own
 * (`.pi/settings.json`, `mcp.json`, `extensions`, `skills`, `prompts`, `themes`) or under a folder holding
 * `.agents/skills` other than the user's, pi first asks "Trust project folder?" and waits there for good; nobody answers
 * in an agent's terminal, and a task delegated to it waited out its launch. Pi keeps its answers in `trust.json` of its
 * agent folder (`$PI_CODING_AGENT_DIR` or `~/.pi/agent`): the folder's canonical path to true or false, the entry
 * nearest up the tree deciding (its core/trust-manager.js).
 *
 * How it fails, written before the code:
 * 1. The folder not trusted, or under another spelling of its path than pi's (a symlinked folder, /tmp on macOS): pi asks.
 * 2. A choice of the user's overwritten: the folder or a folder above it already in trust.json, true or false.
 * 3. A folder that would trust every folder below it (the home folder, /), as trustsTooMuch refuses for the others.
 * 4. The user's other entries lost, or the folder written again at every launch.
 * 5. A trust.json pi cannot read (not JSON, not an object) replaced: the user's answers lost. It is left as it is.
 * 6. The file created without its folder, or readable by others.
 * Every path here is a temporary folder handed in: nothing is read or written under the real home.
 */

import { ensurePiProjectTrusted } from '../../../electron/providers/pi-provider';
import { hasPosixModes } from '../../setup/platform-limits';

let root: string;
let agentDir: string;
let project: string;
const trustFile = () => path.join(agentDir, 'trust.json');
const trust = () => JSON.parse(fs.readFileSync(trustFile(), 'utf8')) as Record<string, boolean>;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tars-pi-trust-')));
  agentDir = path.join(root, 'pi-agent');
  project = path.join(root, 'work', 'project-a');
  fs.mkdirSync(project, { recursive: true });
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("a pi agent's folder, trusted before pi starts", () => {
  it('1 and 6: written under its real path, the file and its folder made, readable by its owner only', () => {
    expect(ensurePiProjectTrusted(project, agentDir)).toBe('written');
    expect(trust()).toEqual({ [project]: true });
    if (hasPosixModes()) expect(fs.statSync(trustFile()).mode & 0o777).toBe(0o600);
  });

  it('1: a folder reached through a link is written as pi reads it, by its real path', () => {
    const link = path.join(root, 'link-to-project');
    fs.symlinkSync(project, link);
    expect(ensurePiProjectTrusted(link, agentDir)).toBe('written');
    expect(Object.keys(trust())).toEqual([project]);
  });

  it("2: the user's choice for the folder or a folder above it stands, trusted or not", () => {
    for (const choice of [{ [project]: false }, { [project]: true }, { [path.dirname(project)]: true }, { [root]: false }]) {
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(trustFile(), JSON.stringify(choice));
      expect(ensurePiProjectTrusted(project, agentDir), JSON.stringify(choice)).toBe('already');
      expect(trust()).toEqual(choice);
    }
  });

  it('3: the home folder and / are refused, and nothing is written', () => {
    expect(ensurePiProjectTrusted(os.homedir(), agentDir)).toBe('refused');
    expect(ensurePiProjectTrusted('/', agentDir)).toBe('refused');
    expect(ensurePiProjectTrusted('relative/folder', agentDir)).toBe('refused');
    expect(fs.existsSync(trustFile())).toBe(false);
  });

  it("4: the user's other entries kept, and a second launch writes nothing", () => {
    const other = path.join(root, 'elsewhere');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(trustFile(), JSON.stringify({ [other]: false }));
    expect(ensurePiProjectTrusted(project, agentDir)).toBe('written');
    const once = fs.readFileSync(trustFile(), 'utf8');
    expect(JSON.parse(once)).toEqual({ [other]: false, [project]: true });
    expect(ensurePiProjectTrusted(project, agentDir)).toBe('already');
    expect(fs.readFileSync(trustFile(), 'utf8')).toBe(once);
  });

  it('5: a trust.json pi cannot read is left as it is', () => {
    fs.mkdirSync(agentDir, { recursive: true });
    for (const text of ['{ not json', '[true]', '"x"']) {
      fs.writeFileSync(trustFile(), text);
      expect(ensurePiProjectTrusted(project, agentDir), text).toBe('failed');
      expect(fs.readFileSync(trustFile(), 'utf8')).toBe(text);
    }
  });
});
