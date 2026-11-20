import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveAgentLaunch, AcpSession } from '../../../electron/services/acp/client';
import { acpLaunchFor } from '../../../electron/services/acp/registry';
import type { FsProbe } from '../../../electron/platform';
import type { AgentProvider } from '../../../electron/types';

/**
 * What an ACP run spawns, from the command the registry names (audit A20).
 *
 * Every launch in acp/registry.ts is `npx` or `opencode`, by bare name, and
 * client.ts handed that name to child_process.spawn with no shell. On win32
 * libuv looks a bare name up with `.com` and `.exe` only, and npx there is
 * npx.cmd: every delegation over ACP ended in `spawn npx ENOENT` before the
 * agent was ever started. A .cmd cannot be spawned without a shell either
 * (node refuses it since CVE-2024-27980), so the name goes through the
 * platform layer's resolver (electron/platform/cli-binary.ts), which reads an
 * npm shim through to `node.exe <script>`.
 *
 * How it fails, written before the code (2026-09-25):
 * 1. win32: `npx` is spawned by name, not as the node.exe and npx-cli.js its
 *    npx.cmd starts, and the launch is ENOENT.
 * 2. win32: the arguments the registry gave are lost, reordered, or put in
 *    front of the shim's script.
 * 3. win32: one of the commands the registry can hand over (the four npx
 *    agents, opencode) is not resolved through the same path.
 * 4. win32: a command that is nowhere loses the wording a launch failure has
 *    today: what is missing, where Tars looked, Settings > CLI Paths.
 * 5. win32: a working directory that is gone is blamed on the command.
 * 6. win32: a shim the resolver cannot read through is reported as "not
 *    found", or thrown as something other than a launch failure.
 * 7. win32: the child's environment holds the PATH under two spellings (Path
 *    from Windows, PATH from Tars), or the lookup reads the spelling Tars did
 *    not set.
 * 8. darwin/linux: anything but the command and arguments as given, or a disk
 *    access to find them.
 * 9. win32, a real process: a delegated session started through a npx.cmd
 *    in the folder Settings names does not answer its turn.
 */

const w = path.win32;
const NODE_DIR = 'C:\\Program Files\\nodejs';
const NPM_PREFIX = 'C:\\Users\\u\\AppData\\Roaming\\npm';

// The two formats as npm 10 / Node 22 write them, copied from this machine
// (nvm\v22.23.3\npx.cmd and %APPDATA%\npm\codex.cmd).
const NODE_DIST_NPX = [
  ':: Created by npm, please don\'t edit manually.', '@ECHO OFF', '', 'SETLOCAL', '',
  'SET "NODE_EXE=%~dp0\\node.exe"', 'IF NOT EXIST "%NODE_EXE%" (', '  SET "NODE_EXE=node"', ')', '',
  'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
  'SET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"',
  'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
  '  SET "NPM_PREFIX_NPX_CLI_JS=%%F\\node_modules\\npm\\bin\\npx-cli.js"', ')',
  'IF EXIST "%NPM_PREFIX_NPX_CLI_JS%" (', '  SET "NPX_CLI_JS=%NPM_PREFIX_NPX_CLI_JS%"', ')', '',
  '"%NODE_EXE%" "%NPX_CLI_JS%" %*', '',
].join('\r\n');
const CMD_SHIM_NODE = (script: string) => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${script}" %*`, '',
].join('\r\n');

/** A disk of Windows paths, compared without case, as NTFS does. */
function disk(files: Record<string, string>): FsProbe {
  const byKey = new Map(Object.entries(files).map(([p, c]) => [p.toLowerCase(), c]));
  return {
    isFile: p => byKey.has(p.toLowerCase()),
    readFile: p => {
      const text = byKey.get(p.toLowerCase());
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return text;
    },
  };
}

