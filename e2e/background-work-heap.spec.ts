import { test, expect, _electron as electron } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * The main process's heap at the rests of agents with long transcripts (the V8 fatals of the main process on
 * 2026-10-13 and 2026-10-16, after 4.9 days and 8.7 hours up: both in a file read creating a string, the heap at its
 * limit; the live main held 2.4 GB of V8 pages an hour after its launch).
 *
 * In the real app, a sandbox Tars and four agents whose transcripts run to 40 MB each, a few background tasks in each:
 * the main process's own pendingBackgroundWork (what agent-watch, task-watch and the sleep ask at every rest) is called
 * for each, three rests apiece, a few lines appended between two. Then the heap is collected and measured: it must
 * hold the few lines kept, not the 160 MB of transcripts. On the build before the fix, the kept lines pointed into each
 * whole transcript's string (V8 sliced strings) and held every byte of it.
 * The artefact: values.json with the heap before and after, and what each rest answered.
 */

const MB = 1e6;

test('the rests of agents with long transcripts leave the main heap with their few kept lines, not the transcripts', async () => {
  test.setTimeout(240_000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-bg-heap-'));
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(dir, { recursive: true });
  const T0 = Date.UTC(2026, 9, 17, 2, 0, 0);
  const at = (ms: number) => new Date(ms).toISOString();
  const started = (id: string) => JSON.stringify({ type: 'user', timestamp: at(T0 + 1000), message: { content: [{ type: 'tool_result', tool_use_id: 'u' }] }, toolUseResult: { backgroundTaskId: id } });
  const filler = `${JSON.stringify({ type: 'assistant', timestamp: at(T0 + 500), message: { content: [{ type: 'text', text: 'réponse '.repeat(400) }] } })}\n`;
  const agents = ['a', 'b', 'c', 'd'].map((n, i) => {
    const project = path.join(home, 'projects', n);
    fs.mkdirSync(project, { recursive: true });
    const sessionId = `0941a7e6-7262-4068-ba83-68b7e0de18${String(i).padStart(2, '0')}`;
    return { id: `bg-${n}`, name: `bg-${n}`, character: 'robot', provider: 'claude', status: 'idle', role: 'worker', projectPath: project, skills: [], currentSessionId: sessionId, createdAt: at(T0), lastActivity: at(T0), file: '' };
  });
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(agents.map(({ file: _f, ...a }) => a), null, 2));
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(agents.map((a) => a.projectPath)));
  fs.writeFileSync(path.join(dir, 'hermes-connection.json'), JSON.stringify({ mode: 'local', localPort: 9, authMode: 'token' }));
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ autoStartAgentsOnLaunch: false, ollamaBaseUrl: 'http://127.0.0.1:9' }));
  const values: Record<string, unknown> = {};

  const app = await launchSandboxed(electron, home, {
    env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(31426), DOROTHY_E2E: '1' },
  });
  try {
    await app.firstWindow();
    // Each transcript where Tars itself looks for it (resume-session.ts transcriptPath): the sandbox's temp folder
    // holds characters a path spelled here by hand would encode otherwise.
    for (const [i, a] of agents.entries()) {
      a.file = await app.evaluate(({ app: electronApp }, { projectPath, sessionId, home }) => {
        const main = (process as unknown as { mainModule: NodeJS.Module }).mainModule;
        const rs = main.require(`${electronApp.getAppPath()}/electron/dist/utils/resume-session`) as { transcriptPath(p: string, s: string, h: string): string };
        return rs.transcriptPath(projectPath, sessionId, home);
      }, { projectPath: a.projectPath, sessionId: a.currentSessionId, home });
      fs.mkdirSync(path.dirname(a.file), { recursive: true });
      const fd = fs.openSync(a.file, 'w');
      const per = Math.floor((40 * MB) / filler.length / 4);
      const n = ['a', 'b', 'c', 'd'][i];
      for (const k of [1, 2, 3]) {
        fs.writeSync(fd, filler.repeat(per));
        fs.writeSync(fd, `${started(`${n}${k}`)}\n`);
      }
      fs.writeSync(fd, filler.repeat(per));
      fs.closeSync(fd);
    }
    values.transcriptsMB = agents.reduce((n, a) => n + fs.statSync(a.file).size, 0) / MB;
    /** The main process's heap after two collections, in bytes. */
    const heap = () => app.evaluate(() => {
      const main = (process as unknown as { mainModule: NodeJS.Module }).mainModule;
      const v8 = main.require('v8') as typeof import('v8');
      const vm = main.require('vm') as typeof import('vm');
      v8.setFlagsFromString('--expose-gc');
      const gc = vm.runInNewContext('gc') as () => void;
      gc();
      gc();
      return process.memoryUsage().heapUsed;
    });
    /** A rest of one agent: what the main process's own reader answers. */
    const rest = (agent: { currentSessionId: string; projectPath: string }, home: string) => app.evaluate(({ app: electronApp }, { agent, home, since }) => {
      const main = (process as unknown as { mainModule: NodeJS.Module }).mainModule;
      const truth = main.require(`${electronApp.getAppPath()}/electron/dist/services/agent-truth`) as { pendingBackgroundWork(a: unknown, since: number, home: string): string[] };
      return truth.pendingBackgroundWork(agent, since, home);
    }, { agent, home, since: T0 });

    const before = await heap();
    const answers: string[][] = [];
    for (const round of [1, 2, 3]) {
      for (const a of agents) {
        answers.push(await rest({ currentSessionId: a.currentSessionId, projectPath: a.projectPath }, home));
        // Between two rests the agent worked: a few lines appended.
        if (round < 3) fs.appendFileSync(a.file, filler.repeat(5));
      }
    }
    const after = await heap();
    values.heapBeforeMB = before / MB;
    values.heapAfterMB = after / MB;
    values.retainedMB = (after - before) / MB;
    values.answers = answers.slice(0, 4);
    recordValues(values);
    for (const [i, a] of answers.entries()) expect(a.length, `rest ${i}`).toBe(3);
    expect(after - before, `${((after - before) / MB).toFixed(1)} MB of heap kept for ${(values.transcriptsMB as number).toFixed(0)} MB of transcripts`).toBeLessThan(20 * MB);
  } finally {
    await app.close();
    await removeHome(home);
  }
});
