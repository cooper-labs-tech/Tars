'use client';

import { useEffect, useMemo, useRef, useState, useCallback, useLayoutEffect } from 'react';
import { AlertCircle } from 'lucide-react';
import { isAbsolutePath, pathName, rendererPlatform, tildePath, toSlashes } from '@/lib/display-path';
import { BOX_H, BOX_W, fitZoom, keepAnchor, layoutRings, ringOrder, stageBox, zoomBounds } from '@/lib/graph-layout';
import type { Point, StageBox } from '@/lib/graph-layout';
import { providerWord } from '@/lib/providers';
import type { AgentStatus, ProjectMemory } from '@/types/electron';
import { SimpleMarkdown } from '@/components/VaultView/components/MarkdownRenderer';
import { BrandSpinner, Button, Panel, PanelCaption, StatusSquare } from '@/components/ui';
import type { StatusTone } from '@/components/ui';
import { readClaudeData } from '@/hooks/useClaude';

// ── Node / edge types ─────────────────────────────────────────────────────────

type NodeKind = 'project' | 'agent' | 'skill' | 'memory' | 'instructions' | 'plugin' | 'mcp';

interface NodeMeta {
  filePath?: string;     // for memory / instructions
  skillPath?: string;    // for skill nodes - path on disk
  description?: string;  // for plugins / skills
  command?: string;      // for mcp nodes
  args?: string;         // for mcp nodes
  editable?: boolean;    // whether the panel allows editing
  files?: Array<{ name: string; path: string; isEntrypoint?: boolean }>; // for projects - their memory files
}

interface GraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  /** Mono second line inside the box - `3 memory files`, `mcp server`, a model name. */
  sub?: string;
  tone?: StatusTone;
  meta?: NodeMeta;
}

