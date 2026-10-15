import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../../constants';
import { RouteApp, RouteContext } from './types';
import {
  assembleDigest,
  searchMemory,
  writeMemory,
  memoryStatus,
  type MemorySettings,
  type MemorySourceId,
  type MemoryWriteTarget,
} from '../memory-hub';
import { usableHermesConnection } from '../hermes-config';
import { isOverseerHermesSession } from '../overseer-store';

/**
 * Memory over HTTP, for agents rather than for the renderer.
 *
 * - session-start hooks GET /api/memory/context for the digest to inject.
 * - the memory MCP server (which every CLI gets, not just Claude) calls
 *   /search, /write and /context on behalf of whatever agent invoked it.
 * - post-tool-use hooks POST /remember into the observation ledger.
 */

const OBSERVATIONS_DIR = path.join(DATA_DIR, 'observations');
const LEDGER_MAX_LINES = 1000;
const LEDGER_TRIM_TO = 500;

function ledgerPathFor(projectPath: string): string {
  return path.join(OBSERVATIONS_DIR, `${projectPath.replace(/[^a-zA-Z0-9]/g, '-')}.jsonl`);
}

interface Observation {
  ts: string;
  agentId: string;
  type: string;
  content: string;
}

function memorySettings(ctx: RouteContext): MemorySettings {
  const s = ctx.getAppSettings() as unknown as MemorySettings;
  return {
    memoryGbrainEnabled: s.memoryGbrainEnabled,
    memoryGbrainMcpUrl: s.memoryGbrainMcpUrl,
    memoryGbrainAuthToken: s.memoryGbrainAuthToken,
    memoryHonchoEnabled: s.memoryHonchoEnabled,
    memoryHonchoMcpUrl: s.memoryHonchoMcpUrl,
    memoryHonchoApiKey: s.memoryHonchoApiKey,
  };
}

const VALID_SOURCES: MemorySourceId[] = ['project', 'observations', 'hermes', 'gbrain', 'honcho'];

function parseSources(raw: string | null): MemorySourceId[] | undefined {
  if (!raw) return undefined;
  const wanted = raw.split(',').map(s => s.trim()).filter(s => VALID_SOURCES.includes(s as MemorySourceId));
  return wanted.length > 0 ? (wanted as MemorySourceId[]) : undefined;
}

