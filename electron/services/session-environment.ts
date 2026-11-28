import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Each traced session's environment (the owner's decision of 27/11: exact values, never bucketed): the system's name,
 * version and architecture, the machine's model, its chip, its cores and its memory, read once per run, each system by
 * its own means, and what is the session's own, read at its start: Tars's version, the locale, the time zone and its
 * offset, whether the computer ran on battery.
 *
 * - **macOS**: the version is the system's own (Electron's process.getSystemVersion, else `sw_vers`), never the Darwin
 *   kernel's; the model is `sysctl -n hw.model` (Mac15,3); the chip is the CPU's name (Apple M3).
 * - **Linux**: the distribution's NAME and VERSION_ID from os-release; the model from DMI (sys_vendor and
 *   product_name, readable by every user), else the device tree's (an ARM board).
 * - **Windows**: the system's version (10.0.26100); the model from the registry's BIOS key (SystemManufacturer and
 *   SystemProductName), read by `%SystemRoot%\System32\reg.exe`, never `reg` by its bare name.
 *
 * Never read: a serial number or a hardware uuid (DMI's product_serial, product_uuid, board_serial; ioreg's platform
 * serial; system_profiler; wmic), the computer's name, the user's name, an address. A value that cannot be read is
 * null, never a guess.
 */

export interface MachineFacts {
  osName: string | null;
  osVersion: string | null;
  /** The kernel's release (os.release()): Darwin's on macOS, Linux's, Windows's build. */
  kernel: string | null;
  /** The machine's architecture as the system names it (os.machine(): arm64, x86_64, aarch64). */
  arch: string | null;
  machineModel: string | null;
  chip: string | null;
  cpuCores: number | null;
  ramBytes: number | null;
}

export interface SessionEnvironment extends MachineFacts {
  tarsVersion: string | null;
  /** The architecture Tars itself runs as (process.arch): x64 under Rosetta on an arm64 Mac. */
  tarsArch: string;
  /** The system's language and region (de-DE). */
  locale: string | null;
  timeZone: string | null;
  /** The time zone's offset from UTC at the session's start, in minutes (Berlin: 60 in winter, 120 in summer). */
  utcOffsetMinutes: number | null;
  /** Whether the computer ran on battery at the session's start; null where the system does not say. */
  onBattery: boolean | null;
}

/** What the facts are read through: the system's files, a few commands, and node's os module, nothing else. */
export interface EnvironmentIo {
  platform: NodeJS.Platform;
  /** Windows: %SystemRoot%, the folder reg.exe is run from (never by its bare name, looked for in the working folder first). */
  systemRoot?: string;
  /** The system's own version (Electron's process.getSystemVersion), when the caller has it. */
  systemVersion?(): string;
  readFile(file: string): Promise<string>;
  /** A command's standard output, run with an argv array, never through a shell. */
  run(file: string, args: string[]): Promise<string>;
  cpus(): Array<{ model: string }>;
  totalmem(): number;
  machine(): string;
  release(): string;
}

