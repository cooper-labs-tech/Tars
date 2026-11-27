import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { writeFakeClis } from './fake-clis.mjs';
import { startStandIn, MODEL_ID } from './stand-in-openai-endpoint.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * Each traced session's environment, in the real app (the owner's request of 27/11, exact values). Two agents on an
 * inference endpoint (e2e/stand-in-openai-endpoint.mjs on loopback), both traced: Q, a qwen-code agent (the qwen
 * stand-in of e2e/fake-clis.mjs, whose --version says 0.25.2), and C, a codex agent (e2e/fake-codex.mjs, whose
 * --version says codex-cli 0.163.0, and which on an endpoint sends codex 0.170's request: the session-id and
 * x-codex-turn-metadata headers, client_metadata in the body, both carrying the installation id codex keeps in its
 * home). Asserted:
 * 1. Each session keeps its harness's exact version, read from the binary its terminal was started with; codex's is
 *    asked in a throwaway home (the stand-in logs the HOME and npm prefix its --version got): never the sandbox's own.
 * 2. Each session keeps its environment, exact: the system's name, version, kernel and architecture, the machine's
 *    model, chip, cores and memory as this test reads them itself on this system (sysctl, os-release and DMI, or the
 *    registry), Tars's version and architecture, the locale, the time zone and its offset, the power at the start;
 *    and no computer name, user name or address anywhere in it.
 * 3. Electron's powerMonitor says sleep, wake, battery and mains power: every traced session open then keeps each, in
 *    order; a session that has ended keeps none after its end.
 * 4. Each of C's requests says how many traced sessions were live when it was sent: 2 while Q's terminal is open, 1
 *    once it has exited.
 * 5. C's session keeps codex's own session id. Codex's installation id reaches the endpoint as codex sent it (body and
 *    header), and is in no row or blob of the trace store, nor in the export, nor in the upload's preview.
 * The artefact: values.json, the stand-in's request log, the export, the preview, the fake CLIs' logs, the app's log.
 */

const Q = 'eeee5555-0000-4000-8000-0000000000e3';
const C = 'eeee5555-0000-4000-8000-0000000000e4';
const EP = 'ep-0e2e02';
type Api = { electronAPI: Record<string, Record<string, (...a: unknown[]) => Promise<unknown>>> };
type Summary = Record<string, unknown> & { traceId: string; agentId: string; endedAt?: number; harnessVersion?: string; nativeSessionId?: string; environment?: Record<string, unknown>; events?: Array<{ kind: string; at: number }> };
type SessionView = { session: Summary; turns: Array<{ requests: Array<Record<string, unknown> & { liveSessions?: number; startedAt: number }> }> };

/** The machine and its system, as this test reads them on its own, by each system's means. */
function machineHere(): Record<string, unknown> {
  const run = (file: string, args: string[]) => { try { return execFileSync(file, args, { encoding: 'utf8' }).trim() || null; } catch { return null; } };
  const read = (file: string) => { try { return fs.readFileSync(file, 'utf8').replace(/\0/g, '').trim() || null; } catch { return null; } };
  const facts: Record<string, unknown> = {
    kernel: os.release(), arch: os.machine(), chip: os.cpus()[0]?.model.trim() || null, cpuCores: os.cpus().length, ramBytes: os.totalmem(),
  };
  if (process.platform === 'darwin') {
    Object.assign(facts, { osName: 'macOS', osVersion: run('/usr/bin/sw_vers', ['-productVersion']), machineModel: run('/usr/sbin/sysctl', ['-n', 'hw.model']) });
  } else if (process.platform === 'linux') {
    const rel = read('/etc/os-release') ?? read('/usr/lib/os-release') ?? '';
    const value = (k: string) => (new RegExp(`^${k}=(.*)$`, 'm').exec(rel)?.[1] ?? '').replace(/^"|"$/g, '') || null;
    const vendor = read('/sys/devices/virtual/dmi/id/sys_vendor');
    const product = read('/sys/devices/virtual/dmi/id/product_name');
    const model = product && vendor && !product.toLowerCase().startsWith(vendor.toLowerCase()) ? `${vendor} ${product}` : product ?? vendor;
    Object.assign(facts, { osName: value('NAME') ?? 'Linux', osVersion: value('VERSION_ID'), machineModel: model ?? read('/proc/device-tree/model') });
  } else if (process.platform === 'win32') {
    const reg = (name: string) => new RegExp(`${name}\\s+REG_SZ\\s+(.*)`).exec(run('reg', ['query', 'HKLM\\HARDWARE\\DESCRIPTION\\System\\BIOS', '/v', name]) ?? '')?.[1].trim() ?? null;
    const vendor = reg('SystemManufacturer');
    const product = reg('SystemProductName');
    Object.assign(facts, { osName: 'Windows', machineModel: product && vendor && !product.toLowerCase().startsWith(vendor.toLowerCase()) ? `${vendor} ${product}` : product ?? vendor });
  }
  return facts;
}

