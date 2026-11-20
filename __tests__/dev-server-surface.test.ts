import './setup/home-guard';
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GET } from '../src/app/api/claude/sessions/[projectId]/[sessionId]/route';

/**
 * What `next dev` serves, and to whom.
 *
 * The packaged app has no API routes: electron:build moves src/app/api aside
 * before the static export. Under `next dev` they were live, and on every
 * interface: /api/agents spawned claude from an HTTP request, /api/skills ran a
 * shell command, /api/claude listed every project and session, and the session
 * reader followed an encoded `../` out of ~/.claude/projects. Measured on main
 * ec5c00b through 192.168.1.100: three files outside that folder, one of them
 * outside ~/.claude, served as a session.
 *
 * What is left is the one reader the Projects page calls, guarded, on the
 * loopback. The requests below reach it as Next hands them over, with `%2F`
 * already decoded to `/`.
 */

const SESSION = '11111111-2222-4333-8444-555555555555';
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function line(type: string, uuid: string, content: string) {
  return JSON.stringify({ type, uuid, timestamp: '2026-09-23T10:00:00.000Z', message: { role: type, content } }) + '\n';
}

function put(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function read(projectId: string, sessionId: string) {
  const res = await GET(new Request('http://127.0.0.1/'), { params: Promise.resolve({ projectId, sessionId }) });
  return { status: res.status, body: await res.json() };
}

describe('the session reader', () => {
  // The HOME of this file is a throwaway one (__tests__/setup/home-isolation.ts),
  // set before the route computed its folder from it.
  const home = os.homedir();
  const claude = path.join(home, '.claude');
  const projects = path.join(claude, 'projects');

  beforeAll(() => {
    put(path.join(projects, '-tmp-demo', `${SESSION}.jsonl`), line('user', 'u1', 'hello from the demo session') + line('assistant', 'a1', 'the demo reply'));
    put(path.join(projects, '-tmp-demo', `agent-${OTHER}.jsonl`), line('user', 's1', 'SECRET a name that holds a uuid but is not one'));
    put(path.join(projects, '-tmp-demo', 'nested', `${OTHER}.jsonl`), line('user', 's2', 'SECRET one folder too deep'));
    put(path.join(claude, `${OTHER}.jsonl`), line('user', 's3', 'SECRET beside projects'));
    put(path.join(claude, 'secret.jsonl'), line('user', 's4', 'SECRET beside projects, not a uuid'));
    put(path.join(claude, 'projects-evil', `${OTHER}.jsonl`), line('user', 's5', 'SECRET in a sibling folder with the same prefix'));
    put(path.join(home, 'outside', `${OTHER}.jsonl`), line('user', 's6', 'SECRET outside .claude'));
  });

  it('runs in a throwaway home, so what it reads is what it seeded', () => {
    expect(home).not.toBe(os.userInfo().homedir);
    expect(fs.existsSync(path.join(projects, '-tmp-demo', `${SESSION}.jsonl`))).toBe(true);
  });

  it('reads a session: a uuid, in a folder directly under ~/.claude/projects', async () => {
    const { status, body } = await read('-tmp-demo', SESSION);
    expect(status).toBe(200);
    expect(body).toMatchObject([
      { uuid: 'u1', type: 'user', content: 'hello from the demo session' },
      { uuid: 'a1', type: 'assistant', content: 'the demo reply' },
    ]);
  });

  it('reads a session that does not exist as empty', async () => {
    expect(await read('-tmp-demo', '99999999-2222-4333-8444-555555555555')).toEqual({ status: 200, body: [] });
  });

  // Every file below exists and holds a line the reader would return, so empty
  // is the guard refusing, not a missing file. The first five leave
  // ~/.claude/projects; the last two stay inside it and hold the reader to what
  // it takes, a uuid session in a folder directly under projects.
  it.each([
    ['a session id that climbs to ~/.claude', '-tmp-demo', '../../secret'],
    ['a project that is ~/.claude itself', './..', OTHER],
    ['a project that climbs out of ~/.claude', '../../outside', OTHER],
    ['a project given as an absolute path', path.join(home, 'outside'), OTHER],
    ['a sibling folder whose name starts like projects', '../projects-evil', OTHER],
    ['a project folder one level too deep', '-tmp-demo/nested', OTHER],
    ['a file in a project whose name holds a uuid but is not one', '-tmp-demo', `agent-${OTHER}`],
  ])('refuses %s', async (_what, projectId, sessionId) => {
    const { status, body } = await read(projectId, sessionId);
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });
});

describe('the routes next dev serves', () => {
  const app = path.join(__dirname, '..', 'src', 'app');

  it('is the session reader and no other route handler', () => {
    // Anywhere under src/app, not only api/: a route.ts is a route wherever it sits.
    // The names come back with the platform's separator, `\` on Windows.
    const routes = (fs.readdirSync(app, { recursive: true }) as string[])
      .filter(file => /(^|[\\/])route\.(ts|tsx|js|mjs)$/.test(file))
      .sort();
    expect(routes).toEqual([path.join('api', 'claude', 'sessions', '[projectId]', '[sessionId]', 'route.ts')]);
  });
});

describe('the address the dev server listens on', () => {
  const scripts: Record<string, string> = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')).scripts;
  const starts = Object.entries(scripts).filter(([, command]) => /\bnext dev\b/.test(command));

  it('finds the scripts that start it, so an empty list cannot pass for a clean one', () => {
    expect(starts.map(([name]) => name)).toContain('dev');
  });

  it('is the loopback, in every script that starts it', () => {
    for (const [name, command] of starts) {
      expect(command, name).toMatch(/\bnext dev\b[^&|;]*(?:-H|--hostname)[ =]127\.0\.0\.1(?![\d.])/);
    }
  });
});
