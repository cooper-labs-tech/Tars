import { describe, it, expect } from 'vitest';
import { machineFacts, sessionEnvironment, type EnvironmentIo, type MachineFacts } from '../../../electron/services/session-environment';

/**
 * Each traced session's environment (the owner's decision of 27/11: exact values, never bucketed): the system's name,
 * version and architecture, the machine's model, its chip, its cores and its memory, read on macOS, Windows and Linux
 * each by its own means, plus what is the session's own (Tars's version, the locale, the time zone, the power).
 *
 * How it fails, written before the code (27/11):
 * E1. A serial number, a hardware uuid, the computer's name, the user's name or an address is read: a file or a
 *     command that holds one is opened (product_serial, product_uuid, board_serial, ioreg's platform serial,
 *     system_profiler, wmic, hostname, whoami, ifconfig, ipconfig), or os.hostname, os.userInfo or
 *     os.networkInterfaces is called.
 * E2. macOS: the model is not hw.model as sysctl gives it, the version not the system's own (15.7.2, not the Darwin
 *     kernel 24.6.0), the chip not the CPU's name.
 * E3. Linux: the distribution's name and version are not /etc/os-release's (NAME, VERSION_ID, unquoted); the model is
 *     not DMI's vendor and product; a board with no DMI (an ARM board) does not fall back to the device tree's model,
 *     whose trailing NUL is kept.
 * E4. Windows: the model is not the registry's SystemManufacturer and SystemProductName (REG_SZ parsed), the version
 *     not the system's own.
 * E5. A value that cannot be read throws, or becomes a guess or an empty string, rather than a clean null; a read
 *     that fails takes the other fields with it.
 * E6. Values are bucketed or rounded: the memory is not the exact byte count, the cores not the exact count.
 * E7. The session's part: the time zone or the UTC offset is not the one at the session's start (a zone with summer
 *     time gives two offsets in a year), Tars's version or the power state is guessed when unknown.
 */

type Read = { kind: 'file' | 'run'; what: string };

function io(platform: NodeJS.Platform, files: Record<string, string>, runs: Record<string, string>, over: Partial<EnvironmentIo> = {}) {
  const reads: Read[] = [];
  const base: EnvironmentIo = {
    platform,
    readFile: async (file) => {
      reads.push({ kind: 'file', what: file });
      if (file in files) return files[file];
      throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    },
    run: async (file, args) => {
      const line = [file, ...args].join(' ');
      reads.push({ kind: 'run', what: line });
      if (line in runs) return runs[line];
      throw new Error(`not runnable here: ${line}`);
    },
    cpus: () => Array.from({ length: 8 }, () => ({ model: 'Apple M3' })),
    totalmem: () => 34_359_738_368,
    machine: () => 'arm64',
    release: () => '24.6.0',
    ...over,
  };
  return { io: base, reads };
}

const FORBIDDEN = /serial|uuid|hostname|whoami|ioreg|system_profiler|wmic|ifconfig|ipconfig|networkinterfaces|userinfo/i;

