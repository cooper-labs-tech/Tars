import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRemoteHosts, hostRemovalRefusal } from '../../../electron/services/remote-hosts';

/**
 * The owner's remote hosts (2.0.7, item 14; reports/remote-agents/PLAN.md): where agents may run their CLI over ssh.
 * Kept in ~/.tars-private, set by the window only.
 *
 * How it fails, written before the code:
 * 1. A host set is not read back after a restart of Tars, or the file is readable by others (not 0600).
 * 2. A file of another shape, or an entry that does not parse (a target ssh would read as an option, a key in it),
 *    is read as hosts, or throws; one bad entry hides the good ones.
 * 3. An entry that does not parse is written; setting the same id twice keeps two hosts.
 * 4. A host removed is still listed, or removing one that is not there throws.
 * 5. A change is not told (the window and the agents' launches read the list).
 * 6. (the Audit's M1 on #600) A host is removed while agents are placed on it: their sessions there go on, and no stop
 *    reaches them any more. The removal must be refused, naming them.
 */

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-hosts-'));
  file = path.join(dir, 'remote-hosts.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const host = { id: 'build-1', name: 'Build host', sshTarget: 'buildbox', workRoot: '/home/agent/work' };

describe('the remote hosts store', () => {
  it('1. keeps a host across a restart, in a file only its owner reads', () => {
    const store = createRemoteHosts(file);
    expect(store.set(host)).toEqual({ ok: true, host });
    expect(createRemoteHosts(file).list()).toEqual([host]);
    if (process.platform !== 'win32') expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
  });

  it('2. reads nothing from a file of another shape, and skips only the entries that do not parse', () => {
    fs.writeFileSync(file, '{ not json');
    expect(() => createRemoteHosts(file).list()).not.toThrow();
    expect(createRemoteHosts(file).list()).toEqual([]);
    fs.writeFileSync(file, JSON.stringify({ version: 1, hosts: [host, { ...host, id: 'bad', sshTarget: '-oProxyCommand=x' }, { ...host, id: 'keyed', identityFile: '/k' }] }));
    expect(createRemoteHosts(file).list()).toEqual([host]);
    fs.writeFileSync(file, JSON.stringify({ version: 9, hosts: [host] }));
    expect(createRemoteHosts(file).list()).toEqual([]);
  });

  it('3. writes only what parses, one host per id', () => {
    const store = createRemoteHosts(file);
    expect(store.set({ ...host, sshTarget: 'a b' })).toMatchObject({ ok: false, code: 'invalid_target' });
    expect(fs.existsSync(file)).toBe(false);
    store.set(host);
    store.set({ ...host, name: 'Renamed' });
    expect(store.list()).toEqual([{ ...host, name: 'Renamed' }]);
    expect(store.get('build-1')?.name).toBe('Renamed');
  });

  it('4. removes a host, and removing one that is not there says so', () => {
    const store = createRemoteHosts(file);
    store.set(host);
    expect(store.remove('build-1')).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.remove('build-1')).toBe(false);
    expect(createRemoteHosts(file).list()).toEqual([]);
  });

  it('5. tells every change', () => {
    const store = createRemoteHosts(file);
    let told = 0;
    store.onChange(() => { told++; });
    store.set(host);
    store.remove('build-1');
    store.set({ ...host, sshTarget: 'a b' });
    expect(told).toBe(2);
  });

  it('6. refuses to remove a host agents are placed on, naming them; removes it once none is', () => {
    const fleet = [
      { id: 'w1', name: 'Remote One', remote: { hostId: 'build-1', folder: '/home/agent/work/p' } },
      { id: 'w2', name: 'Here', remote: undefined },
      { id: 'w3', name: '', remote: { hostId: 'build-1', folder: '/home/agent/work/q' } },
      { id: 'w4', name: 'Elsewhere', remote: { hostId: 'build-2', folder: '/x/y' } },
    ];
    expect(hostRemovalRefusal('build-1', fleet)).toMatch(/Remote One, w3/);
    expect(hostRemovalRefusal('build-2', fleet)).toMatch(/Elsewhere/);
    expect(hostRemovalRefusal('build-3', fleet)).toBeUndefined();
    expect(hostRemovalRefusal('build-1', fleet.filter((a) => a.remote?.hostId !== 'build-1'))).toBeUndefined();
  });
});