/** Node's own: the files, execFile with a short timeout, and the four os functions read here. */
export function nodeEnvironmentIo(systemVersion?: () => string): EnvironmentIo {
  return {
    platform: process.platform,
    systemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
    systemVersion,
    readFile: (file) => fs.promises.readFile(file, 'utf8'),
    run: (file, args) => new Promise((resolve, reject) => {
      execFile(file, args, { timeout: 5000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    }),
    cpus: () => os.cpus(),
    totalmem: () => os.totalmem(),
    machine: () => os.machine(),
    release: () => os.release(),
  };
}

/** A value as the system gave it, trimmed, its NULs dropped; null when there is nothing. */
function clean(value: string | undefined | null): string | null {
  const v = (value ?? '').replace(/\0/g, '').trim();
  return v ? v : null;
}

async function attempt<T>(read: () => Promise<T> | T): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/** os-release's KEY, unquoted. */
function osReleaseValue(text: string, key: string): string | null {
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
  if (!m) return null;
  return clean(m[1].trim().replace(/^(["'])(.*)\1$/, '$2'));
}

/** A REG_SZ value of `reg query <key> /v <name>`'s answer. */
function registryValue(text: string, name: string): string | null {
  const m = new RegExp(`^\\s*${name}\\s+REG_SZ\\s+(.*)$`, 'm').exec(text);
  return m ? clean(m[1]) : null;
}

/** Vendor and product as one name, the vendor once when the product already starts with it. */
function joinModel(vendor: string | null, product: string | null): string | null {
  if (!product) return vendor;
  if (!vendor || product.toLowerCase().startsWith(vendor.toLowerCase())) return product;
  return `${vendor} ${product}`;
}

const DMI = '/sys/devices/virtual/dmi/id';
const BIOS_KEY = 'HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS';

/**
 * reg.exe by its full path, as macOS's commands are run: Windows looks for a bare name in the working folder before
 * the PATH. %SystemRoot% when it is a plain drive-absolute folder, else C:\Windows.
 */
function regExe(systemRoot: string | undefined): string {
  const root = systemRoot && /^[A-Za-z]:[\\/][^:]*$/.test(systemRoot) ? systemRoot : 'C:\\Windows';
  return path.win32.join(root, 'System32', 'reg.exe');
}

/** The machine and its system, every value read on its own: one that fails is null and leaves the rest standing. */
export async function machineFacts(io: EnvironmentIo): Promise<MachineFacts> {
  const cpus = await attempt(() => io.cpus());
  const total = await attempt(() => io.totalmem());
  const facts: MachineFacts = {
    osName: null,
    osVersion: null,
    kernel: clean(await attempt(() => io.release())),
    arch: clean(await attempt(() => io.machine())),
    machineModel: null,
    chip: clean(cpus?.[0]?.model),
    cpuCores: cpus && cpus.length > 0 ? cpus.length : null,
    ramBytes: typeof total === 'number' && total > 0 ? total : null,
  };
  const systemVersion = clean(await attempt(() => io.systemVersion?.() ?? ''));

  if (io.platform === 'darwin') {
    facts.osName = 'macOS';
    facts.osVersion = systemVersion ?? clean(await attempt(() => io.run('/usr/bin/sw_vers', ['-productVersion'])));
    facts.machineModel = clean(await attempt(() => io.run('/usr/sbin/sysctl', ['-n', 'hw.model'])));
    facts.chip ??= clean(await attempt(() => io.run('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'])));
  } else if (io.platform === 'win32') {
    facts.osName = 'Windows';
    facts.osVersion = systemVersion ?? facts.kernel;
    const reg = regExe(io.systemRoot);
    const value = async (name: string) => registryValue((await attempt(() => io.run(reg, ['query', BIOS_KEY, '/v', name]))) ?? '', name);
    facts.machineModel = joinModel(await value('SystemManufacturer'), await value('SystemProductName'));
  } else if (io.platform === 'linux') {
    const release = (await attempt(() => io.readFile('/etc/os-release'))) ?? (await attempt(() => io.readFile('/usr/lib/os-release'))) ?? '';
    facts.osName = osReleaseValue(release, 'NAME') ?? 'Linux';
    facts.osVersion = osReleaseValue(release, 'VERSION_ID');
    const vendor = clean(await attempt(() => io.readFile(path.posix.join(DMI, 'sys_vendor'))));
    const product = clean(await attempt(() => io.readFile(path.posix.join(DMI, 'product_name'))));
    facts.machineModel = joinModel(vendor, product) ?? clean(await attempt(() => io.readFile('/proc/device-tree/model')));
  } else {
    facts.osName = io.platform;
    facts.osVersion = systemVersion;
  }
  return facts;
}

/** A time zone's offset from UTC at a moment, in minutes; null for a zone this runtime does not know. */
export function utcOffsetAt(timeZone: string, at: number): number | null {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(at)).find(p => p.type === 'timeZoneName')?.value ?? '';
    if (name === 'GMT') return 0;
    const m = /^GMT([+-])(\d{1,2}):?(\d{2})?$/.exec(name);
    if (!m) return null;
    return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
  } catch {
    return null;
  }
}

/** The session's environment: the machine's facts and what is its own at its start. */
export function sessionEnvironment(machine: MachineFacts, now: {
  at: number; tarsArch: string; tarsVersion?: string; locale?: string; timeZone?: string; onBattery?: boolean;
}): SessionEnvironment {
  const timeZone = clean(now.timeZone);
  return {
    ...machine,
    tarsVersion: clean(now.tarsVersion),
    tarsArch: now.tarsArch,
    locale: clean(now.locale),
    timeZone,
    utcOffsetMinutes: timeZone ? utcOffsetAt(timeZone, now.at) : null,
    onBattery: typeof now.onBattery === 'boolean' ? now.onBattery : null,
  };
}