/** Node's own install, as on this machine. */
const WINDOWS_DISK = disk({
  [w.join(NODE_DIR, 'node.exe')]: '',
  [w.join(NODE_DIR, 'npx.cmd')]: NODE_DIST_NPX,
  [w.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npx-cli.js')]: '',
});

const WINDOWS_ENV = { Path: `${NODE_DIR};${NPM_PREFIX};C:\\Windows\\System32`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
const CWD = 'C:\\Users\\u\\project';

describe('an ACP launch on win32', () => {
  it('1, 2. starts npx as the node.exe and npx-cli.js its npx.cmd runs, the registry\'s arguments after them', () => {
    const target = resolveAgentLaunch(
      { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp@0.70.0'] }, WINDOWS_ENV, CWD, 'win32', WINDOWS_DISK,
    );

    expect(target.file).toBe(w.join(NODE_DIR, 'node.exe'));
    expect(target.args).toEqual([
      w.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npx-cli.js'), '-y', '@agentclientprotocol/claude-agent-acp@0.70.0',
    ]);
  });

  it('3. resolves every npx command the registry can hand over the same way', () => {
    const providers: AgentProvider[] = ['claude', 'codex', 'gemini', 'grok'];
    for (const provider of providers) {
      const launch = acpLaunchFor(provider);
      expect(launch?.command, provider).toBe('npx');
      const target = resolveAgentLaunch(launch!, WINDOWS_ENV, CWD, 'win32', WINDOWS_DISK);
      expect(target.file, provider).toBe(w.join(NODE_DIR, 'node.exe'));
      expect(target.args, provider).toEqual([w.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npx-cli.js'), ...launch!.args]);
    }
  });

  it('3. puts opencode, the one local command, through the same resolver', () => {
    const launch = acpLaunchFor('opencode');
    expect(launch).toMatchObject({ command: 'opencode', args: ['acp'] });
    const script = w.join(NPM_PREFIX, 'node_modules', 'opencode-ai', 'bin', 'opencode.js');
    const withJs = disk({
      [w.join(NODE_DIR, 'node.exe')]: '',
      [w.join(NPM_PREFIX, 'opencode.cmd')]: CMD_SHIM_NODE('node_modules\\opencode-ai\\bin\\opencode.js'),
      [script]: '',
    });

    const target = resolveAgentLaunch(launch!, WINDOWS_ENV, CWD, 'win32', withJs);

    expect(target.file).toBe(w.join(NODE_DIR, 'node.exe'));
    expect(target.args).toEqual([script, 'acp']);
  });

  it('4. says what is missing, where Tars looked, and where to set it, when the command is nowhere', () => {
    const env = { Path: 'C:\\Windows\\System32;C:\\nowhere', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    let error: Error | undefined;
    try {
      // A folder that exists: the working directory is checked first.
      resolveAgentLaunch({ command: 'npx', args: [] }, env, os.tmpdir(), 'win32', disk({}));
    } catch (err) {
      error = err as Error;
    }

    expect(error?.message).toContain('could not start the agent: npx was not found');
    expect(error?.message).toContain('Tars looked in C:\\Windows\\System32;C:\\nowhere');
    expect(error?.message).toContain('npx comes with Node.js: install Node.js');
    expect(error?.message).toContain('Settings > CLI Paths');
  });

  it('5. names a working directory that is gone, rather than blaming the command', () => {
    const gone = path.join(os.tmpdir(), 'tars-acp-no-such-project-dir');
    expect(() => resolveAgentLaunch({ command: 'npx', args: [] }, { Path: 'C:\\nowhere' }, gone, 'win32', disk({})))
      .toThrow(`could not start the agent: its working directory ${gone} does not exist`);
  });

  it('6. reports a shim it cannot read through as that, not as a command that is missing', () => {
    const odd = disk({ [w.join(NODE_DIR, 'npx.cmd')]: '@echo off\r\npython "%~dp0\\npx.py" %*\r\n' });

    expect(() => resolveAgentLaunch({ command: 'npx', args: [] }, WINDOWS_ENV, CWD, 'win32', odd))
      .toThrow(/^could not start the agent: npx: .*not an npm shim Tars can read through/);
  });

  it('7. hands the child one PATH, the one Tars set, whatever spelling Windows gave it', () => {
    // As start() builds it: process.env (Path) with the delegation's own PATH over it.
    const env = { Path: 'C:\\Windows\\System32', PATHEXT: '.COM;.EXE;.BAT;.CMD', PATH: `${NODE_DIR};C:\\Windows\\System32` };

    const target = resolveAgentLaunch({ command: 'npx', args: [] }, env, CWD, 'win32', WINDOWS_DISK);

    expect(target.file).toBe(w.join(NODE_DIR, 'node.exe'));
    const pathKeys = Object.keys(target.env).filter(k => k.toUpperCase() === 'PATH');
    expect(pathKeys).toHaveLength(1);
    expect(target.env[pathKeys[0]]).toBe(`${NODE_DIR};C:\\Windows\\System32`);
  });
});

describe('an ACP launch on darwin and linux', () => {
  it('8. is the command and arguments as given, found without touching the disk', () => {
    const untouchable: FsProbe = {
      isFile: () => { throw new Error('the disk was asked'); },
      readFile: () => { throw new Error('the disk was asked'); },
    };
    const env = { PATH: '/usr/local/bin:/usr/bin', HOME: '/Users/u' };
    for (const platform of ['darwin', 'linux'] as const) {
      const target = resolveAgentLaunch({ command: 'npx', args: ['-y', 'pkg@1'] }, env, '/Users/u/p', platform, untouchable);
      expect(target.file).toBe('npx');
      expect(target.args).toEqual(['-y', 'pkg@1']);
      expect(target.env).toEqual(env);
    }
  });
});

describe.skipIf(process.platform !== 'win32')('a delegated session on win32, for real', () => {
  it('9. starts through a npx.cmd in the folder Settings names, and its turn answers', { timeout: 30_000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-acp-win-launch-'));
    const script = path.join(dir, 'node_modules', 'fake-acp', 'npx-cli.js');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, `
let buf = '';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
process.stdin.on('data', chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\\n')) !== -1) {
    const msg = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: {} });
    if (msg.method === 'session/new') send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
    if (msg.method === 'session/prompt') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(process.argv.slice(1)) } } } });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
    }
  }
});
`);
    fs.writeFileSync(path.join(dir, 'npx.cmd'), CMD_SHIM_NODE('node_modules\\fake-acp\\npx-cli.js'));
    const session = new AcpSession({ command: 'npx', args: ['-y', 'some-agent@1'] }, {
      cwd: dir,
      // The folder first, as buildFullPath puts Settings > CLI Paths; node.exe from this run's own folder.
      env: { PATH: `${dir};${path.dirname(process.execPath)};C:\\Windows\\System32` },
    });
    try {
      await session.start();
      const turn = await session.prompt('go', 10_000);

      expect(turn.stopReason).toBe('end_turn');
      expect(JSON.parse(turn.text)).toEqual([script, '-y', 'some-agent@1']);
    } finally {
      session.stop();
      // The agent runs in `dir` until taskkill, which stop() starts, has ended it.
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
});