/** What must never be in an environment: this computer's name, this user's name, its addresses. */
function namesAndAddresses(): string[] {
  const out = [os.hostname(), os.userInfo().username];
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (!a.internal) out.push(a.address);
  return out.filter(v => v && v.length >= 4);
}

test('each traced session keeps its harness version, its environment, its power events and the live count of its requests, and never codex\'s installation id', async () => {
  test.setTimeout(4 * 60_000);
  const home = fs.mkdtempSync('/tmp/dorothy-e2e-trace-env-');
  const project = path.join(home, 'projects', 'project-a');
  const dir = path.join(home, '.tars');
  for (const d of [project, dir]) fs.mkdirSync(d, { recursive: true });
  execFileSync('git', ['init', '-q', project]);
  const fakes = writeFakeClis(home, ['qwen-code', 'codex']);
  const fakeLog = path.join(home, 'fake-cli.jsonl');
  const codexLog = path.join(home, 'fake-codex.jsonl');
  const standinLog = test.info().outputPath('endpoint-requests.jsonl');
  const standin = await startStandIn({ log: standinLog });

  const agent = (id: string, name: string, extra: Record<string, unknown>) => ({
    id, name, character: 'robot', status: 'idle', permissionMode: 'bypass', projectPath: project, skills: [],
    createdAt: '2026-11-27T08:00:00.000Z', lastActivity: '2026-11-27T08:00:00.000Z', model: MODEL_ID, endpointId: EP, traces: true, ...extra,
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify([
    agent(Q, 'Q', { provider: 'qwen-code', cliPath: fakes['qwen-code'] }),
    agent(C, 'C', { provider: 'codex', cliPath: fakes.codex }),
  ], null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify([project]));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9', cliPaths: { qwencode: fakes['qwen-code'], codex: fakes.codex },
    inferenceEndpoints: [{ id: EP, name: 'Remote host', baseUrl: standin.baseUrl, allowTraces: true, models: [MODEL_ID], approved: true, approvedBaseUrl: standin.baseUrl, holdMaxSeconds: 30 }],
    traces: { projects: [project], capBytes: 1024 ** 3, retentionDays: 30, pairs: [{ harness: 'qwen-code', models: '*' }, { harness: 'codex', models: '*' }] },
  }, null, 2));

  const port = apiPort(31970);
  const dist = path.resolve('electron', 'dist');
  const values: Record<string, unknown> = {};
  const keep = (more: Record<string, unknown>) => { Object.assign(values, more); recordValues(values); };
  const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []) as Array<Record<string, any>>;
  let app: ElectronApplication | undefined;
  try {
    app = await launchSandboxed(electron, home, { env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: port, DOROTHY_E2E: '1' } });
    const appLog = test.info().outputPath('app.log');
    app.process().stdout?.on('data', (d) => fs.appendFileSync(appLog, d));
    app.process().stderr?.on('data', (d) => fs.appendFileSync(appLog, d));
    const page: Page = await app.firstWindow();
    const api = <T>(group: string, name: string, ...args: unknown[]) =>
      page.evaluate(({ group, name, args }) => ((window as unknown as Api).electronAPI[group][name] as (...a: unknown[]) => Promise<unknown>)(...args), { group, name, args }) as Promise<T>;
    const sessionOf = async (agentId: string) => {
      const list = await api<{ sessions: Summary[] }>('traces', 'list', {});
      const s = list.sessions.find(x => x.agentId === agentId);
      return s ? api<SessionView>('traces', 'session', s.traceId) : undefined;
    };
    const power = (events: string[]) => app!.evaluate(({ powerMonitor }, list) => { for (const e of list) powerMonitor.emit(e); }, events);

    // Q's terminal first, so that C's requests are sent with two traced sessions open.
    await api('agent', 'start', { id: Q, prompt: '' });
    await expect.poll(() => lines(fakeLog).some(e => e.launch && e.agent === Q), { timeout: 30_000 }).toBe(true);
    await api('agent', 'start', { id: C, prompt: 'Run the probe and report what it printed.' });
    await expect.poll(() => lines(codexLog).filter(e => e.model).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);

    // 1 and 2: the version and the environment, read after the start. Soft, as every check of what is new here: a
    // build without it shows each missing part at once.
    const soft = expect.configure({ soft: true });
    await soft.poll(async () => [(await sessionOf(Q))?.session.harnessVersion ?? null, (await sessionOf(C))?.session.harnessVersion ?? null], { timeout: 30_000, message: 'the harness versions' }).toEqual(['0.25.2', '0.163.0']);
    await soft.poll(async () => !!(await sessionOf(C))?.session.environment, { timeout: 15_000, message: "C's environment kept" }).toBe(true);
    const q1 = await sessionOf(Q);
    const c1 = await sessionOf(C);
    const own = await app.evaluate(({ app: a, powerMonitor }) => ({ version: a.getVersion(), locale: a.getSystemLocale(), onBattery: powerMonitor.isOnBatteryPower(), arch: process.arch }));
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const expected = {
      ...machineHere(), tarsVersion: own.version, tarsArch: own.arch, locale: own.locale, timeZone: zone,
      utcOffsetMinutes: -new Date(Number(c1?.session.startedAt)).getTimezoneOffset(), onBattery: own.onBattery,
    };
    const versionProbe = lines(codexLog).find(e => e.version);
    keep({ q1: q1?.session, c1: c1?.session, expected, versionProbe, sandboxHome: home });
    expect.soft(c1?.session.environment, "C's environment").toEqual(expected);
    expect.soft(q1?.session.environment, "Q's environment").toEqual({ ...expected, utcOffsetMinutes: -new Date(Number(q1?.session.startedAt)).getTimezoneOffset() });
    const forbidden = namesAndAddresses().filter(v => JSON.stringify(c1?.session.environment ?? {}).includes(v));
    expect.soft(forbidden, 'a name or an address in the environment').toEqual([]);
    expect.soft(versionProbe, "codex's --version was asked").toBeTruthy();
    expect.soft(String(versionProbe?.home), "the --version probe's HOME").toMatch(/tars-version-probe-/);
    expect.soft(String(versionProbe?.home).startsWith(home), "the --version probe's HOME is the sandbox's own").toBe(false);
    expect.soft(String(versionProbe?.npmPrefix).startsWith(path.dirname(String(versionProbe?.home))), "npm's prefix in the probe's own folder").toBe(true);

    // 3. Power, while both are open.
    await power(['suspend', 'resume', 'on-battery', 'on-ac']);
    await soft.poll(async () => ((await sessionOf(Q))?.session.events ?? []).map(e => e.kind), { timeout: 10_000, message: "Q's events while open" }).toEqual(['sleep', 'wake', 'battery', 'ac']);

    // Q's terminal exits: its session ends, and takes no later event.
    await api('agent', 'stop', Q);
    await expect.poll(async () => (await sessionOf(Q))?.session.endedAt ?? null, { timeout: 30_000 }).not.toBeNull();
    await power(['suspend']);
    // 4. C's next turn, with one traced session open.
    const before = lines(codexLog).filter(e => e.model).length;
    await api('agent', 'sendInput', { id: C, input: 'Run the probe once more.\r' });
    await expect.poll(() => lines(codexLog).filter(e => e.model).length, { timeout: 60_000 }).toBeGreaterThanOrEqual(before + 2);
    await expect.poll(async () => ((await sessionOf(C))?.turns ?? []).flatMap(t => t.requests).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(4);
    const q2 = await sessionOf(Q);
    const c2 = await sessionOf(C);
    const cRequests = (c2?.turns ?? []).flatMap(t => t.requests).sort((a, b) => a.startedAt - b.startedAt);
    keep({ q2: q2?.session, c2: c2?.session, cLive: cRequests.map(r => r.liveSessions ?? null) });
    expect.soft((c2?.session.events ?? []).map(e => e.kind), "C's events").toEqual(['sleep', 'wake', 'battery', 'ac', 'sleep']);
    expect.soft((q2?.session.events ?? []).map(e => e.kind), "Q's events, none after its end").toEqual(['sleep', 'wake', 'battery', 'ac']);
    expect.soft(cRequests.map(r => r.liveSessions ?? null), "the live count on C's requests").toEqual([2, 2, 1, 1]);

    // 5. Codex's own session id, and its installation id.
    const codexSession = lines(codexLog).find(e => e.model)?.session;
    const reached = lines(standinLog).filter(e => e.method === 'POST' && String(e.url).endsWith('/responses'));
    const install = String(reached[0]?.body?.client_metadata?.['x-codex-installation-id'] ?? '');
    keep({ codexSession, install, reachedHeaders: reached.map(r => Object.keys(r.headers ?? {}).sort()) });
    expect.soft(c2?.session.nativeSessionId, "C's native session id").toBe(codexSession);
    expect.soft(install, 'codex sent an installation id').toMatch(/^[0-9a-f-]{36}$/);
    expect.soft(reached.every(r => r.body?.client_metadata?.['x-codex-installation-id'] === install), 'the body reached the endpoint as sent').toBe(true);
    expect.soft(reached.every(r => String(r.headers?.['x-codex-turn-metadata'] ?? '').includes(install)), "codex's turn metadata header reached the endpoint as sent").toBe(true);
    const held = await app.evaluate((_e, { dist, traceId }) => {
      const req = process.mainModule!.require;
      const runtime = req(`${dist}/services/traces-runtime.js`);
      const zlib = req('zlib');
      const Database = req('better-sqlite3');
      const exported = [...req(`${dist}/services/trace-export.js`).traceExportLines(runtime.traceStore(), {})] as string[];
      const preview = JSON.stringify(runtime.traceUploader().preview(traceId));
      const db = new Database(runtime.TRACES_DB_FILE, { readonly: true });
      const rows: string[] = [];
      for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>) {
        for (const row of db.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>) {
          for (const v of Object.values(row)) {
            if (Buffer.isBuffer(v)) rows.push((row.codec === 'zstd' ? zlib.zstdDecompressSync(v) : zlib.brotliDecompressSync(v)).toString('utf8'));
            else rows.push(String(v));
          }
        }
      }
      db.close();
      return { exported, preview, stored: rows.join('\n'), file: runtime.TRACES_DB_FILE as string };
    }, { dist, traceId: c2!.session.traceId });
    fs.writeFileSync(test.info().outputPath('traces-export.jsonl'), `${held.exported.join('\n')}\n`);
    fs.writeFileSync(test.info().outputPath('upload-preview.json'), held.preview);
    const onDisk = fs.readdirSync(path.dirname(held.file)).filter(f => f.startsWith(path.basename(held.file)))
      .filter(f => fs.readFileSync(path.join(path.dirname(held.file), f)).includes(install));
    keep({ installIn: { stored: held.stored.includes(install), exported: held.exported.join('\n').includes(install), preview: held.preview.includes(install), files: onDisk } });
    expect.soft(held.stored.includes(codexSession), 'the store holds the session id (the dump reads the store)').toBe(true);
    expect.soft(held.stored.includes(install), 'the installation id in a row or blob of the store').toBe(false);
    expect.soft(onDisk, 'the installation id in the database files').toEqual([]);
    expect.soft(held.exported.join('\n').includes(install), 'the installation id in the export').toBe(false);
    expect.soft(held.preview.includes(install), "the installation id in the upload's preview").toBe(false);
    const exportedC = held.exported.map(l => JSON.parse(l)).find(l => l.table === 'traces' && l.agent_id === C);
    expect.soft(exportedC, "C's exported session").toMatchObject({ client_version: '0.163.0', native_session_id: codexSession, environment: expected });
  } finally {
    await app?.close().catch(() => {});
    await standin.close();
    for (const f of [fakeLog, codexLog]) if (fs.existsSync(f)) fs.copyFileSync(f, test.info().outputPath(path.basename(f)));
    removeHome(home);
  }
});
