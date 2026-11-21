import '../../setup/home-guard';
import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { windowsSoundCommand } from '../../../electron/platform';

/**
 * The notification sound on Windows. It was played with
 * `powershell -c "(New-Object Media.SoundPlayer '<path>').PlaySync()"`: the
 * path, read from app-settings.json, which every agent is handed with
 * ~/.tars, was pasted into PowerShell code. A `'` in a file name ended the
 * string, and what followed ran in a process the main process started.
 *
 * How it can fail, written before the code:
 * 1. the path reaches the code PowerShell parses, whole or in part, whatever
 *    it holds: `'`, `;`, `$(...)`, a backtick, `"`;
 * 2. something else than a .wav that exists is handed over: another
 *    extension, a directory, a missing file, a relative path, a URL;
 * 3. a UNC path (`\\host\share\x.wav`) is opened: the lookup alone sends the
 *    account's NTLM hash to that host;
 * 4. a control character or a line break travels in the variable;
 * 5. `powershell` is looked up on the PATH or in the working directory
 *    instead of System32, or a profile script runs first;
 * 6. the script is not fixed: it changes with the file;
 * 7. on this machine, a file named to run code, played through the real
 *    command, runs it (the canary appears), or does not play;
 * 11. a SystemRoot that is not a plain absolute path (`Windows`, `C:Windows`,
 *    `\Windows`, one holding a stream colon) is trusted, so the PowerShell run
 *    is found against the working directory, an agent's project.
 */

const SYSTEM_ROOT = 'C:\\Windows';
const env = { SystemRoot: SYSTEM_ROOT, Path: 'C:\\evil;C:\\Windows\\System32' };
const exists = (files: string[]) => ({ isFile: (p: string) => files.includes(p), readFile: () => '' });
const decoded = (args: string[]) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');

const HOSTILE = [
  "C:\\Users\\x\\a'; New-Item pwned; 'b.wav",
  'C:\\Users\\x\\a$(New-Item pwned)b.wav',
  'C:\\Users\\x\\a`$(New-Item pwned)`b.wav',
  'C:\\Users\\x\\a"; New-Item pwned; "b.wav',
  'C:\\Users\\x\\plain.WAV',
];

