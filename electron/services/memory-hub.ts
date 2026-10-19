import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { encodeClaudeProjectDir, claudeProjectDirNames } from '../platform/claude-project-dir';
import { spellingsOf } from '../utils/resume-session';
import { probeMcpEndpoint, callMcpTool, listMcpTools, type McpEndpoint } from './mcp-http-client';
import {
  fetchHermesMemoryFiles,
  fetchHermesMemoryFile,
  HERMES_MEMORY_FILES,
  searchHermesSessions,
  fetchHermesSessionParent,
  fetchHermesMemoryState,
  appendHermesMemory,
} from './hermes-client';
import type { HermesConnection } from '../types/hermes';
import { resolvedMemorySettings } from './memory-through-hermes';

/**
 * One memory for every agent, whatever CLI it runs.
 *
 * Five sources sit behind this: the project's own memory files, the
 * observation ledger Tars keeps, the Hermes gateway's MEMORY.md/USER.md and
 * its searchable session history, and the two remote MCP backends (gbrain,
 * Honcho). Before this, only the first two existed in practice and only
 * claude-binary CLIs ever saw them.
 */

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const OBSERVATIONS_DIR = path.join(DATA_DIR, 'observations');

const MAX_SECTION_CHARS = 4000;
const MAX_OBSERVATIONS = 15;

export type MemorySourceId = 'project' | 'observations' | 'hermes' | 'gbrain' | 'honcho' | 'obsidian';

export interface MemorySettings {
  memoryGbrainEnabled?: boolean;
  memoryGbrainMcpUrl?: string;
  memoryGbrainAuthToken?: string;
  memoryHonchoEnabled?: boolean;
  memoryHonchoMcpUrl?: string;
  memoryHonchoApiKey?: string;
  /** See AppSettings: binds the workspace Honcho refuses to infer. */
  memoryHonchoWorkspaceId?: string;
  /** Absolute paths to Obsidian vaults. Already collected by Settings for the
   *  Vault page; a vault is a folder of markdown, which is what every other
   *  local source here is too. */
  obsidianVaultPaths?: string[];
}

export interface MemoryHit {
  source: MemorySourceId;
  title: string;
  content: string;
  ref?: string;
}

export interface SourceStatus {
  id: MemorySourceId;
  label: string;
  configured: boolean;
  reachable: boolean;
  detail: string;
  tools?: string[];
  /** Whose it is, so that Brain and Settings group the same way (2.0.4): on this Mac, Tars's own backend, or
   *  Hermes's memory. */
  owner?: 'mac' | 'tars' | 'hermes';
  /** How it was reached: directly, through the SSH tunnel, or over Tailscale, and the address on this Mac. */
  via?: 'direct' | 'tunnel' | 'tailscale';
  address?: string;
}

/* ── Local sources ─────────────────────────────────────── */

/**
 * The folder names Claude Code may keep a project under, its real path first:
 * Claude Code files a session under the real path, and Tars hands this the
 * path it saved, which may go through a link (QA's gate of #346). Each
 * spelling as claudeProjectDirNames names it, which drops a name that is not
 * one folder (a Windows path keeps its separators in the old spellings).
 */
function candidateProjectDirs(projectPath: string): string[] {
  return [...new Set([...spellingsOf(projectPath)].reverse().flatMap(spelling => claudeProjectDirNames(spelling)))];
}