export function registerMemoryRoutes(app: RouteApp, ctx: RouteContext): void {
  // The block injected at session start: project memory, recent activity,
  // Hermes' own memory files, and a pointer to the connected backends.
  app.get('/api/memory/context', async (req, sendJson) => {
    const projectPath = req.url.searchParams.get('project_path') || '';
    if (!projectPath) {
      sendJson({ context: '' });
      return;
    }
    try {
      const context = await assembleDigest({
        projectPath,
        settings: memorySettings(ctx),
        hermes: usableHermesConnection(),
      });
      sendJson({ context });
    } catch (err) {
      console.error('memory/context failed:', err);
      sendJson({ context: '' });
    }
  });

  // Federated search across every configured source.
  app.get('/api/memory/search', async (req, sendJson) => {
    const query = req.url.searchParams.get('q') || '';
    if (!query.trim()) {
      sendJson({ error: 'q is required' }, 400);
      return;
    }
    // Absent, it is the default: Number(null) is 0, which is finite, and read
    // as a limit it cut every search that named none to one hit.
    const rawLimit = req.url.searchParams.get('limit');
    const limitParam = rawLimit === null || rawLimit.trim() === '' ? NaN : Number(rawLimit);
    try {
      const result = await searchMemory({
        query,
        projectPath: req.url.searchParams.get('project_path') || undefined,
        settings: memorySettings(ctx),
        hermes: usableHermesConnection(),
        sources: parseSources(req.url.searchParams.get('sources')),
        limit: Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 50) : 10,
        // An agent asks here: never the super chat's sessions, which are JeanBrasse's
        // conversation (SECURITY.md §5), nor a hit that names no session and so
        // cannot be told apart from them (the Audit's table, #13).
        hideHermesSession: id => !id || isOverseerHermesSession(id),
      });
      sendJson(result);
    } catch (err) {
      console.error('memory/search failed:', err);
      sendJson({ hits: [], errors: [{ source: 'project', error: String(err) }] });
    }
  });

  // Which sources are actually reachable: probed, not inferred from settings.
  app.get('/api/memory/status', async (req, sendJson) => {
    try {
      sendJson({
        sources: await memoryStatus({
          settings: memorySettings(ctx),
          hermes: usableHermesConnection(),
          projectPath: req.url.searchParams.get('project_path') || undefined,
        }),
      });
    } catch (err) {
      sendJson({ sources: [], error: String(err) }, 500);
    }
  });

  /**
   * An agent recording something worth keeping past this session.
   *
   * `to` chooses the memory. It used to be project-only, so an agent asked to
   * put something in Hermes or gbrain wrote it into the project file instead
   * and reported success. Each target answers for itself, and the response
   * carries `success: true` when at least one accepted the write, with the
   * per-target detail alongside, because two out of three is an outcome rather
   * than a failure.
   */
  const WRITE_TARGETS: MemoryWriteTarget[] = ['project', 'hermes', 'gbrain', 'honcho'];

  app.post('/api/memory/write', async (req, sendJson) => {
    const projectPath = typeof req.body.project_path === 'string' ? req.body.project_path : '';
    const content = typeof req.body.content === 'string' ? req.body.content : '';
    const file = typeof req.body.file === 'string' ? req.body.file : 'MEMORY.md';

    const asked = typeof req.body.to === 'string'
      ? req.body.to.split(',').map((s: string) => s.trim())
      : Array.isArray(req.body.to) ? req.body.to.map(String) : [];
    const unknown = asked.filter((t: string) => !WRITE_TARGETS.includes(t as MemoryWriteTarget));
    if (unknown.length) {
      sendJson({ success: false, error: `Unknown memory target(s): ${unknown.join(', ')}. Use one of ${WRITE_TARGETS.join(', ')}.` }, 400);
      return;
    }
    const targets = (asked.length ? asked : ['project']) as MemoryWriteTarget[];

    if (!projectPath || !content.trim()) {
      sendJson({ success: false, error: 'project_path and content are required' }, 400);
      return;
    }

    const results = await writeMemory({
      content: content.slice(0, 20_000),
      targets,
      projectPath,
      settings: memorySettings(ctx),
      hermes: usableHermesConnection(),
      file,
    });

    const written = results.filter((r: { success: boolean }) => r.success);
    sendJson({
      success: written.length > 0,
      results,
      // Kept so the older single-target callers still read a path out of this.
      path: written[0]?.path,
      error: written.length ? undefined : results.map(r => `${r.target}: ${r.error}`).join('; '),
    });
  });

  // Observation capture from post-tool-use hooks.
  app.post('/api/memory/remember', (req, sendJson) => {
    const agentId = typeof req.body.agent_id === 'string' ? req.body.agent_id : '';
    const projectPath = typeof req.body.project_path === 'string' ? req.body.project_path : '';
    const content = typeof req.body.content === 'string' ? req.body.content.slice(0, 500) : '';
    const type = typeof req.body.type === 'string' ? req.body.type.slice(0, 40) : 'observation';

    if (!projectPath || !content) {
      sendJson({ success: false, error: 'project_path and content are required' }, 400);
      return;
    }

    try {
      fs.mkdirSync(OBSERVATIONS_DIR, { recursive: true });
      const p = ledgerPathFor(projectPath);
      const record: Observation = { ts: new Date().toISOString(), agentId, type, content };
      fs.appendFileSync(p, JSON.stringify(record) + '\n');

      // Cap the ledger so years of tool uses don't accumulate unbounded
      const lines = fs.readFileSync(p, 'utf-8').trim().split('\n');
      if (lines.length > LEDGER_MAX_LINES) {
        fs.writeFileSync(p, lines.slice(-LEDGER_TRIM_TO).join('\n') + '\n');
      }

      sendJson({ success: true });
    } catch (err) {
      console.error('memory/remember failed:', err);
      sendJson({ success: false, error: String(err) }, 500);
    }
  });
}