describe('the command that plays a notification sound on Windows', () => {
  it('1, 6. keeps the path out of the code: the script is one fixed text, the path travels in the environment', () => {
    const scripts = new Set<string>();
    for (const file of HOSTILE) {
      const r = windowsSoundCommand(file, { env, fs: exists([file]) });
      expect(r.ok, file).toBe(true);
      if (!r.ok) continue;
      expect(r.args.join(' '), file).not.toContain(file);
      expect(r.args.join(' ')).not.toMatch(/pwned|plain/);
      expect(decoded(r.args)).not.toMatch(/pwned|plain|Users/);
      expect(r.env.TARS_SOUND_FILE).toBe(file);
      scripts.add(decoded(r.args));
    }
    expect(scripts.size).toBe(1);
    expect([...scripts][0]).toContain('$env:TARS_SOUND_FILE');
  });

  it('5. starts System32\'s Windows PowerShell with no profile, never a name found on the PATH', () => {
    const r = windowsSoundCommand('C:\\s\\ding.wav', { env, fs: exists(['C:\\s\\ding.wav']) });
    expect(r.ok && r.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(r.ok && r.args.slice(0, 2)).toEqual(['-NoProfile', '-NonInteractive']);
    expect(r.ok && r.env.Path).toBe(env.Path);
  });

  it('11. takes SystemRoot only when it is a plain absolute path, C:\\Windows otherwise', () => {
    const file = 'C:\\s\\ding.wav';
    const run = (SystemRoot: string) => {
      const r = windowsSoundCommand(file, { env: { ...env, SystemRoot }, fs: exists([file]) });
      return r.ok ? r.file : r.error;
    };
    for (const bad of ['Windows', 'C:Windows', '\\Windows', '.\\Windows', 'C:\\Windows:evil', '']) {
      expect(run(bad), JSON.stringify(bad)).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    }
    expect(run('D:\\WinNT')).toBe('D:\\WinNT\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });

  it('2, 3, 4. refuses anything but a local .wav that exists, before touching the disk for a UNC path', () => {
    const touched: string[] = [];
    const probe = { isFile: (p: string) => { touched.push(p); return true; }, readFile: () => '' };
    for (const bad of [
      'C:\\s\\ding.mp3', 'C:\\s\\ding.wav.exe', 'ding.wav', 's\\ding.wav', '\\s\\ding.wav', 'C:ding.wav',
      '\\\\attacker\\share\\ding.wav', '//attacker/share/ding.wav', '\\\\?\\C:\\s\\ding.wav', '\\\\?\\UNC\\h\\s\\d.wav',
      'http://attacker/ding.wav', 'C:\\s\\ding\n.wav', 'C:\\s\\di\u0000ng.wav', '', undefined as unknown as string,
    ]) {
      expect(windowsSoundCommand(bad, { env, fs: probe }).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(touched).toEqual([]);
    expect(windowsSoundCommand('C:\\s\\gone.wav', { env, fs: exists([]) }).ok).toBe(false);
  });
});

/**
 * Found in review: the path is local, but a link on the way can lead to a
 * share, and opening the file then contacts that host all the same.
 * 8. a link (symlink or junction) at any level whose target is a UNC path,
 *    `\\?\UNC\...`, a device (`\\.\...`) or `\\?\GLOBALROOT` is followed;
 * 9. the link is followed to find that out (reading its target must not open it);
 * 10. a link to a local folder is refused, or a loop of links hangs;
 * 12. a target stored as an NT path (`\GLOBAL??\UNC\host\share`,
 *    `\??\UNC\host\share`, `\Device\Mup\host\share`), which starts with one
 *    `\`, is read as a folder of the current drive and followed.
 */
describe('8, 9, 10. links on the way to the file', () => {
  const file = 'C:\\s\\sub\\ding.wav';
  const opened: string[] = [];
  const disk = { isFile: (p: string) => { opened.push(p); return true; }, readFile: () => '' };
  const links = (map: Record<string, string>) => (p: string) => map[p.toLowerCase()] ?? null;

  it('refuses a link to a share or a device, before anything is opened', () => {
    for (const target of ['\\\\attacker\\share', '//attacker/share', '\\\\?\\UNC\\attacker\\share', '\\\\.\\pipe\\x', '\\\\?\\GLOBALROOT\\Device\\Mup\\h\\s']) {
      for (const at of ['c:\\s', 'c:\\s\\sub', 'c:\\s\\sub\\ding.wav']) {
        opened.length = 0;
        const r = windowsSoundCommand(file, { env, fs: disk, readLink: links({ [at]: target }) });
        expect(r.ok, `${at} -> ${target}`).toBe(false);
        expect(opened).toEqual([]);
      }
    }
  });

  it('12. refuses a target stored as an NT path, or rooted on no drive, before anything is opened', () => {
    for (const target of ['\\GLOBAL??\\UNC\\attacker\\share', '\\??\\UNC\\attacker\\share', '\\Device\\Mup\\attacker\\share', '\\sounds', '/sounds']) {
      opened.length = 0;
      expect(windowsSoundCommand(file, { env, fs: disk, readLink: links({ 'c:\\s': target }) }).ok, target).toBe(false);
      expect(opened).toEqual([]);
    }
  });

  it('follows links to local folders, whatever form the target takes, and ends a loop', () => {
    for (const target of ['D:\\sounds', '\\\\?\\D:\\sounds', '\\??\\D:\\sounds', 'sounds2']) {
      expect(windowsSoundCommand(file, { env, fs: disk, readLink: links({ 'c:\\s': target }) }).ok, target).toBe(true);
    }
    // A local link whose own target is on a share is still a share.
    expect(windowsSoundCommand(file, { env, fs: disk, readLink: links({ 'c:\\s': 'D:\\x', 'd:\\x\\sub': '\\\\h\\s' }) }).ok).toBe(false);
    expect(windowsSoundCommand(file, { env, fs: disk, readLink: links({ 'c:\\s': 'C:\\t', 'c:\\t': 'C:\\s' }) }).ok).toBe(false);
  });
});

/** A valid 8 kHz mono PCM wave of `ms` silence. */
function wave(ms: number): Buffer {
  const samples = Math.round(8 * ms);
  const b = Buffer.alloc(44 + samples, 0x80);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34);
  b.write('data', 36); b.writeUInt32LE(samples, 40);
  return b;
}

const run = (file: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }) =>
  new Promise<{ code: number; stderr: string }>(resolve => {
    execFile(file, args, { ...opts, windowsHide: true, timeout: 60_000 }, (err, _out, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stderr: String(stderr) }));
  });

describe.runIf(process.platform === 'win32')('7. on this machine, with the real PowerShell', () => {
  // Each case starts a real Windows PowerShell, one to two seconds apiece on a loaded machine.
  const made: string[] = [];
  afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  // Windows file names may hold ' ; $ ( ) and backticks, not " (so no " payload here).
  const NAMES = [
    "a'; New-Item -ItemType File canary; 'b.wav",
    "a'+$(New-Item -ItemType File canary)+'b.wav",
    'a$(New-Item -ItemType File canary)b.wav',
    "a`'; New-Item -ItemType File canary; `'b.wav",
  ];

  it('plays each file, and none of them runs the code in its name', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-sound-')));
    made.push(dir);
    for (const name of NAMES) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, wave(20));
      const cmd = windowsSoundCommand(file);
      expect(cmd.ok, name).toBe(true);
      if (!cmd.ok) continue;
      const r = await run(cmd.file, cmd.args, { cwd: dir, env: cmd.env });
      expect({ name, code: r.code, stderr: r.stderr }).toEqual({ name, code: 0, stderr: '' });
      expect(fs.existsSync(path.join(dir, 'canary')), name).toBe(false);
    }
  }, 60_000);

  it('plays a file reached through a junction to a local folder', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-sound-junction-')));
    made.push(dir);
    fs.mkdirSync(path.join(dir, 'real'));
    fs.writeFileSync(path.join(dir, 'real', 'ding.wav'), wave(20));
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'via'), 'junction');
    const cmd = windowsSoundCommand(path.join(dir, 'via', 'ding.wav'));
    expect(cmd.ok).toBe(true);
    if (!cmd.ok) return;
    expect((await run(cmd.file, cmd.args, { cwd: dir, env: cmd.env })).code).toBe(0);
  }, 60_000);

  it('the witness: the old command, given the same file names, runs the canary', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-sound-old-')));
    made.push(dir);
    let ran = 0;
    for (const name of NAMES) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, wave(20));
      fs.rmSync(path.join(dir, 'canary'), { force: true });
      // utils/index.ts before this lot, verbatim.
      await run('powershell', ['-c', `(New-Object Media.SoundPlayer '${file}').PlaySync()`], { cwd: dir });
      if (fs.existsSync(path.join(dir, 'canary'))) ran++;
    }
    expect(ran).toBeGreaterThan(0);
  }, 60_000);
});
