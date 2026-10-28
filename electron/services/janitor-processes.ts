import * as fs from 'fs';

/**
 * Every process the disk janitor checks a folder against: its command line, and the paths it is in (its working
 * folder, its executable, and on Linux the files it holds open: lsof's cwd and txt on macOS; /proc's cwd, exe and fd
 * on Linux), each distinct path resolved once, here, asynchronously, so the rules compare strings (the Audit's M1 on
 * #542's re-check: resolving every path again for each folder held the main thread about 8 s a scan). Null when the
 * table cannot be read wholly: a failed ps, a failed lsof even with some output (the Audit's Info 2), Windows.
 */

type Run = (file: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>;
type Proc = { readlink: (p: string) => string; readdir: (p: string) => string[] };

export async function processesNow(deps: {
  run: Run;
  platform?: NodeJS.Platform;
  realpath?: (p: string) => Promise<string>;
  proc?: Proc;
}): Promise<Array<{ pid: number; command: string; paths: string[] }> | null> {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') return null;
  const ps = await deps.run('ps', ['-A', '-o', 'pid=,command=']);
  if (!ps.ok) return null;
  const commands = new Map<number, string>();
  for (const line of ps.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) commands.set(Number(m[1]), m[2]);
  }
  const raw = new Map<number, string[]>();
  const add = (pid: number, p: string) => { if (p) raw.set(pid, [...(raw.get(pid) ?? []), p]); };
  if (platform === 'linux') {
    const proc = deps.proc ?? { readlink: fs.readlinkSync, readdir: (p: string) => fs.readdirSync(p) };
    for (const pid of commands.keys()) {
      for (const link of ['cwd', 'exe']) { try { add(pid, proc.readlink(`/proc/${pid}/${link}`)); } catch { /* gone, or not ours */ } }
      let fds: string[] = [];
      try { fds = proc.readdir(`/proc/${pid}/fd`); } catch { /* not ours */ }
      for (const fd of fds) { try { add(pid, proc.readlink(`/proc/${pid}/fd/${fd}`)); } catch { /* closed */ } }
    }
  } else {
    // macOS's own, by its path: /usr/sbin is not on every PATH an app is started with.
    const lsof = await deps.run('/usr/sbin/lsof', ['-w', '-n', '-P', '-d', 'cwd,txt', '-F', 'pn']);
    if (!lsof.ok) return null;
    let pid = 0;
    for (const line of lsof.stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid) add(pid, line.slice(1));
    }
  }
  // Each distinct path resolved once, to the disk's own spelling and where its links lead.
  const realpath = deps.realpath ?? ((p: string) => fs.promises.realpath(p));
  const distinct = [...new Set([...raw.values()].flat())];
  const resolved = new Map<string, string>();
  for (const p of distinct) {
    try { resolved.set(p, await realpath(p)); } catch { resolved.set(p, p); }
  }
  return [...commands].map(([pid, command]) => ({ pid, command, paths: (raw.get(pid) ?? []).map(p => resolved.get(p) ?? p) }));
}