export function projectMemoryDir(projectPath: string): string | null {
  for (const dir of candidateProjectDirs(projectPath)) {
    const candidate = path.join(CLAUDE_PROJECTS_DIR, dir, 'memory');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function readProjectMemory(projectPath: string): { file: string; content: string }[] {
  const dir = projectMemoryDir(projectPath);
  if (!dir) return [];
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .sort((a, b) => (a === 'MEMORY.md' ? -1 : b === 'MEMORY.md' ? 1 : a.localeCompare(b)))
      .map(f => ({ file: f, content: fs.readFileSync(path.join(dir, f), 'utf-8') }))
      .filter(entry => entry.content.trim());
  } catch {
    return [];
  }
}

/**
 * An Obsidian vault is a folder of markdown notes, so it is a memory source in
 * exactly the way the project's own memory directory is: read it, search it,
 * append to it. What makes it worth wiring separately is that it is the one
 * store the user also writes in by hand, which is why writes go to a dated
 * file of their own rather than into a note the user maintains.
 *
 * Vaults can be large, so the walk is bounded on both depth and count rather
 * than reading whatever is there.
 */
const OBSIDIAN_MAX_FILES = 400;
const OBSIDIAN_MAX_DEPTH = 6;

function obsidianVaults(settings: MemorySettings): string[] {
  return (settings.obsidianVaultPaths ?? [])
    .map(p => p.trim())
    .filter(p => p && path.isAbsolute(p) && fs.existsSync(p));
}

function readObsidianNotes(settings: MemorySettings): { file: string; vault: string; content: string }[] {
  const out: { file: string; vault: string; content: string }[] = [];
  for (const vault of obsidianVaults(settings)) {
    const walk = (dir: string, depth: number) => {
      if (depth > OBSIDIAN_MAX_DEPTH || out.length >= OBSIDIAN_MAX_FILES) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= OBSIDIAN_MAX_FILES) return;
        // .obsidian holds the app's own config, .trash its deleted notes.
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else if (entry.name.endsWith('.md')) {
          try {
            const content = fs.readFileSync(full, 'utf-8');
            if (content.trim()) out.push({ file: path.relative(vault, full), vault, content });
          } catch { /* unreadable note, skip it */ }
        }
      }
    };
    walk(vault, 0);
  }
  return out;
}

