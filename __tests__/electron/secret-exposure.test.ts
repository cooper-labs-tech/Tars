import '../setup/home-guard';
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { writeSecretFileSync, ensureSecretFileMode } from '../../electron/utils/secret-file';
import { cannotSymlink } from '../setup/symlink-privilege';
import { hasPosixModes } from '../setup/platform-limits';

/** The module object itself, so a patch reaches the product's `fs` import. */
const nodeFs = createRequire(import.meta.url)('node:fs') as typeof fs;

/**
 * Three ways the app leaked, or could be made to leak, its own credentials.
 */

const made: string[] = [];
const tmp = (name: string) => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tars-secret-')), name);
  made.push(path.dirname(p));
  return p;
};

afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeSecretFileSync', () => {
  it.skipIf(!hasPosixModes())('creates the file readable only by its owner', () => {
    const p = tmp('app-settings.json');
    writeSecretFileSync(p, '{"telegramBotToken":"secret"}');
    // 0644 was the real mode of ~/.tars/app-settings.json, which holds every
    // provider API key, while api-token beside it was already 0600.
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it.skipIf(!hasPosixModes())('narrows a file that already exists at 0644', () => {
    const p = tmp('app-settings.json');
    fs.writeFileSync(p, '{}');
    fs.chmodSync(p, 0o644);
    writeSecretFileSync(p, '{"a":1}');
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it('writes atomically, so a torn write cannot empty the file', () => {
    const p = tmp('app-settings.json');
    writeSecretFileSync(p, '{"first":true}');
    writeSecretFileSync(p, '{"second":true}');
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ second: true });
    expect(fs.existsSync(`${p}.tmp`)).toBe(false);
  });

  it.skipIf(!hasPosixModes())('ensureSecretFileMode fixes an install that predates the 0600 write', () => {
    const p = tmp('hermes-connection.json');
    fs.writeFileSync(p, '{}');
    fs.chmodSync(p, 0o644);
    ensureSecretFileMode(p);
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it('ensureSecretFileMode is silent on a missing file', () => {
    expect(() => ensureSecretFileMode(tmp('never-written'))).not.toThrow();
  });

  it.skipIf(!hasPosixModes())('makes the directory it has to create for a secret readable by its owner only', () => {
    // Found by the audit of lot 4: ~/.tars-private came into being at 0755 on
    // an install that had nothing to migrate, because the only 0700 mkdir was
    // the migration's, and this helper created the directory it wrote into
    // with the default mode. The witness first: here, a directory made the
    // ordinary way is open to the other accounts, so the umask is not what
    // makes the assertion below pass.
    const probe = path.join(path.dirname(tmp('probe')), 'ordinary');
    fs.mkdirSync(probe);
    expect(fs.statSync(probe).mode & 0o077, 'this umask would hide the defect').not.toBe(0);

    const dir = path.join(path.dirname(tmp('x')), 'private');
    writeSecretFileSync(path.join(dir, 'overseer.json'), '{}');

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  });

  it.skipIf(cannotSymlink())('writes nothing through a link planted at its temp name', () => {
    // The temp name is fixed and predictable, and the old write opened it
    // following a link: the secret went into the file the link named, which
    // then took the secret's name and was chmodded 0600 on the way.
    const p = tmp('app-settings.json');
    const victim = path.join(path.dirname(p), 'someone-elses-file');
    fs.writeFileSync(victim, 'untouched');
    fs.chmodSync(victim, 0o644);
    fs.symlinkSync(victim, `${p}.tmp`);

    writeSecretFileSync(p, '{"telegramBotToken":"secret"}');

    expect(fs.readFileSync(victim, 'utf-8')).toBe('untouched');
    if (hasPosixModes()) expect(fs.statSync(victim).mode & 0o777).toBe(0o644);
    expect(fs.lstatSync(p).isSymbolicLink(), 'the secret file is the planted link').toBe(false);
    expect(fs.readFileSync(p, 'utf-8')).toBe('{"telegramBotToken":"secret"}');
  });

  it('refuses a link planted between the removal and the open, rather than write through it', () => {
    // The instant the removal leaves open, reproduced: the link lands right
    // after the temp name is cleared, and it is the open that must say no.
    const p = tmp('app-settings.json');
    const victim = path.join(path.dirname(p), 'someone-elses-file');
    fs.writeFileSync(victim, 'untouched');
    const original = nodeFs.rmSync;
    nodeFs.rmSync = function (target: fs.PathLike, options?: fs.RmOptions) {
      original.call(nodeFs, target, options);
      if (String(target) === `${p}.tmp`) nodeFs.symlinkSync(victim, target);
    } as typeof fs.rmSync;
    syncBuiltinESMExports();
    try {
      expect(() => writeSecretFileSync(p, '{"telegramBotToken":"secret"}')).toThrow();
    } finally {
      nodeFs.rmSync = original;
      syncBuiltinESMExports();
    }

    expect(fs.readFileSync(victim, 'utf-8')).toBe('untouched');
  });

  it('writes nothing through a hard link planted there either', () => {
    // Refusing to follow a symbolic link is not enough: a hard link is the
    // same file under the temp name, and truncating it truncates the victim.
    const p = tmp('app-settings.json');
    const victim = path.join(path.dirname(p), 'someone-elses-file');
    fs.writeFileSync(victim, 'untouched');
    fs.linkSync(victim, `${p}.tmp`);

    writeSecretFileSync(p, '{"telegramBotToken":"secret"}');

    expect(fs.readFileSync(victim, 'utf-8')).toBe('untouched');
    expect(fs.readFileSync(p, 'utf-8')).toBe('{"telegramBotToken":"secret"}');
  });
});

describe('MCP registration argument handling', () => {
  // The providers used to build `claude mcp add -s user <name> <cmd> "<arg>"`
  // and hand it to execSync, i.e. /bin/sh -c. Double quotes do not stop $() or
  // backticks, and one of the args is tasmaniaServerPath straight out of
  // app-settings.json.
  const shellWouldExpand = (arg: string) => /\$\(|`|\$\{/.test(arg);

  it('recognises the payload shape the old form evaluated', () => {
    expect(shellWouldExpand('x.js"$(id > PWN.txt)"')).toBe(true);
    expect(shellWouldExpand('`id`')).toBe(true);
    expect(shellWouldExpand('${HOME}')).toBe(true);
  });

  it('argv arrays make the question moot - the value is data, not syntax', () => {
    const argv = ['mcp', 'add', '-s', 'user', 'tasmania', 'node', 'x.js"$(id > PWN.txt)"'];
    // No shell is involved, so the element is passed through verbatim as one
    // argument. This is what execFileSync guarantees and execSync does not.
    expect(argv[argv.length - 1]).toBe('x.js"$(id > PWN.txt)"');
    expect(argv).toHaveLength(7);
  });
});

describe('Telegram path guard', () => {
  // Mirrors isSafeTelegramPath and the MCP server's assertSendablePath.
  const home = os.homedir();
  const BLOCKED = ['.ssh', '.gnupg', '.aws', '.claude', '.tars', '.config',
                   '.kube', '.docker', '.env', '.netrc', '.git-credentials'];
  const safe = (p: string) => {
    const resolved = path.resolve(p);
    if (resolved !== home && !resolved.startsWith(home + path.sep)) return false;
    return !BLOCKED.some(d => {
      const b = path.join(home, d);
      return resolved === b || resolved.startsWith(b + path.sep);
    });
  };

  it('blocks our own credential store, which it used to allow', () => {
    // ~/.ssh was blocked from the start; ~/.tars - which holds every API key
    // in app-settings.json - was not.
    expect(safe(path.join(home, '.tars', 'app-settings.json'))).toBe(false);
    expect(safe(path.join(home, '.tars', 'api-token'))).toBe(false);
    expect(safe(path.join(home, '.tars', 'hermes-webhook-secret'))).toBe(false);
  });

  it('still blocks the directories it always did', () => {
    for (const d of ['.ssh/id_rsa', '.aws/credentials', '.claude/settings.json', '.gnupg/secring.gpg']) {
      expect(safe(path.join(home, d)), d).toBe(false);
    }
  });

  it('blocks the ones the audit added', () => {
    for (const d of ['.config/gh/hosts.yml', '.kube/config', '.docker/config.json', '.git-credentials']) {
      expect(safe(path.join(home, d)), d).toBe(false);
    }
  });

  it('refuses anything outside the home directory', () => {
    expect(safe('/etc/passwd')).toBe(false);
    expect(safe(path.join(home, '..', 'other-user', 'notes.txt'))).toBe(false);
  });

  it('still allows an ordinary file', () => {
    expect(safe(path.join(home, 'Documents', 'report.pdf'))).toBe(true);
  });
});
