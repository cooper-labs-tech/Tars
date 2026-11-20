import '../setup/home-guard';
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeAtomicSync } from '../../electron/utils/secret-file';

/**
 * The four live bugs that surfaced while writing SPECS §13. Writing down what
 * the system does turned out to be a better bug-finder than looking for bugs.
 */

describe('run-task emits on the channel wait listens to', () => {
  // /run-task emitted `status`; /wait subscribes to `status:${agentId}`. The
  // two never met, so a caller that started a task and then waited for it hung
  // until its own timeout - the delegation looked like a hang, not a mismatch.
  it('a listener registered the way /wait registers is actually called', () => {
    const emitter = new EventEmitter();
    const agentId = 'a1';
    let woke = false;

    emitter.on(`status:${agentId}`, () => { woke = true; });

    emitter.emit(`status:${agentId}`);
    expect(woke).toBe(true);
  });

  it('the old bare-name emit reached nobody', () => {
    const emitter = new EventEmitter();
    let woke = false;
    emitter.on('status:a1', () => { woke = true; });

    emitter.emit('status', { agentId: 'a1', status: 'running' });
    expect(woke).toBe(false);
  });
});

describe('caller-identity header', () => {
  // The MCP client sends X-Tars-Caller-*; the server read x-dorothy-caller-*.
  // The bundles on disk predate the rename, so it worked by accident and would
  // have broken the moment anyone rebuilt them: project scoping silently off.
  const read = (headers: Record<string, string>, suffix: 'project' | 'id') => {
    const value = headers[`x-tars-caller-${suffix}`] ?? headers[`x-dorothy-caller-${suffix}`];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  it('accepts what a rebuilt MCP bundle sends', () => {
    expect(read({ 'x-tars-caller-project': '/p/tars' }, 'project')).toBe('/p/tars');
    expect(read({ 'x-tars-caller-id': 'a1' }, 'id')).toBe('a1');
  });

  it('still accepts what the shipped bundles send', () => {
    expect(read({ 'x-dorothy-caller-project': '/p/tars' }, 'project')).toBe('/p/tars');
  });

  it('prefers the current name when both are present', () => {
    expect(read({ 'x-tars-caller-project': '/new', 'x-dorothy-caller-project': '/old' }, 'project')).toBe('/new');
  });

  it('treats absent and empty alike, so scoping is never enabled by a blank', () => {
    expect(read({}, 'project')).toBeUndefined();
    expect(read({ 'x-tars-caller-project': '' }, 'project')).toBeUndefined();
  });
});

describe('atomic state writes', () => {
  const dirs: string[] = [];
  const tmpFile = (name: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-atomic-'));
    dirs.push(d);
    return path.join(d, name);
  };
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it('leaves no temp file behind', () => {
    const p = tmpFile('projects.json');
    writeAtomicSync(p, JSON.stringify(['/a', '/b']));
    expect(fs.existsSync(`${p}.tmp`)).toBe(false);
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual(['/a', '/b']);
  });

  it('a second write never exposes a half-written file', () => {
    const p = tmpFile('projects.json');
    writeAtomicSync(p, JSON.stringify(['/first']));
    writeAtomicSync(p, JSON.stringify(['/first', '/second']));
    // The rename is the only moment the path changes contents, and it is atomic.
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual(['/first', '/second']);
  });

  it('creates the directory it is asked to write into', () => {
    const p = path.join(tmpFile('x'), '..', 'nested', 'deep', 'projects.json');
    writeAtomicSync(p, '[]');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('does not narrow the mode of an ordinary state file', () => {
    const p = tmpFile('projects.json');
    writeAtomicSync(p, '[]');
    // Only credentials get 0600; this one follows the umask like any other file.
    expect(fs.statSync(p).mode & 0o077).not.toBe(0o600);
  });
});