function writeObsidianNote(settings: MemorySettings, content: string, file?: string): { success: boolean; error?: string; path?: string } {
  const vault = obsidianVaults(settings)[0];
  if (!vault) return { success: false, error: 'No Obsidian vault is set up in Settings > Memory' };
  // Notes an agent writes are kept apart from the user's own, and never
  // outside the vault: the name is a single segment, validated, not a path.
  const name = file && /^[A-Za-z0-9 ._-]+\.md$/.test(file) ? file : 'Tars memory.md';
  try {
    const dir = path.join(vault, 'Tars');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, name);
    const previous = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8').trimEnd() : '';
    const next = previous ? `${previous}\n\n${content.trim()}\n` : `${content.trim()}\n`;
    fs.writeFileSync(target, next);
    return { success: true, path: target };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface Observation { ts: string; agentId: string; type: string; content: string }

function ledgerPathFor(projectPath: string): string {
  return path.join(OBSERVATIONS_DIR, `${projectPath.replace(/[^a-zA-Z0-9]/g, '-')}.jsonl`);
}

/** A project's observations, filed under the path it was saved by or its real path, oldest first. */
function readObservations(projectPath: string, limit: number): Observation[] {
  const all = [...new Set(spellingsOf(projectPath).map(ledgerPathFor))].flatMap(p => {
    try {
      if (!fs.existsSync(p)) return [];
      return fs.readFileSync(p, 'utf-8').trim().split('\n').slice(-limit).flatMap(line => {
        try { return [JSON.parse(line) as Observation]; } catch { return []; }
      });
    } catch {
      return [];
    }
  });
  return all.sort((a, b) => String(a.ts).localeCompare(String(b.ts))).slice(-limit);
}

/* ── Remote backends ───────────────────────────────────── */

function gbrainEndpoint(s: MemorySettings): McpEndpoint | null {
  if (!s.memoryGbrainEnabled || !s.memoryGbrainMcpUrl) return null;
  return { url: s.memoryGbrainMcpUrl, token: s.memoryGbrainAuthToken, label: 'gbrain' };
}

function honchoEndpoint(s: MemorySettings): McpEndpoint | null {
  if (!s.memoryHonchoEnabled || !s.memoryHonchoMcpUrl) return null;
  // The Brain page calls Honcho directly, without going through a CLI, so the
  // header has to be set here as well as in the MCP config the CLIs read.
  // Missing one of the two would work everywhere except one screen.
  const workspaceId = s.memoryHonchoWorkspaceId?.trim();
  return {
    url: s.memoryHonchoMcpUrl,
    token: s.memoryHonchoApiKey,
    label: 'Honcho',
    ...(workspaceId ? { headers: { 'X-Honcho-Workspace-ID': workspaceId } } : {}),
  };
}

/** The first tool whose name looks like a search over stored knowledge. */
function pickSearchTool(tools: { name: string }[]): string | null {
  const names = tools.map(t => t.name);
  const preferred = ['memory_search', 'search_memory', 'honcho_search', 'search', 'recall', 'query', 'retrieve'];
  for (const p of preferred) {
    const hit = names.find(n => n === p || n.endsWith(`_${p}`));
    if (hit) return hit;
  }
  return names.find(n => /search|recall|query|retriev/i.test(n)) ?? null;
}

/**
 * The first tool whose name looks like it stores something.
 *
 * Deliberately narrower than the search side. A wrong guess there returns an
 * odd search result; a wrong guess here writes into something. So no loose
 * regex fallback: an unrecognised server is reported as having no write tool
 * rather than having one picked for it.
 */
function pickWriteTool(tools: { name: string }[]): string | null {
  const names = tools.map(t => t.name);
  const preferred = [
    'memory_write', 'write_memory', 'memory_add', 'add_memory', 'store_memory',
    'remember', 'save_memory', 'memory_store', 'honcho_write', 'add', 'store',
  ];
  for (const p of preferred) {
    const hit = names.find(n => n === p || n.endsWith(`_${p}`));
    if (hit) return hit;
  }
  return null;
}

/** The property a tool wants the payload in, read from its own schema. */
function pickArgKey(
  tools: { name: string; inputSchema?: unknown }[],
  tool: string,
  candidates: string[],
  fallback: string,
): string {
  const schema = tools.find(t => t.name === tool)?.inputSchema as
    { properties?: Record<string, unknown> } | undefined;
  const props = Object.keys(schema?.properties ?? {});
  return props.find(p => candidates.includes(p)) ?? fallback;
}

async function searchBackend(endpoint: McpEndpoint, query: string, source: MemorySourceId): Promise<MemoryHit[]> {
  const tools = await listMcpTools(endpoint);
  const tool = pickSearchTool(tools);
  if (!tool) return [];

  const schema = tools.find(t => t.name === tool)?.inputSchema as
    { properties?: Record<string, unknown> } | undefined;
  const props = Object.keys(schema?.properties ?? {});
  const queryKey = props.find(p => ['query', 'q', 'search', 'text', 'question'].includes(p)) ?? 'query';

  const text = await callMcpTool(endpoint, tool, { [queryKey]: query });
  if (!text.trim()) return [];
  return [{ source, title: `${endpoint.label} · ${tool}`, content: text.slice(0, 4000) }];
}

/* ── Public API ────────────────────────────────────────── */

/**
 * How long a session's start waits for Hermes's memory, whoever starts it: the
 * SessionStart hook (its curl gives up after 3 s, hooks/session-start.sh) and
 * the CLIs without it, which get the block in their prompt. It was 4000 ms by
 * default and 3000 for the prompt, so a Hermes that accepts the connection and
 * never answers (the ssh tunnel up, the server silent) held the block past the
 * hook, and the agent started with no memory at all, its own project's
 * included: 4005 ms, measured by the Audit. One budget, under the hook's, with
 * no caller allowed a longer one: the project's own memory never waits on
 * Hermes.
 */
export const HERMES_START_BUDGET_MS = 1500;

/**
 * The block injected into a fresh session. Local sources are read
 * synchronously; the gateway is only consulted when a connection exists, and
 * a slow gateway must never hold up an agent starting.
 */
export async function assembleDigest(opts: {
  projectPath: string;
  settings: MemorySettings;
  hermes?: HermesConnection | null;
}): Promise<string> {
  const { projectPath, settings, hermes } = opts;
  const sections: string[] = [];

  for (const { file, content } of readProjectMemory(projectPath)) {
    const body = content.length > MAX_SECTION_CHARS
      ? `${content.slice(0, MAX_SECTION_CHARS)}\n…(truncated, read memory/${file} for the rest)`
      : content;
    sections.push(`## Project memory: ${file}\n${body.trim()}`);
  }

  const observations = readObservations(projectPath, MAX_OBSERVATIONS);
  if (observations.length > 0) {
    sections.push(
      `## Recent activity on this project (other sessions)\n` +
      observations.map(o => `- [${o.ts.slice(0, 16)}] ${o.content}`).join('\n'),
    );
  }

  if (hermes) {
    // Each file on its own, both at once, under one budget. Read one after the
    // other inside a single race, a Hermes that answered MEMORY.md and never
    // USER.md kept neither (the Audit's gate of #271). What has come back when
    // the budget runs out goes in; a gateway that is down delays nobody.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), HERMES_START_BUDGET_MS); });
    const reads = await Promise.all(HERMES_MEMORY_FILES.map(name =>
      Promise.race([fetchHermesMemoryFile(hermes, name).catch(() => null), late])));
    clearTimeout(timer);
    for (const read of reads) {
      if (!read || !read.success || !read.file) continue;
      const { name, content } = read.file;
      const body = content.length > MAX_SECTION_CHARS
        ? `${content.slice(0, MAX_SECTION_CHARS)}\n…(truncated)`
        : content;
      sections.push(`## Hermes memory: ${name}\n${body.trim()}`);
    }
  }

  const backends = [gbrainEndpoint(settings), honchoEndpoint(settings)].filter(Boolean) as McpEndpoint[];
  if (backends.length > 0) {
    sections.push(
      `## Shared memory backends\n` +
      backends.map(b => `- ${b.label} is connected: search it with the memory_search tool before assuming anything is new.`).join('\n'),
    );
  }

  return sections.join('\n\n');
}

/** How far up a hit's ancestry is read: past it, the hit is left out. */
const MAX_HERMES_ANCESTORS = 20;

/**
 * Whether a session, or any session above it, is one `hide` names, read from
 * the gateway one parent at a time up to a root. Unreadable ancestry counts as
 * hidden: a parent the gateway cannot give, a cycle, or a chain longer than
 * MAX_HERMES_ANCESTORS. The parents are read once per search, whatever the
 * number of hits that share them.
 */
function hiddenAncestry(hermes: HermesConnection, hide: (sessionId: string) => boolean): (sessionId: string) => Promise<boolean> {
  const parents = new Map<string, Promise<string | null | undefined>>();
  const parentOf = (id: string) => {
    let parent = parents.get(id);
    if (!parent) {
      parent = fetchHermesSessionParent(hermes, id).then(r => (r.success ? r.parentSessionId : undefined), () => undefined);
      parents.set(id, parent);
    }
    return parent;
  };
  return async start => {
    const seen = new Set<string>();
    for (let id: string | null = start; id; ) {
      if (hide(id)) return true;
      if (seen.has(id) || seen.size >= MAX_HERMES_ANCESTORS) return true;
      seen.add(id);
      const parent = await parentOf(id);
      if (parent === undefined) return true;
      id = parent;
    }
    return false;
  };
}

/** Federated search. Every source is optional and failures are per-source. */
export async function searchMemory(opts: {
  query: string;
  projectPath?: string;
  settings: MemorySettings;
  hermes?: HermesConnection | null;
  sources?: MemorySourceId[];
  limit?: number;
  /** Hermes sessions the caller may not see: for an agent, the super chat's. */
  hideHermesSession?: (sessionId: string | undefined) => boolean;
}): Promise<{ hits: MemoryHit[]; errors: { source: MemorySourceId; error: string }[] }> {
  const { query, projectPath, hermes } = opts;
  // A backend reached through Hermes, at the address of the moment (services/memory-through-hermes.ts).
  const { settings } = await resolvedMemorySettings(opts.settings);
  const wanted = new Set<MemorySourceId>(opts.sources ?? ['project', 'observations', 'obsidian', 'hermes', 'gbrain', 'honcho']);
  const limit = opts.limit ?? 10;
  const hits: MemoryHit[] = [];
  const errors: { source: MemorySourceId; error: string }[] = [];
  const needle = query.toLowerCase();

  if (projectPath && wanted.has('project')) {
    for (const { file, content } of readProjectMemory(projectPath)) {
      const paragraphs = content.split(/\n{2,}/).filter(p => p.toLowerCase().includes(needle));
      for (const p of paragraphs.slice(0, limit)) {
        hits.push({ source: 'project', title: `memory/${file}`, content: p.trim().slice(0, 1200), ref: file });
      }
    }
  }

  if (projectPath && wanted.has('observations')) {
    const matches = readObservations(projectPath, 500).filter(o => o.content.toLowerCase().includes(needle));
    for (const o of matches.slice(-limit).reverse()) {
      hits.push({ source: 'observations', title: `${o.type} · ${o.ts.slice(0, 16)}`, content: o.content });
    }
  }

  if (wanted.has('obsidian')) {
    for (const { file, content } of readObsidianNotes(settings)) {
      const paragraphs = content.split(/\n{2,}/).filter(p => p.toLowerCase().includes(needle));
      for (const p of paragraphs.slice(0, limit)) {
        hits.push({ source: 'obsidian', title: file, content: p.trim().slice(0, 1200), ref: file });
      }
    }
  }

  const remote: Promise<void>[] = [];

  if (hermes && wanted.has('hermes')) {
    remote.push((async () => {
      try {
        // Filtered before it is cut: asked for `limit` and filtered after, the
        // super chat's hits took an agent's places and it could get none (the
        // Audit's gate of #190). So a filtering caller asks for the gateway's
        // most, and keeps `limit` of what is left. A session Hermes compressed
        // is answered under its newest id, which was never recorded: its root
        // and its parent say whose it is.
        //
        // The gateway's lineage stops at a branch or a delegate edge, though: a
        // session branched from a segment of the super chat that was compressed
        // inside a turn, and so never recorded, has its own root and that
        // segment as parent (the Audit's gate of #225). So the parents are read
        // further up, to a root, and a hit whose ancestry reaches the super
        // chat's, or cannot be read to its end, is left out.
        const hide = opts.hideHermesSession;
        const res = await searchHermesSessions(hermes, query, hide ? 100 : limit);
        if (res.success) {
          const ancestryHidden = hide ? hiddenAncestry(hermes, hide) : undefined;
          let kept = 0;
          for (const hit of res.hits) {
            if (kept >= limit) break;
            if (hide && [hit.sessionId, hit.lineageRoot, hit.parentSessionId].some((id, i) => (i === 0 || id) && hide(id))) continue;
            if (ancestryHidden && hit.parentSessionId && await ancestryHidden(hit.parentSessionId)) continue;
            kept++;
            hits.push({
              source: 'hermes',
              title: hit.title || hit.sessionId || 'Hermes session',
              content: (hit.snippet || '').slice(0, 1200),
              ref: hit.sessionId,
            });
          }
        } else {
          errors.push({ source: 'hermes', error: res.error });
        }
      } catch (err) {
        errors.push({ source: 'hermes', error: err instanceof Error ? err.message : String(err) });
      }
    })());
  }

  for (const [id, endpoint] of [
    ['gbrain', gbrainEndpoint(settings)],
    ['honcho', honchoEndpoint(settings)],
  ] as const) {
    if (!endpoint || !wanted.has(id)) continue;
    remote.push((async () => {
      try {
        hits.push(...await searchBackend(endpoint, query, id));
      } catch (err) {
        errors.push({ source: id, error: err instanceof Error ? err.message : String(err) });
      }
    })());
  }

  await Promise.all(remote);
  return { hits, errors };
}

/** Writes a note into the project's own memory directory. */
export function writeProjectMemory(projectPath: string, content: string, file = 'MEMORY.md'): { success: boolean; error?: string; path?: string } {
  if (!/^[A-Za-z0-9._-]+\.md$/.test(file)) return { success: false, error: 'invalid memory file name' };

  let dir = projectMemoryDir(projectPath);
  if (!dir) {
    dir = path.join(CLAUDE_PROJECTS_DIR, encodeClaudeProjectDir(projectPath), 'memory');
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, file);
    const previous = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8').trimEnd() : '';
    const next = previous ? `${previous}\n\n${content.trim()}\n` : `${content.trim()}\n`;
    fs.writeFileSync(target, next);
    return { success: true, path: target };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Where a write can go. `observations` is written by hooks, never by an agent. */
export type MemoryWriteTarget = 'project' | 'hermes' | 'gbrain' | 'honcho' | 'obsidian';

export interface MemoryWriteResult {
  target: MemoryWriteTarget;
  success: boolean;
  /** Where it landed: a file path, or the tool that accepted it. */
  path?: string;
  error?: string;
}

/**
 * Record something, in one or more memories.
 *
 * Until this existed an agent could read five sources and only ever write to
 * one: `memory_write` went straight to the project's own notes, so "remember
 * this in Hermes" or "put this in gbrain" had nowhere to go and quietly landed
 * in the project file instead. Each target is attempted independently and
 * reports its own result, because "wrote to two of the three you asked for" is
 * an outcome, not an error.
 *
 * The remote backends are MCP servers Tars does not own, so the write tool is
 * discovered from what the server advertises. Discovery is stricter than on the
 * search side: a wrong guess when searching returns an odd result, a wrong
 * guess when writing puts data somewhere it does not belong.
 */
export async function writeMemory(opts: {
  content: string;
  targets: MemoryWriteTarget[];
  projectPath: string;
  settings: MemorySettings;
  hermes?: HermesConnection | null;
  file?: string;
}): Promise<MemoryWriteResult[]> {
  const { content, projectPath, hermes, file } = opts;
  const { settings } = await resolvedMemorySettings(opts.settings);
  const targets: MemoryWriteTarget[] = opts.targets.length
    ? [...new Set(opts.targets)]
    : ['project'];
  const body = content.trim();
  if (!body) return targets.map(target => ({ target, success: false, error: 'Nothing to write' }));

  return Promise.all(targets.map(async (target): Promise<MemoryWriteResult> => {
    try {
      if (target === 'project') {
        const res = writeProjectMemory(projectPath, body, file || 'MEMORY.md');
        return { target, success: res.success, path: res.path, error: res.error };
      }

      if (target === 'hermes') {
        if (!hermes) return { target, success: false, error: 'No Hermes gateway is configured' };
        const res = await appendHermesMemory(hermes, body, file || 'MEMORY.md');
        return res.success
          ? { target, success: true, path: res.path }
          : { target, success: false, error: res.error };
      }

      if (target === 'obsidian') {
        const res = writeObsidianNote(settings, body, file);
        return { target, success: res.success, path: res.path, error: res.error };
      }

      const endpoint = target === 'gbrain' ? gbrainEndpoint(settings) : honchoEndpoint(settings);
      if (!endpoint) {
        return { target, success: false, error: `${target} is not set up in Settings > Memory Backends` };
      }

      const tools = await listMcpTools(endpoint);
      const tool = pickWriteTool(tools);
      if (!tool) {
        const offered = tools.map(t => t.name).slice(0, 8).join(', ') || 'none';
        return {
          target,
          success: false,
          error: `${endpoint.label} advertises no tool that stores memory (it offers: ${offered})`,
        };
      }

      const contentKey = pickArgKey(
        tools, tool, ['content', 'text', 'memory', 'fact', 'body', 'message'], 'content',
      );
      await callMcpTool(endpoint, tool, { [contentKey]: body });
      return { target, success: true, path: `${endpoint.label} · ${tool}` };
    } catch (err) {
      return { target, success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }));
}

/** Real status for every source: reachable means we spoke to it. */
export async function memoryStatus(opts: {
  settings: MemorySettings;
  hermes?: HermesConnection | null;
  projectPath?: string;
}): Promise<SourceStatus[]> {
  const { hermes, projectPath } = opts;
  const { settings, unreached, reached } = await resolvedMemorySettings(opts.settings);
  const out: SourceStatus[] = [];

  const dir = projectPath ? projectMemoryDir(projectPath) : null;
  const files = projectPath ? readProjectMemory(projectPath) : [];
  out.push({
    id: 'project',
    label: 'Project memory',
    configured: true,
    reachable: !!dir,
    detail: dir ? `${files.length} file${files.length === 1 ? '' : 's'} in ${dir}` : 'no memory directory yet',
  });

  const observations = projectPath ? readObservations(projectPath, 500) : [];
  out.push({
    id: 'observations',
    label: 'Session observations',
    configured: true,
    reachable: observations.length > 0,
    detail: observations.length > 0
      ? `${observations.length} recorded, latest ${observations[observations.length - 1].ts.slice(0, 16)}`
      : 'nothing recorded yet',
  });

  const vaults = obsidianVaults(settings);
  const notes = vaults.length ? readObsidianNotes(settings) : [];
  out.push({
    id: 'obsidian',
    label: 'Obsidian',
    configured: vaults.length > 0,
    reachable: notes.length > 0,
    detail: vaults.length === 0
      ? 'no vault set up'
      : `${notes.length} note${notes.length === 1 ? '' : 's'} in ${vaults.length} vault${vaults.length === 1 ? '' : 's'}`,
  });

  const probes: Promise<void>[] = [];

  probes.push((async () => {
    if (!hermes) {
      out.push({ id: 'hermes', label: 'Hermes memory', configured: false, reachable: false, detail: 'no gateway configured' });
      return;
    }
    try {
      const [state, filesRes] = await Promise.all([
        fetchHermesMemoryState(hermes),
        fetchHermesMemoryFiles(hermes),
      ]);
      if (!state.success) {
        out.push({ id: 'hermes', label: 'Hermes memory', configured: true, reachable: false, detail: state.error });
        return;
      }
      const active = (state.state?.active as string) || 'built-in';
      const count = filesRes.success ? filesRes.files.length : 0;
      out.push({
        id: 'hermes',
        label: 'Hermes memory',
        configured: true,
        reachable: true,
        detail: `provider ${active}, ${count} file${count === 1 ? '' : 's'} readable`,
      });
    } catch (err) {
      out.push({
        id: 'hermes',
        label: 'Hermes memory',
        configured: true,
        reachable: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  })());

  for (const [id, label, endpoint] of [
    ['gbrain', 'gbrain', gbrainEndpoint(settings)],
    ['honcho', 'Honcho', honchoEndpoint(settings)],
  ] as const) {
    probes.push((async () => {
      if (!endpoint) {
        const why = unreached[id];
        out.push(why
          ? { id, label, configured: true, reachable: false, detail: why, owner: 'tars' }
          : { id, label, configured: false, reachable: false, detail: 'not enabled', owner: 'tars' });
        return;
      }
      const probe = await probeMcpEndpoint(endpoint);
      out.push({
        id,
        label,
        owner: 'tars',
        via: reached[id]?.via ?? 'direct',
        address: endpoint.url,
        configured: true,
        reachable: probe.reachable,
        detail: probe.reachable
          ? `${probe.tools.length} tool${probe.tools.length === 1 ? '' : 's'} available`
          : probe.error ?? 'unreachable',
        tools: probe.tools,
      });
    })());
  }

  await Promise.all(probes);
  // Whose each one is, for the three groups Brain and Settings share: this Mac, Tars's direct backends, Hermes.
  for (const source of out) source.owner ??= source.id === 'hermes' ? 'hermes' : 'mac';

  const order: MemorySourceId[] = ['project', 'observations', 'obsidian', 'hermes', 'gbrain', 'honcho'];
  return out.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

/**
 * Providers whose config dir is ~/.claude inherit Claude Code's SessionStart
 * hook, so the digest already reaches them. The others (codex, gemini, grok,
 * opencode, pi) have no such hook: for them the digest has to travel in the
 * prompt, otherwise those agents start with no memory at all.
 */
export function needsPromptInjection(providerConfigDir: string): boolean {
  return path.resolve(providerConfigDir) !== path.resolve(path.join(os.homedir(), '.claude'));
}

/** The digest wrapped so a CLI reads it as context, not as the task. */
export function wrapDigestForPrompt(digest: string): string {
  if (!digest.trim()) return '';
  return [
    '<project-memory>',
    'What this project already knows. Treat it as established fact, and search',
    'the memory tools before re-investigating anything mentioned here.',
    '',
    digest.trim(),
    '</project-memory>',
  ].join('\n');
}