interface GraphEdge {
  source: string;
  target: string;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ── Static diagram geometry ───────────────────────────────────────────────────
//
// The graph used to be a force simulation drawn on a canvas: coloured glowing
// circles that moved for a second every time anything changed. It is a box
// diagram now - the same nodes and the same edges, but placed once, in rings
// around the project, so the picture is the same every time you open it.
// Where each box goes, and how much of the graph the canvas shows, is
// src/lib/graph-layout.ts.

/** A zoom button's step: a quarter more or less, so a graph fitted at 10 % is as quick to read as one at 50 %. */
const ZOOM_STEP = 1.25;

/** The ring of each kind of node, from the middle out. */
const RING_OF: Record<NodeKind, number> = {
  project: 0,
  agent: 1,
  memory: 2,
  instructions: 2,
  skill: 3,
  plugin: 3,
  mcp: 3,
};

/** The mono sub-line for everything that is not an agent or a project. */
const KIND_SUB: Record<NodeKind, string> = {
  project: '',
  agent: '',
  skill: 'skill',
  memory: 'memory file',
  instructions: 'instructions',
  plugin: 'plugin',
  mcp: 'mcp server',
};

function agentTone(status: AgentStatus['status']): StatusTone {
  if (status === 'running') return 'running';
  if (status === 'waiting') return 'waiting';
  if (status === 'error') return 'error';
  return 'idle';
}

// ── Data types ────────────────────────────────────────────────────────────────

export type McpEntry = { command?: string; args?: string[] };

/**
 * The servers of ~/.claude/mcp.json from fs:read-text-file's answer, which is
 * `{ content }`, or `{ content: '', error }` for a file missing or out of the
 * allowed roots. None, quietly, for a file that is not there, cannot be read
 * or names no servers.
 */
export function globalMcpServers(result: { content?: string; error?: string } | null | undefined): Record<string, McpEntry> | undefined {
  if (!result?.content) return undefined;
  try {
    const servers = JSON.parse(result.content)?.mcpServers;
    return servers && typeof servers === 'object' ? servers : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A file the panel opens, from memory:read-file or fs:read-text-file's answer: `{ content }`, or `{ content: '', error }`
 * for a file Tars does not read (a FIFO, a link, past 1 MiB, missing, out of the allowed roots). Refused, it is no
 * draft: save would write the empty text over the real file (the Audit's finding on PR 565). The refusal is main's
 * own words; no answer at all is no file read either.
 */
export function openedFile(result: { content?: string; error?: string } | null | undefined): { content: string; refused: string | null } {
  if (!result) return { content: '', refused: 'The file was not read.' };
  if (result.error) return { content: '', refused: result.error };
  return { content: result.content ?? '', refused: null };
}

type ClaudeDataType = {
  plugins: Array<{ name?: string; displayName?: string; enabled?: boolean }>;
  skills: Array<{ name: string; source: string; path: string; description?: string }>;
  settings?: unknown;
  mcpServers?: Record<string, McpEntry>;
  projectMcpServers?: Record<string, McpEntry & { projectPaths: string[] }>;
};

// { filePath > agentId[] | 'global' }
type InstructionFiles = Record<string, string[] | 'global'>;

// ── Build graph ───────────────────────────────────────────────────────────────

const normalPath = (p: string) => (p ? toSlashes(p).replace(/\/$/, '').toLowerCase() : p);

/** The memory folder that belongs to a project path, matched loosely by tail. */
function findMemory(memories: ProjectMemory[], projectPath: string) {
  const wanted = normalPath(projectPath ?? '');
  if (!wanted) return undefined;
  return memories.find(m =>
    normalPath(m.projectPath) === wanted ||
    normalPath(m.projectPath).endsWith('/' + wanted.split('/').pop())
  );
}

function buildGraph(
  agents: AgentStatus[],
  claudeData: ClaudeDataType | null,
  memories: ProjectMemory[],
  instructions: InstructionFiles,
  selectedAgentId: string | null,
): GraphData {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const added = new Set<string>();
  const edgeSet = new Set<string>();

  const addNode = (node: GraphNode) => {
    if (added.has(node.id)) return;
    added.add(node.id);
    nodes.push(node);
  };

  const addEdge = (source: string, target: string) => {
    const key = `${source}>${target}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    edges.push({ source, target });
  };

  const relevantAgents = selectedAgentId
    ? agents.filter(a => a.id === selectedAgentId)
    : agents;

  // ── Project nodes (the middle of the diagram) ──
  // A project's memory files are its one box (JeanBrasse, 18/10): one box per
  // file made 997 boxes of fifty agents' memory, the graph a sixth of 1 %
  // readable. A click on the project lists them, and each opens from there.
  for (const projectPath of [...new Set(relevantAgents.map(a => a.projectPath).filter(Boolean))]) {
    const memory = findMemory(memories, projectPath);
    const files = memory?.hasMemory ? memory.files ?? [] : [];
    addNode({
      id: `project:${projectPath}`,
      label: memory?.projectName || pathName(projectPath) || projectPath,
      kind: 'project',
      sub: memoryFiles(files.length),
      meta: { files: files.map(f => ({ name: f.name, path: f.path, isEntrypoint: f.isEntrypoint })) },
    });
  }

  // ── Agent nodes ──
  relevantAgents.forEach(agent => {
    addNode({
      id: agent.id,
      label: agent.name || `Agent ${agent.id.slice(0, 6)}`,
      kind: 'agent',
      sub: agent.model || agent.localModel || providerWord(agent.provider),
      tone: agentTone(agent.status),
    });

    if (agent.projectPath) addEdge(`project:${agent.projectPath}`, agent.id);

    // ── Agent skills ──
    for (const skillName of agent.skills ?? []) {
      const skillId = `skill:${skillName}`;
      if (!added.has(skillId)) {
        const skillMeta = claudeData?.skills?.find(s => s.name === skillName);
        addNode({
          id: skillId, label: skillName, kind: 'skill', sub: KIND_SUB.skill,
          meta: { skillPath: skillMeta?.path, description: skillMeta?.description },
        });
      }
      addEdge(agent.id, skillId);
    }

  });

  // ── Instruction files (CLAUDE.md) ──
  // Show a clean ~/-prefixed path as label
  const toShortPath = (fp: string) => tildePath(fp);

  for (const [filePath, scope] of Object.entries(instructions)) {
    const label = toShortPath(filePath);
    const instrId = `instr:${filePath}`;
    const connectTo = scope === 'global' ? relevantAgents.map(a => a.id) : (scope as string[]);

    if (!added.has(instrId)) {
      addNode({
        id: instrId, label, kind: 'instructions', sub: KIND_SUB.instructions,
        meta: { filePath, editable: true },
      });
    }
    for (const agentId of connectTo) {
      if (relevantAgents.some(a => a.id === agentId)) addEdge(agentId, instrId);
    }
  }

  // ── Global plugins (connect to all agents) ──
  if (claudeData?.plugins?.length) {
    for (const plugin of claudeData.plugins.slice(0, 15)) {
      const p = plugin as { name?: string; displayName?: string };
      const name = (p.name ?? p.displayName ?? 'plugin').toString();
      const pluginId = `plugin:${name}`;
      if (!added.has(pluginId)) {
        const pFull = plugin as { name?: string; displayName?: string; description?: string };
        addNode({
          id: pluginId, label: name, kind: 'plugin', sub: KIND_SUB.plugin,
          meta: { description: pFull.description ?? '' },
        });
      }
      for (const agent of relevantAgents) {
        addEdge(agent.id, pluginId);
      }
    }
  }

  // ── MCP servers from ~/.claude/mcp.json (global - connect to all agents) ──
  const mcpServers = claudeData?.mcpServers;
  if (mcpServers) {
    for (const [mcpName, mcpCfg] of Object.entries(mcpServers).slice(0, 20)) {
      const mcpId = `mcp:${mcpName}`;
      if (!added.has(mcpId)) {
        addNode({
          id: mcpId, label: mcpName, kind: 'mcp', sub: KIND_SUB.mcp,
          meta: {
            command: mcpCfg?.command ?? '',
            args: mcpCfg?.args ? JSON.stringify(mcpCfg.args) : '',
          },
        });
      }
      for (const agent of relevantAgents) {
        addEdge(agent.id, mcpId);
      }
    }
  }

  // ── Per-project MCP servers (only for agents whose project has that MCP) ──
  const projectMcpServers = claudeData?.projectMcpServers;
  if (projectMcpServers) {
    for (const [mcpName, entry] of Object.entries(projectMcpServers).slice(0, 30)) {
      for (const agent of relevantAgents) {
        const hasAccess = entry.projectPaths.some(p => agent.projectPath === p);
        if (!hasAccess) continue;
        const mcpId = `mcp:${mcpName}`;
        if (!added.has(mcpId)) {
          addNode({
            id: mcpId, label: mcpName, kind: 'mcp', sub: KIND_SUB.mcp,
            meta: { command: entry.command ?? '', args: entry.args ? JSON.stringify(entry.args) : '' },
          });
        }
        addEdge(agent.id, mcpId);
      }
    }
  }

  return { nodes, edges };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function AgentKnowledgeGraph() {
  const claudeDataRef    = useRef<ClaudeDataType | null>(null);
  const memoriesRef      = useRef<ProjectMemory[]>([]);
  const instructionsRef  = useRef<InstructionFiles>({});

  const [loading, setLoading] = useState(true);
  const [graphBuilding, setGraphBuilding] = useState(false);
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphData>({ nodes: [], edges: [] });

  /**
   * Map zoom.
   *
   * The map is laid out at a pixel size that follows its number of boxes,
   * inside a plain scroll container, the canvas. Scaling the stage keeps the
   * layout maths in unscaled pixels, so hit targets, edges and text stay in
   * register at every step. It opens fitted to the canvas, and fits again
   * when the canvas is resized and when the graph is rebuilt (an agent picked,
   * Refresh), and from the fit button.
   */
  const [zoom, setZoom] = useState(1);
  const stageRef = useRef<HTMLDivElement>(null);
  /** The canvas's size, scrollbars included: what the graph is fitted to. */
  const [view, setView] = useState({ width: 0, height: 0 });
  /** A drag of the canvas under way: where it started, and the scroll it started from. */
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // ── Side panel state ──

  const [panelNode, setPanelNode] = useState<GraphNode | null>(null);
  /** The project whose memory files the panel lists, or whose file it shows: its way back to the list. */
  const [panelProject, setPanelProject] = useState<GraphNode | null>(null);
  const [panelContent, setPanelContent] = useState('');
  const [panelDraft, setPanelDraft] = useState('');
  // Why the file opened is not read (openedFile): then it is no draft, and nothing is saved over it.
  const [panelRefused, setPanelRefused] = useState<string | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const [panelTab, setPanelTab] = useState<'write' | 'preview'>('write');

  // ── Load all data ──
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [agentList, claudeData, memResult, mcpResult] = await Promise.all([
        window.electronAPI?.agent.list().catch(() => []) ?? [],
        readClaudeData().catch(() => null),
        window.electronAPI?.memory?.listProjects().catch(() => ({ projects: [], error: null })) ?? { projects: [], error: null },
        window.electronAPI?.fs?.readTextFile('~/.claude/mcp.json').catch(() => null) ?? null,
      ]);

      const typedAgents = agentList as AgentStatus[];
      const typedClaude = claudeData as ClaudeDataType | null;
      const memories = (memResult as { projects: ProjectMemory[] })?.projects ?? [];

      const mcpServers = globalMcpServers(mcpResult);

      // enrichedClaude is built later after project MCPs are loaded
      // (placeholder - filled in after CLAUDE.md/MCP discovery below)
      claudeDataRef.current = null; // reset; will be set after discovery
      memoriesRef.current = memories;

      // ── Discover CLAUDE.md instruction files ──
      const typedAgentsCast = typedAgents as AgentStatus[];
      const uniqueProjectPaths = [...new Set(typedAgentsCast.map(a => a.projectPath).filter(Boolean))];

      // Only include the CLAUDE.md files that are actually loaded per agent:
      // - ~/.claude/CLAUDE.md  (global Claude config)
      // - ~/.tars/CLAUDE.md    (global Tars config)
      // - {projectPath}/CLAUDE.md and {projectPath}/.claude/CLAUDE.md per agent
      const homeFiles = await window.electronAPI?.fs?.readProjectFiles({
        paths: uniqueProjectPaths,
        relative: ['CLAUDE.md', '.claude/CLAUDE.md'],
      }).catch(() => null);
      const claudeMdResult = { output: Object.keys(homeFiles?.files ?? {}).join('\n') };
      const instrFiles: InstructionFiles = {};
      // shell:exec via PTY may include \r and ANSI codes - strip them
      const rawOutput = (claudeMdResult as { output?: string; error?: string } | null)?.output
        ?? (claudeMdResult as { output?: string; error?: string } | null)?.error
        ?? '';
       
      const cleanOutput = rawOutput.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
      const foundPaths = cleanOutput.split('\n').map(l => l.trim()).filter(l => isAbsolutePath(l, rendererPlatform()));
      for (const fp of foundPaths) {
        // A Windows path is read with / as its separator, as a posix one is.
        const slashed = toSlashes(fp);
        // Global: ~/.claude/ or Tars's data folder, ~/.tars/. ~/.dorothy/ too, its name until 2.0.4: the link
        // 2.0.4 leaves there still reaches the folder, so a path read from an older setting can name it.
        const isGlobal = (slashed.includes('/.claude/') && !slashed.includes('/.claude/projects/'))
          || slashed.includes('/.tars/') || slashed.includes('/.dorothy/');
        if (isGlobal) {
          instrFiles[fp] = 'global';
        } else {
          // Project-specific: match to agents whose projectPath contains this file
          const matchingIds = typedAgentsCast
            .filter(a => a.projectPath && slashed.startsWith(toSlashes(a.projectPath) + '/'))
            .map(a => a.id);
          instrFiles[fp] = matchingIds.length > 0 ? matchingIds : 'global';
        }
      }
      instructionsRef.current = instrFiles;

      // ── Load per-project MCP servers (.mcp.json / .claude/mcp.json) ──
      const mcpFiles = await window.electronAPI?.fs?.readProjectFiles({
        paths: uniqueProjectPaths,
        relative: ['.mcp.json', '.claude/mcp.json'],
      }).catch(() => null);
      const projectMcpResults = await Promise.all(
        uniqueProjectPaths.map(async p => {
          const found = Object.entries(mcpFiles?.files ?? {}).find(([k]) => toSlashes(k).startsWith(toSlashes(p) + '/'));
          const output = (found?.[1] ?? '').replace(/\r/g, '').trim();

          if (!output) return null;
          try {
            const parsed = JSON.parse(output);
            const servers = parsed?.mcpServers ?? parsed;
            return { projectPath: p, servers };
          } catch { return null; }
        }),
      );
      const projectMcpServers: Record<string, McpEntry & { projectPaths: string[] }> = {};
      for (const result of projectMcpResults) {
        if (!result) continue;
        for (const [name, cfg] of Object.entries(result.servers ?? {})) {
          const c = cfg as McpEntry;
          if (!projectMcpServers[name]) {
            projectMcpServers[name] = { command: c.command, args: c.args, projectPaths: [] };
          }
          projectMcpServers[name].projectPaths.push(result.projectPath);
        }
      }

      // Build final enriched claude data including project MCPs
      const enrichedClaude: ClaudeDataType | null = typedClaude
        ? { ...typedClaude, mcpServers, projectMcpServers }
        : (mcpServers || Object.keys(projectMcpServers).length > 0)
          ? { plugins: [], skills: [], mcpServers, projectMcpServers }
          : null;
      claudeDataRef.current = enrichedClaude;

      setAgents(typedAgents);

      // The whole project, not one agent: the diagram is about what the agents
      // share. Clicking an agent box still isolates it (and clicking it again
      // brings the others back) - that is what the filter pills used to do.
      setSelectedAgentId(null);

      setGraph(buildGraph(typedAgents, enrichedClaude, memories, instrFiles, null));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Rebuild when agent filter changes
  useEffect(() => {
    if (loading) return;
    setGraphBuilding(true);
    setGraph(buildGraph(
      agents,
      claudeDataRef.current,
      memoriesRef.current,
      instructionsRef.current,
      selectedAgentId,
    ));
    // Brief delay so the spinner is visible before the new graph renders
    const timer = setTimeout(() => setGraphBuilding(false), 300);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgentId, agents]);

  const layout = useMemo(() => layoutRings(ringOrder(
    graph.nodes.map(n => ({ id: n.id, ring: RING_OF[n.kind], label: n.label })),
    graph.edges,
  )), [graph]);

  const openPanel = useCallback(async (node: GraphNode) => {
    setPanelNode(node);
    setPanelLoading(true);
    setPanelTab('preview');
    setPanelRefused(null);
    try {
      let content = '';
      if (node.kind === 'memory' && node.meta?.filePath) {
        const opened = openedFile(await window.electronAPI?.memory?.readFile(node.meta.filePath));
        content = opened.content;
        setPanelRefused(opened.refused);
      } else if (node.kind === 'instructions' && node.meta?.filePath) {
        const fp = node.meta.filePath.replace(/^~/, '');
        const opened = openedFile(await window.electronAPI?.fs?.readTextFile(fp));
        content = opened.content;
        setPanelRefused(opened.refused);
      } else if (node.kind === 'skill' && node.meta?.skillPath) {
        const p = node.meta.skillPath;
        const docs = await window.electronAPI?.fs?.readProjectFiles({
          paths: [p], relative: ['AGENTS.md', 'SKILL.md', 'skills/SKILL.md', 'README.md'],
        }).catch(() => null);
        content = Object.values(docs?.files ?? {})[0] ?? '_No documentation found._';
        setPanelTab('preview');
      } else if (node.kind === 'plugin') {
        content = node.meta?.description
          ? `# ${node.label}\n\n${node.meta.description}`
          : `# ${node.label}\n\n_No description available._`;
        setPanelTab('preview');
      } else if (node.kind === 'mcp') {
        const cmd = node.meta?.command ?? '';
        const args = node.meta?.args ?? '';
        content = `# ${node.label}\n\n**Command:** \`${cmd}\`\n\n**Args:** \`${args || 'none'}\``;
        setPanelTab('preview');
      }
      setPanelContent(content);
      setPanelDraft(content);
    } finally {
      setPanelLoading(false);
    }
  }, []);

  const savePanel = useCallback(async () => {
    if (!panelNode?.meta?.filePath || panelRefused) return;
    const fp = panelNode.meta.filePath;
    if (panelNode.kind === 'memory') {
      await window.electronAPI?.memory?.writeFile(fp, panelDraft);
    } else {
      // For instruction files outside ~/.claude/projects/
      await window.electronAPI?.fs?.writeTextFile({ filePath: fp, content: panelDraft });
    }
    setPanelContent(panelDraft);
  }, [panelNode, panelDraft, panelRefused]);

  const handleNodeClick = useCallback((node: GraphNode) => {
    if (node.kind === 'agent') {
      setSelectedAgentId(prev => (prev === node.id ? null : node.id));
    } else if (node.kind === 'project') {
      setPanelProject(node);
      setPanelNode(node);
    } else {
      setPanelProject(null);
      openPanel(node);
    }
  }, [openPanel]);

  /** A memory file of the project listed, opened in the panel as a file box opened before 2.0.4. */
  const openMemoryFile = useCallback((file: { name: string; path: string }) => {
    openPanel({ id: `mem:${file.path}`, label: file.name, kind: 'memory', sub: KIND_SUB.memory, meta: { filePath: file.path, editable: true } });
  }, [openPanel]);

  // The canvas's size, before the first paint and whenever it changes: the
  // window resized, the sidebar folded, a card opened at another height.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    // Its outer size: scrollbars that take room (Windows, Linux, macOS set to
    // show them) come and go with the zoom, and a size read inside them would
    // fit the graph again each time they did, undoing every zoom in.
    const measure = () => setView(v => (v.width === el.offsetWidth && v.height === el.offsetHeight ? v : { width: el.offsetWidth, height: el.offsetHeight }));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el, { box: 'border-box' });
    return () => observer.disconnect();
  }, []);

  /** The zoom at which the whole graph fits the canvas, never above 100 %; null while the canvas has no room. */
  const fit = useMemo(() => fitZoom(layout, view), [layout, view]);
  const range = zoomBounds(fit);
  const clamp = useCallback((z: number) => Math.min(range.max, Math.max(range.min, z)), [range.max, range.min]);
  const box = useMemo(() => stageBox(layout, view, zoom), [layout, view, zoom]);

  /**
   * A zoom about a point of the canvas: the graph's point under it stays
   * there, at the pointer for a wheel or a pinch, at the middle for the
   * buttons. The scroll that keeps it is set once the new scale is laid out.
   */
  const pendingAnchor = useRef<{ anchor: Point; scroll: { left: number; top: number }; from: { zoom: number; box: StageBox } } | null>(null);

  // Open on a map that fits, and fit again when the canvas or the graph
  // changes: fifty agents and their files are seen whole first, then zoomed
  // into, not landed in the middle of.
  useLayoutEffect(() => {
    if (fit === null) return;
    pendingAnchor.current = null;
    setZoom(fit);
  }, [fit, layout]);

  const zoomAbout = useCallback((next: number, anchor?: Point) => {
    const el = stageRef.current;
    const target = clamp(next);
    if (!el || target === zoom) return;
    pendingAnchor.current = {
      anchor: anchor ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 },
      scroll: { left: el.scrollLeft, top: el.scrollTop },
      from: { zoom, box },
    };
    setZoom(target);
  }, [box, clamp, zoom]);

  useLayoutEffect(() => {
    const pending = pendingAnchor.current;
    pendingAnchor.current = null;
    const el = stageRef.current;
    if (!pending || !el) return;
    // The scroll's ends are the canvas's own, inside any scrollbar.
    const next = keepAnchor(pending.anchor, pending.scroll, { width: el.clientWidth, height: el.clientHeight }, pending.from, { zoom, box });
    el.scrollLeft = next.left;
    el.scrollTop = next.top;
  }, [zoom, box]);

  // Ctrl/Cmd + wheel is the zoom gesture everywhere else, including the pinch
  // a trackpad reports. Without the listener the browser zooms the whole app.
  // Bound by hand: React's own wheel listener is passive and cannot stop it.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAbout(zoom * (e.deltaY > 0 ? 0.92 : 1.08), { x: e.clientX - rect.left, y: e.clientY - rect.top });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoom, zoomAbout]);

  // A drag on the canvas, not on a box, moves the graph with the pointer.
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = stageRef.current;
    if (!el || e.button !== 0 || (e.target as Element).closest('button')) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture(e.pointerId);
    setDragging(true);
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = stageRef.current;
    if (!d || !el || e.pointerId !== d.id) return;
    el.scrollLeft = d.left - (e.clientX - d.x);
    el.scrollTop = d.top - (e.clientY - d.y);
  }, []);
  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    stageRef.current?.releasePointerCapture(e.pointerId);
    setDragging(false);
  }, []);
  // Whether the stage is larger than the canvas: only then does the canvas
  // scroll. At fit the stage is the canvas's outer size, and scrollbars that
  // take room (Windows, Linux) left by a zoom in would overflow it by their
  // own width and stay, the graph scrolled under them (the QA's L2 of #454).
  const pannable = box.width > view.width + 0.5 || box.height > view.height + 0.5;

  return (
    <Panel fill padded={false} className="relative w-full overflow-hidden">
      {/* Zoom controls. Words, not glyphs, at the 26px row height. */}
      {graph.nodes.length > 0 && (
        <div className="absolute right-2 top-2 z-20 flex items-center gap-1 border border-border bg-card p-1">
          <Button
            size="sm"
            className="font-mono w-7 justify-center"
            aria-label="Zoom out"
            disabled={zoom <= range.min}
            onClick={() => zoomAbout(zoom / ZOOM_STEP)}
          >
            &minus;
          </Button>
          <button
            type="button"
            onClick={() => zoomAbout(1)}
            title="Back to 100%"
            className="h-[26px] w-12 shrink-0 font-mono text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {Math.round(zoom * 100)}%
          </button>
          <Button
            size="sm"
            className="font-mono w-7 justify-center"
            aria-label="Zoom in"
            disabled={zoom >= range.max}
            onClick={() => zoomAbout(zoom * ZOOM_STEP)}
          >
            +
          </Button>
          <Button
            size="sm"
            className="font-mono"
            title="The whole graph in the canvas"
            disabled={fit === null}
            onClick={() => { pendingAnchor.current = null; if (fit !== null) setZoom(fit); }}
          >
            fit
          </Button>
        </div>
      )}

      {/* Diagram: a drag on it, off the boxes, moves the graph; focused, the arrow keys scroll it. */}
      <div
        ref={stageRef}
        tabIndex={0}
        role="region"
        aria-label="Agent graph"
        className={`absolute inset-0 select-none ${pannable ? 'overflow-auto' : 'overflow-hidden'} ${dragging ? 'cursor-grabbing' : pannable ? 'cursor-grab' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {graph.nodes.length === 0 && !loading ? (
          <div className="w-full h-full flex items-center justify-center">
            <p className="text-xs text-muted-foreground">No agents to map yet.</p>
          </div>
        ) : (
          <div className="relative" style={{ width: box.width, height: box.height }}>
            <div
              className="absolute origin-top-left"
              style={{ left: box.left, top: box.top, width: layout.width, height: layout.height, transform: `scale(${zoom})` }}
            >
              <svg
                width={layout.width}
                height={layout.height}
                className="absolute inset-0 pointer-events-none"
                aria-hidden
              >
                {graph.edges.map(edge => {
                  const a = layout.positions.get(edge.source);
                  const b = layout.positions.get(edge.target);
                  if (!a || !b) return null;
                  return (
                    <line
                      key={`${edge.source}>${edge.target}`}
                      x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                      stroke="var(--border-accent)"
                      strokeWidth={1}
                    />
                  );
                })}
              </svg>

              {graph.nodes.map(node => {
                const at = layout.positions.get(node.id);
                if (!at) return null;
                return (
                  <button
                    key={node.id}
                    onClick={() => handleNodeClick(node)}
                    style={{
                      left: at.x - BOX_W / 2,
                      top: at.y - BOX_H / 2,
                      width: BOX_W,
                      height: BOX_H,
                    }}
                    className={`absolute flex flex-col justify-center gap-0.5 px-2.5 text-left border transition-colors cursor-pointer ${
                      node.kind === 'project'
                        ? 'border-primary bg-accent-dim'
                        : selectedAgentId === node.id
                          ? 'border-border-accent bg-secondary'
                          : 'border-border bg-card hover:bg-secondary'
                    }`}
                  >
                    <span className="flex items-center gap-1.5 min-w-0">
                      <StatusSquare tone={node.tone ?? 'idle'} />
                      <span className="text-[12px] text-foreground truncate">{node.label}</span>
                    </span>
                    {node.sub && (
                      <span className="pl-3 text-[10px] font-mono text-muted-foreground truncate">
                        {node.sub}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Loading overlay */}
      {(loading || graphBuilding) && (
        <div className="absolute inset-0 flex items-center justify-center bg-card transition-opacity">
          <div className="flex flex-col items-center gap-2">
            <BrandSpinner size={30} label={loading ? 'Loading agent graph' : undefined} />
            {graphBuilding && !loading && (
              <span className="text-[11px] text-muted-foreground">Switching agent</span>
            )}
          </div>
        </div>
      )}

      {/* What the picture means - the legend box and its coloured dots are gone
          with the colour-coded circles they described. */}
      <div className="absolute bottom-3 left-3 text-[11px] leading-relaxed text-muted-foreground pointer-events-none">
        <p>agents share this project&apos;s memory</p>
        <p>edges = files each one has written</p>
      </div>

      {/* Side panel */}
      {panelNode && (
        <div className="absolute top-0 right-0 bottom-0 w-[360px] bg-background border-l border-border flex flex-col z-20">
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
            <span className="flex-1 text-sm font-medium text-foreground truncate">{panelNode.label}</span>
            {panelNode.meta?.editable && !panelRefused && (
              <>
                <Button
                  size="sm"
                  className="font-mono"
                  active={panelTab === 'write'}
                  onClick={() => setPanelTab('write')}
                >
                  edit
                </Button>
                <Button
                  size="sm"
                  className="font-mono"
                  active={panelTab === 'preview'}
                  onClick={() => setPanelTab('preview')}
                >
                  preview
                </Button>
              </>
            )}
            <Button size="sm" className="font-mono" onClick={() => { setPanelNode(null); setPanelProject(null); }}>
              close
            </Button>
          </div>

          {/* The way back to the project's list, on a row of its own: in the
              header it left the file's name a few letters. */}
          {panelProject && panelNode !== panelProject && (
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
              <Button size="sm" className="font-mono" onClick={() => setPanelNode(panelProject)}>
                files
              </Button>
              <span className="text-[11px] text-muted-foreground truncate">
                {`${memoryFiles(panelProject.meta?.files?.length ?? 0)} of ${panelProject.label}`}
              </span>
            </div>
          )}

          {/* Content */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {panelNode.kind === 'project' ? (
              <ProjectFiles project={panelNode} onOpen={openMemoryFile} />
            ) : panelLoading ? (
              <div className="flex items-center justify-center h-full">
                <BrandSpinner size={30} label="Loading content" />
              </div>
            ) : panelRefused ? (
              // As the Memory page says its own errors.
              <div className="m-4 p-3 bg-danger/10 border border-danger/30 text-danger text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {panelRefused}
              </div>
            ) : panelNode.meta?.editable && panelTab === 'write' ? (
              <textarea
                value={panelDraft}
                onChange={e => setPanelDraft(e.target.value)}
                className="w-full h-full bg-transparent p-4 text-sm font-mono text-foreground resize-none outline-none leading-relaxed"
                spellCheck={false}
              />
            ) : (
              <div className="p-4 text-sm text-foreground">
                <SimpleMarkdown content={panelTab === 'write' ? panelContent : panelDraft} />
              </div>
            )}
          </div>

          {/* Footer - save button for editable files */}
          {panelNode.meta?.editable && !panelRefused && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-border shrink-0">
              {panelDraft !== panelContent && (
                <span className="text-[10px] text-muted-foreground">Unsaved changes</span>
              )}
              <Button
                size="sm"
                variant="primary"
                className="ml-auto font-mono"
                onClick={savePanel}
                disabled={panelDraft === panelContent}
              >
                save
              </Button>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}

/** How many memory files a project holds, as its box and its list say it. */
function memoryFiles(count: number): string {
  return `${count} memory file${count === 1 ? '' : 's'}`;
}

/**
 * A project's memory files, listed in the side panel when its box is clicked
 * (`Brain · Agents · a project's memory files`): the entrypoint first with its
 * word under it, as the Projects tab lists them, each opening in the panel.
 */
function ProjectFiles({ project, onOpen }: { project: GraphNode; onOpen: (file: { name: string; path: string }) => void }) {
  const files = project.meta?.files ?? [];
  return (
    <div className="flex flex-col">
      <PanelCaption className="px-4 pt-3 pb-1">{memoryFiles(files.length)}</PanelCaption>
      {files.length === 0 ? (
        <p className="px-4 py-6 text-xs text-muted-foreground">No memory files yet</p>
      ) : (
        <ul aria-label={`Memory files of ${project.label}`} className="px-2 pb-2">
          {files.map(file => (
            <li key={file.path}>
              <button
                type="button"
                onClick={() => onOpen(file)}
                className="w-full text-left px-2 py-1.5 border border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              >
                <span className="block text-xs font-mono truncate">{file.name}</span>
                {file.isEntrypoint && <span className="block text-[10px] text-muted-foreground mt-0.5">entrypoint</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
