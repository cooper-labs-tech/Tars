import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Makes the directory this run's surfaces write their tolerated page errors
 * into. See recordPageErrors in surfaces.mjs and e2e/known-errors.spec.ts.
 *
 * Fresh for every run, so nothing an earlier run saw can pass for something this
 * one saw. Not under test-results: Playwright keeps that folder between runs
 * when its UI or an editor drives it. The workers find it through the
 * environment, which they inherit because Playwright starts them after this.
 */
export default async function globalSetup(config) {
  const restoreTemp = canonicalTemp();
  // The server the config started (ports.mjs is not importable from here: the
  // config loads it first, and this file then gets it without its exports).
  await warmRoutes(process.env.DOROTHY_DEV_URL || config.webServer?.url);
  // The command that reproduces this run, beside its artefacts: the same
  // arguments, the variables that shape a run, and the commit it ran on.
  const runDir = config.projects[0]?.outputDir ?? process.env.E2E_RUN_DIR;
  if (runDir) {
    fs.mkdirSync(runDir, { recursive: true });
    const shaping = ['E2E_PORT_OFFSET', 'E2E_TRACE', 'E2E_LIVE', 'DOROTHY_DEV_URL'].filter(name => process.env[name]).map(name => `${name}=${process.env[name]}`);
    let commit = 'unknown';
    try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
    fs.writeFileSync(path.join(runDir, 'command.txt'), [
      `# commit ${commit}, ${new Date().toISOString()}`,
      'npx tsc -p electron/tsconfig.json',
      [...shaping, 'npx playwright', ...process.argv.slice(2)].join(' '),
      '',
    ].join('\n'));
    console.log(`[e2e] run directory: ${runDir}`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-e2e-page-errors-'));
  process.env.E2E_PAGE_ERRORS_DIR = dir;
  return () => {
    fs.rmSync(dir, { recursive: true, force: true });
    restoreTemp();
  };
}

/**
 * On Windows, points TEMP and TMP at the canonical spelling of the temp dir,
 * which the workers inherit, and returns what puts them back.
 *
 * CI's windows-latest runs as runneradmin, whose %TEMP% is the 8.3 short
 * C:\Users\RUNNER~1\AppData\Local\Temp. A spec that makes its sandbox under
 * os.tmpdir() then seeds paths the app reports in their long form: the Claude
 * project decoder rebuilds a folder name from the disk, and RUNNER-1 names no
 * folder there. fs.realpathSync, which the specs call, does not expand a short
 * name; fs.realpathSync.native does, and a case or a junction as well.
 * Reproduced on 2026-09-26 with %TEMP% spelled in capitals:
 * claude-projects-paths.spec.ts listed the project under the disk's spelling.
 * darwin and linux are left as they are: their references were recorded so.
 */
function canonicalTemp() {
  if (process.platform !== 'win32') return () => {};
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  const canonical = fs.realpathSync.native(os.tmpdir());
  process.env.TEMP = canonical;
  process.env.TMP = canonical;
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * Every page of the app compiled before the first spec starts: each route's
 * HTML asked of next dev, and the scripts it names.
 *
 * next dev compiles a route on its first request, and a page stays behind the
 * launch splash until its scripts are there to hydrate it. On CI's
 * windows-latest that took longer than the specs wait: the splash still stood
 * over /settings 44 s after the load, and a click there timed out at 30 s;
 * over / it outlasted splashGone's 15 s. Paid here once, in
 * whatever time it takes, and never inside a spec. The web server is up by
 * now: Playwright starts it before the global setup.
 *
 * The routes are read from src/app, so a page added there is warmed too. A
 * route that does not answer is said, and the run goes on: the specs that
 * need it will say more.
 */
async function warmRoutes(devUrl) {
  if (!devUrl) { console.warn('[e2e] no web server in the config: no route warmed'); return; }
  const app = path.join(process.cwd(), 'src', 'app');
  const routes = [];
  const walk = (dir, route) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        if (entry.name === 'page.tsx') routes.push(route || '/');
        continue;
      }
      if (entry.name === 'api' || entry.name.startsWith('[') || entry.name.startsWith('_')) continue;
      const segment = entry.name.startsWith('(') ? '' : `/${entry.name}`;
      walk(path.join(dir, entry.name), route + segment);
    }
  };
  walk(app, '');
  const started = Date.now();
  for (const route of routes.sort()) {
    const began = Date.now();
    try {
      const html = await (await fetch(devUrl + route, { signal: AbortSignal.timeout(180_000) })).text();
      const scripts = [...new Set([...html.matchAll(/src="(\/_next\/[^"]+\.js[^"]*)"/g)].map(m => m[1]))];
      await Promise.all(scripts.map(src => fetch(devUrl + src, { signal: AbortSignal.timeout(180_000) }).then(r => r.arrayBuffer())));
      console.log(`[e2e] warmed ${route} (${scripts.length} scripts) in ${((Date.now() - began) / 1000).toFixed(1)} s`);
    } catch (error) {
      console.warn(`[e2e] could not warm ${route}: ${error}`);
    }
  }
  console.log(`[e2e] ${routes.length} routes warmed in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
