import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { hermesShellFor, byHand, shellWord, type Exec } from '../../../electron/services/hermes-shell';
import type { HermesConnection } from '../../../electron/types/hermes';

/**
 * The shell Tars runs the relay's commands in, on Hermes's machine (2.0.4, the Relay frames' notes for the Backend:
 * "Local mode: on this machine, through execFile. SSH mode: ssh to the host saved in Connection, keys only
 * (BatchMode), never a password typed into a terminal. Remote or Cloud: nothing runs, and the commands are shown").
 *
 * How it fails, written before the code:
 * 1. A command runs through a shell on this Mac (exec, a joined string), so a word in it is read as shell syntax.
 * 2. Over SSH, a word reaches the remote shell unquoted: an id like `$(touch x)`, `a;b`, a quote or a newline runs
 *    or splits there.
 * 3. SSH may stop on a question nobody answers (a password, an unknown host key): no BatchMode, no
 *    StrictHostKeyChecking; or the key path or the port the user saved is not used.
 * 4. A remote or cloud connection gets a shell and runs something; or the commands shown to run by hand are not
 *    the steps.
 * 5. A command has no time limit, so one that hangs holds the switch forever.
 * 6. The plugin is copied elsewhere than the plugins folder of Hermes, or an older copy's files stay beside it.
 */

type Call = { file: string; args: string[]; timeout: number };
let calls: Call[];
const exec: Exec = async (file, args, opts) => {
  calls.push({ file, args, timeout: opts.timeout });
  return { code: 0, out: '' };
};

beforeEach(() => { calls = []; });

const ssh: HermesConnection = { mode: 'ssh', ssh: { host: 'hermes.example', user: 'jb', port: 2222, keyPath: '/Users/jb/.ssh/id_hermes' } };

describe('the shell on Hermes\'s machine', () => {
  it('1 and 5. local: the command\'s words as execFile\'s argument list, with a time limit', async () => {
    const shell = hermesShellFor({ mode: 'local', localPort: 9119 }, exec)!;
    await shell.run(['hermes', 'config', 'set', 'plugins.entries.tars-relay.settings.users.telegram', '"123$(touch x)"']);

    expect(calls).toEqual([{ file: 'hermes', args: ['config', 'set', 'plugins.entries.tars-relay.settings.users.telegram', '"123$(touch x)"'], timeout: expect.any(Number) }]);
    expect(calls[0].timeout).toBeGreaterThan(0);
    expect(shell.where).toBe('this Mac');
  });

  it('2 and 3. over SSH: keys only, no question, the saved port and key, every word quoted for the remote shell', async () => {
    const shell = hermesShellFor(ssh, exec)!;
    await shell.run(['hermes', 'config', 'set', 'k', `$(touch x); a'b\nc`]);

    const [{ file, args }] = calls;
    expect(file).toBe('ssh');
    expect(args).toEqual(expect.arrayContaining(['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-p', '2222', '-i', '/Users/jb/.ssh/id_hermes', 'jb@hermes.example']));
    const line = args[args.length - 1];
    expect(line.endsWith(`'hermes' 'config' 'set' 'k' '$(touch x); a'\\''b\nc'`)).toBe(true);
    expect(shell.where).toBe('jb@hermes.example over SSH');
  });

  it('2. a quoted word is read back by a POSIX shell as the word itself', async () => {
    const { execFileSync } = await import('child_process');
    for (const word of ['plain', "it's", '$(touch x)', 'a;b', 'tab\there', 'new\nline', '"', '\\', '', '*']) {
      expect(execFileSync('/bin/sh', ['-c', `printf %s ${shellWord(word)}`], { encoding: 'utf8' }), JSON.stringify(word)).toBe(word);
    }
  });

  it('4. remote and cloud: no shell, and the commands by hand are the steps', () => {
    expect(hermesShellFor({ mode: 'remote', url: 'https://hermes.example' }, exec)).toBeNull();
    expect(hermesShellFor({ mode: 'cloud', url: 'https://cloud.example' }, exec)).toBeNull();
    expect(byHand()).toEqual([
      'scp -r tars-relay <server>:~/.hermes/plugins/tars-relay',
      'ssh <server> hermes plugins validate ~/.hermes/plugins/tars-relay',
      'ssh <server> hermes plugins enable tars-relay',
    ]);
    expect(calls).toEqual([]);
  });
});

describe('the plugin\'s copy', () => {
  let home: string;
  let from: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-shell-'));
    from = path.join(home, 'shipped', 'tars-relay');
    fs.mkdirSync(path.join(from, 'dashboard'), { recursive: true });
    fs.writeFileSync(path.join(from, 'plugin.yaml'), 'name: tars-relay\nversion: 2.0.0\n');
    fs.writeFileSync(path.join(from, 'dashboard', 'plugin_api.py'), '# api\n');
  });
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

  it('6. local: into Hermes\'s plugins folder, an older copy\'s files gone', async () => {
    const hermesHome = path.join(home, '.hermes');
    fs.mkdirSync(path.join(hermesHome, 'plugins', 'tars-relay'), { recursive: true });
    fs.writeFileSync(path.join(hermesHome, 'plugins', 'tars-relay', 'old.py'), '# 1.0.0\n');
    const shell = hermesShellFor({ mode: 'local', localPort: 9119 }, exec, { hermesHome })!;

    const done = await shell.copyPlugin(from);

    expect(done.code).toBe(0);
    expect(fs.readdirSync(path.join(hermesHome, 'plugins', 'tars-relay')).sort()).toEqual(['dashboard', 'plugin.yaml']);
    expect(shell.pluginPath).toBe(path.join(hermesHome, 'plugins', 'tars-relay'));
  });

  it('6. over SSH: the old copy removed there, then scp into the plugins folder, keys only', async () => {
    const shell = hermesShellFor(ssh, exec)!;
    await shell.copyPlugin(from);

    expect(calls.map(c => c.file)).toEqual(['ssh', 'scp']);
    expect(calls[0].args[calls[0].args.length - 1]).toMatch(/rm -rf "\$HOME\/\.hermes\/plugins\/tars-relay" && mkdir -p "\$HOME\/\.hermes\/plugins"/);
    expect(calls[1].args).toEqual(expect.arrayContaining(['-r', '-o', 'BatchMode=yes', '-P', '2222', '-i', '/Users/jb/.ssh/id_hermes', from, 'jb@hermes.example:.hermes/plugins/']));
    // Relative to the home folder ssh starts in: a quoted ~ would reach Hermes unexpanded.
    expect(shell.pluginPath).toBe('.hermes/plugins/tars-relay');
  });
});