describe('machine facts', () => {
  it('E2: macOS gives its own version, hw.model and the chip by name', async () => {
    const { io: x, reads } = io('darwin', {}, {
      '/usr/sbin/sysctl -n hw.model': 'Mac15,3\n',
    }, { systemVersion: () => '15.7.2' });
    const m = await machineFacts(x);
    expect(m).toEqual<MachineFacts>({
      osName: 'macOS', osVersion: '15.7.2', kernel: '24.6.0', arch: 'arm64',
      machineModel: 'Mac15,3', chip: 'Apple M3', cpuCores: 8, ramBytes: 34_359_738_368,
    });
    expect(reads.filter(r => FORBIDDEN.test(r.what))).toEqual([]);
  });

  it('E2: macOS with no system version from Electron asks sw_vers, never the kernel', async () => {
    const { io: x } = io('darwin', {}, {
      '/usr/sbin/sysctl -n hw.model': 'MacBookPro18,3',
      '/usr/bin/sw_vers -productVersion': '15.6.1\n',
    });
    const m = await machineFacts(x);
    expect(m.osVersion).toBe('15.6.1');
    expect(m.machineModel).toBe('MacBookPro18,3');
  });

  it('E3: Linux reads os-release and DMI, unquoted and trimmed', async () => {
    const { io: x, reads } = io('linux', {
      '/etc/os-release': 'PRETTY_NAME="Ubuntu 24.04.3 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\n',
      '/sys/devices/virtual/dmi/id/sys_vendor': 'Framework\n',
      '/sys/devices/virtual/dmi/id/product_name': 'Laptop 13 (AMD Ryzen 7040Series)\n',
    }, {}, {
      cpus: () => Array.from({ length: 16 }, () => ({ model: 'AMD Ryzen 7 7840U w/ Radeon  780M Graphics' })),
      totalmem: () => 32_891_637_760, machine: () => 'x86_64', release: () => '6.8.0-90-generic',
    });
    const m = await machineFacts(x);
    expect(m).toEqual<MachineFacts>({
      osName: 'Ubuntu', osVersion: '24.04', kernel: '6.8.0-90-generic', arch: 'x86_64',
      machineModel: 'Framework Laptop 13 (AMD Ryzen 7040Series)', chip: 'AMD Ryzen 7 7840U w/ Radeon  780M Graphics',
      cpuCores: 16, ramBytes: 32_891_637_760,
    });
    expect(reads.filter(r => FORBIDDEN.test(r.what))).toEqual([]);
  });

  it('E3: a product name that already starts with its vendor is not doubled', async () => {
    const { io: x } = io('linux', {
      '/usr/lib/os-release': 'NAME=Fedora Linux\nVERSION_ID=43\n',
      '/sys/devices/virtual/dmi/id/sys_vendor': 'LENOVO',
      '/sys/devices/virtual/dmi/id/product_name': 'LENOVO 21K5CTO1WW',
    }, {});
    const m = await machineFacts(x);
    expect(m.osName).toBe('Fedora Linux');
    expect(m.osVersion).toBe('43');
    expect(m.machineModel).toBe('LENOVO 21K5CTO1WW');
  });

  it('E3: an ARM board with no DMI takes the device tree model, its NUL dropped', async () => {
    const { io: x } = io('linux', {
      '/etc/os-release': 'NAME="Debian GNU/Linux"\nVERSION_ID="13"\n',
      '/proc/device-tree/model': 'Raspberry Pi 5 Model B Rev 1.0\u0000',
    }, {}, { cpus: () => Array.from({ length: 4 }, () => ({ model: '' })), machine: () => 'aarch64' });
    const m = await machineFacts(x);
    expect(m.machineModel).toBe('Raspberry Pi 5 Model B Rev 1.0');
    // A CPU Linux gives no name: null, never ''.
    expect(m.chip).toBeNull();
    expect(m.cpuCores).toBe(4);
  });

  it('E4: Windows reads the BIOS key of the registry', async () => {
    const key = 'HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS';
    const { io: x, reads } = io('win32', {}, {
      [`reg query ${key} /v SystemManufacturer`]: `\r\n${key}\r\n    SystemManufacturer    REG_SZ    Dell Inc.\r\n\r\n`,
      [`reg query ${key} /v SystemProductName`]: `\r\n${key}\r\n    SystemProductName    REG_SZ    XPS 13 9340\r\n\r\n`,
    }, {
      systemVersion: () => '10.0.26100', release: () => '10.0.26100', machine: () => 'x86_64',
      cpus: () => Array.from({ length: 22 }, () => ({ model: 'Intel(R) Core(TM) Ultra 7 155H' })), totalmem: () => 34_014_294_016,
    });
    const m = await machineFacts(x);
    expect(m).toEqual<MachineFacts>({
      osName: 'Windows', osVersion: '10.0.26100', kernel: '10.0.26100', arch: 'x86_64',
      machineModel: 'Dell Inc. XPS 13 9340', chip: 'Intel(R) Core(TM) Ultra 7 155H', cpuCores: 22, ramBytes: 34_014_294_016,
    });
    expect(reads.filter(r => FORBIDDEN.test(r.what))).toEqual([]);
  });

  it('E5: every read failing gives clean nulls, one at a time, and never throws', async () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const { io: x } = io(platform, {}, {}, { cpus: () => [], totalmem: () => 0, machine: () => '' });
      const m = await machineFacts(x);
      expect(m.machineModel).toBeNull();
      expect(m.chip).toBeNull();
      expect(m.cpuCores).toBeNull();
      expect(m.ramBytes).toBeNull();
      expect(m.arch).toBeNull();
      expect(Object.values(m)).not.toContain('');
    }
    // The model unreadable leaves the rest standing.
    const { io: x } = io('darwin', {}, {}, { systemVersion: () => '15.7.2' });
    const m = await machineFacts(x);
    expect(m.machineModel).toBeNull();
    expect(m.osVersion).toBe('15.7.2');
    expect(m.chip).toBe('Apple M3');
  });

  it('E1: the node calls that give a name or an address are never made', async () => {
    const trap = () => { throw new Error('read a name or an address'); };
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      const { io: x } = io(platform, {}, {}, { hostname: trap, userInfo: trap, networkInterfaces: trap } as Partial<EnvironmentIo>);
      await expect(machineFacts(x)).resolves.toBeDefined();
    }
  });
});

describe('a session\'s environment', () => {
  const machine: MachineFacts = {
    osName: 'macOS', osVersion: '15.7.2', kernel: '24.6.0', arch: 'arm64',
    machineModel: 'Mac15,3', chip: 'Apple M3', cpuCores: 8, ramBytes: 34_359_738_368,
  };

  it('E6 and E7: exact values, and the offset at the session\'s start', () => {
    const winter = Date.UTC(2026, 0, 15, 12);
    const summer = Date.UTC(2026, 6, 15, 12);
    const at = (t: number) => sessionEnvironment(machine, {
      at: t, tarsVersion: '2.0.7', tarsArch: 'arm64', locale: 'de-DE', timeZone: 'Europe/Berlin', onBattery: true,
    });
    expect(at(winter)).toEqual({
      ...machine, tarsVersion: '2.0.7', tarsArch: 'arm64', locale: 'de-DE', timeZone: 'Europe/Berlin', utcOffsetMinutes: 60, onBattery: true,
    });
    expect(at(summer).utcOffsetMinutes).toBe(120);
  });

  it('E7: what is not known is null, never guessed', () => {
    const e = sessionEnvironment(machine, { at: Date.UTC(2026, 10, 27), tarsArch: 'x64', timeZone: 'UTC' });
    expect(e.tarsVersion).toBeNull();
    expect(e.locale).toBeNull();
    expect(e.onBattery).toBeNull();
    expect(e.utcOffsetMinutes).toBe(0);
    // A zone the runtime does not know: no offset invented from it.
    const odd = sessionEnvironment(machine, { at: Date.UTC(2026, 10, 27), tarsArch: 'x64', timeZone: 'Nowhere/Atlantis' });
    expect(odd.timeZone).toBe('Nowhere/Atlantis');
    expect(odd.utcOffsetMinutes).toBeNull();
  });
});
