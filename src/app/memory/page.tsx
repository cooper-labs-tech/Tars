'use client';

import { useState, useCallback, useEffect } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle } from 'lucide-react';
import { useMemory, formatBytes, timeAgo } from '@/hooks/useMemory';
import type { ProjectMemory, MemoryFile, HermesMcpServer, HermesMemoryProvider } from '@/types/electron';
import AgentKnowledgeGraph from '@/components/Memory/AgentKnowledgeGraph';
import { useCardTitle } from '@/components/ui/CardTitle';
import { olderCopyFolder } from '@/lib/older-copy';
import {
  BrandSpinner,
  Button,
  DialogShell,
  Input,
  PageHeader,
  Panel,
  PanelCaption,
  SegmentedControl,
  StatusBadge,
  StatusSquare,
} from '@/components/ui';

type Tab = 'projects' | 'agents' | 'backends';

const TABS = [
  { value: 'projects' as const, label: 'Projects' },
  { value: 'agents' as const, label: 'Agents' },
  { value: 'backends' as const, label: 'Backends' },
];

// ─── MEMORY.md against what Claude Code reads ───────────────────────────────

type MemoryGuard = NonNullable<ProjectMemory['guard']>;

/**
 * What a project's MEMORY.md guard shows: main's own words (guard.notice, PR 558: its first 200 lines, then 24.4 KB),
 * never the window's, in the tone of its state; null well under both limits. Frame: `Brain · Projects · MEMORY.md
 * past what Claude Code reads (2.0.6) · states`.
 */
function guardNotice(guard: ProjectMemory['guard']): { state: MemoryGuard['state']; tone: 'error' | 'waiting' | 'idle'; ink: string; text: string } | null {
  if (!guard?.notice) return null;
  const tone = guard.state === 'cut' ? 'error' : guard.state === 'near' ? 'waiting' : 'idle';
  const ink = tone === 'error' ? 'text-status-error' : tone === 'waiting' ? 'text-status-waiting' : 'text-text-muted';
  return { state: guard.state, tone, ink, text: guard.notice };
}

// ─── File pane (always editable) ────────────────────────────────────────────

/**
 * The right pane. There is no view/edit toggle any more: the file is open, and
 * the three words at the top of it are everything you can do to it. Mount it
 * with `key={file.path}` - the draft lives here.
 */
function FilePane({
  file,
  saving,
  deleting,
  onSave,
  onNewFile,
  onDelete,
  guard,
}: {
  file: MemoryFile;
  saving: boolean;
  deleting: boolean;
  onSave: (content: string) => void;
  onNewFile: () => void;
  onDelete: () => void;
  /** The project's guard: its notice, whole, above the MEMORY.md it speaks of. */
  guard?: ProjectMemory['guard'];
}) {
  const [content, setContent] = useState(file.content);
  const dirty = content !== file.content;
  const notice = file.isEntrypoint ? guardNotice(guard) : null;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border shrink-0">
        <span className="font-mono text-xs text-foreground truncate">
          {file.name}
          {dirty && <span className="text-warning"> •</span>}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" className="font-mono" onClick={() => onSave(content)} disabled={!dirty || saving}>
            save
          </Button>
          <Button size="sm" className="font-mono" onClick={onNewFile}>
            new file
          </Button>
          <Button
            size="sm"
            className="font-mono"
            onClick={onDelete}
            disabled={file.isEntrypoint || deleting}
            title={file.isEntrypoint ? 'The entrypoint file cannot be deleted' : undefined}
          >
            delete
          </Button>
        </div>
      </div>
      {notice && (
        <div className="flex items-center gap-2.5 px-3 py-2 bg-secondary border-b border-border shrink-0">
          <StatusSquare tone={notice.tone} />
          <p data-memory-file-notice={notice.state} className="flex-1 min-w-0 text-[11.5px] leading-[1.45] text-foreground">{notice.text}</p>
        </div>
      )}
      <textarea
        className="flex-1 w-full resize-none bg-card font-mono text-xs leading-relaxed p-3 focus:outline-none text-foreground"
        value={content}
        onChange={e => setContent(e.target.value)}
        spellCheck={false}
      />
    </div>
  );
}

// ─── Project row ─────────────────────────────────────────────────────────────

function ProjectRow({
  project,
  isSelected,
  activeAgents,
  onClick,
}: {
  project: ProjectMemory;
  isSelected: boolean;
  activeAgents: number;
  onClick: () => void;
}) {
  const olderFolder = olderCopyFolder(project.olderCopy);
  const notice = guardNotice(project.guard);
  return (
    <button
      data-memory-row={project.projectName}
      onClick={onClick}
      className={`w-full text-left px-2 py-2 border transition-colors ${isSelected
        ? 'bg-secondary border-border-accent text-foreground'
        : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary'
        }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-medium truncate">{project.projectName}</span>
          {project.provider && project.provider !== 'claude' && (
            <span className="font-mono text-[10px] text-muted-foreground shrink-0">{project.provider}</span>
          )}
        </div>
        {activeAgents > 0 && (
          <span className="flex items-center gap-1 shrink-0 font-mono text-[10px] text-status-running">
            <StatusSquare tone="running" />
            {activeAgents}
          </span>
        )}
      </div>
      {/* The counts the stats bar used to hold, on the row they belong to. */}
      <p className="mt-1 font-mono text-[10px] text-muted-foreground truncate">
        {project.hasMemory
          ? `${project.files.length} files · ${formatBytes(project.totalSize)} · ${timeAgo(project.lastModified)}`
          : 'no memory yet'}
      </p>
      {/* The folder an older Tars kept this memory in, under a name Claude never reads (PR 375): kept as it was. */}
      {/* Close to or past what Claude Code reads of MEMORY.md: main's notice, cut to the row, whole in its title. */}
      {notice && (
        <p className={`mt-1 flex items-center gap-1.5 font-mono text-[10px] ${notice.ink}`}>
          <StatusSquare tone={notice.tone} />
          <span data-memory-notice={notice.state} title={notice.text} className="min-w-0 truncate">{notice.text}</span>
        </p>
      )}
      {olderFolder && (
        <p title={project.olderCopy} className="mt-1 font-mono text-[10px] text-text-muted truncate">
          older copy in {olderFolder}
        </p>
      )}
    </button>
  );
}

// ─── New file dialog ─────────────────────────────────────────────────────────

function NewFileDialog({
  onConfirm,
  onClose,
}: {
  onConfirm: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onConfirm(trimmed);
  };

  return (
    <DialogShell
      onClose={onClose}
      title="New memory file"
      subtitle="A topic file beside MEMORY.md. .md is appended automatically."
      footerRight={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSubmit} disabled={!name.trim()}>
            Create
          </Button>
        </>
      }
    >
      <Input
        autoFocus
        mono
        placeholder="e.g. debugging or api-conventions"
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); if (e.key === 'Escape') onClose(); }}
      />
    </DialogShell>
  );
}

// ─── Shared memory backends (gbrain / Honcho) status ───────────────────────

interface SourceStatus {
  id: string;
  label: string;
  configured: boolean;
  reachable: boolean;
  detail: string;
  tools?: string[];
}

type McpServersResult =
  | { success: true; servers: HermesMcpServer[] }
  | { success: false; error: string; needsSignIn?: boolean };

type MemoryProvidersResult =
  | { success: true; active: string; providers: HermesMemoryProvider[]; builtinBytes: number }
  | { success: false; error: string; needsSignIn?: boolean };

/**
 * What the gateway itself has registered - distinct from the gbrain/Honcho
 * rows above, which are Tars' own settings. A gateway-local URL (its own
 * loopback) is real information, not a dead end: it tells the user exactly
 * why Tars cannot reach a server the gateway swears is there.
 */
function GatewayMcpServers({ result }: { result: McpServersResult | null }) {
  if (result === null) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <BrandSpinner size={12} />
        Asking the gateway which MCP servers it has registered
      </div>
    );
  }
  if (!result.success) {
    return (
      <p className="text-xs text-muted-foreground">
        {result.needsSignIn ? 'Sign in to Hermes to see its MCP servers.' : result.error}
      </p>
    );
  }
  if (result.servers.length === 0) {
    return <p className="text-xs text-muted-foreground">The gateway has no MCP servers registered.</p>;
  }
  return (
    <div className="space-y-3">
      {result.servers.map(s => (
        <div key={s.name} className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <StatusSquare tone={s.enabled ? 'running' : 'idle'} />
              <span className="text-xs font-medium text-foreground">{s.name}</span>
              {s.transport && <span className="text-[10px] text-muted-foreground font-mono">{s.transport}</span>}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground font-mono break-all">
              {s.url ?? 'no URL advertised'}
            </p>
            {s.gatewayLocal && (
              <p className="mt-0.5 text-[11px] text-warning">
                That is the gateway&apos;s own loopback address. Tars runs on a different machine and cannot reach it from here.
              </p>
            )}
          </div>
          <StatusBadge tone={s.enabled ? 'running' : 'idle'} className="shrink-0 font-mono">
            {s.enabled ? 'enabled' : 'disabled'}
          </StatusBadge>
        </div>
      ))}
    </div>
  );
}

/**
 * The gateway's own pluggable long-term memory store - separate from the
 * MEMORY.md/USER.md files reported in the "Hermes memory" row above.
 * `active: ""` reads from the outside like the gateway has no memory at all,
 * so it is worth saying in plain words, with a way to fix it right there.
 */
function GatewayMemoryProvider({
  result,
  activating,
  onActivate,
}: {
  result: MemoryProvidersResult | null;
  activating: string | null;
  onActivate: (name: string) => void;
}) {
  if (result === null) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <BrandSpinner size={12} />
        Asking the gateway which memory provider is active
      </div>
    );
  }
  if (!result.success) {
    return (
      <p className="text-xs text-muted-foreground">
        {result.needsSignIn ? 'Sign in to Hermes to read its memory settings.' : result.error}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground">
        {result.active
          ? <>Active provider: <span className="font-mono text-foreground">{result.active}</span></>
          : `No provider is selected. The gateway is running on its ${formatBytes(result.builtinBytes)} of built-in files only.`}
      </p>
      <div className="space-y-2">
        {result.providers.map(p => {
          const isActive = p.name === result.active;
          const tone = isActive ? 'running' : p.available ? 'idle' : 'error';
          return (
            <div key={p.name} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <StatusSquare tone={tone} />
                  <span className="text-xs font-medium text-foreground">{p.name}</span>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">{p.description}</p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <StatusBadge tone={tone} className="font-mono">
                  {isActive ? 'active' : p.status}
                </StatusBadge>
                {!isActive && p.available && (
                  <Button size="sm" onClick={() => onActivate(p.name)} disabled={activating === p.name}>
                    {activating === p.name ? 'activating…' : 'activate'}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Probing state and the Re-check action both live on the page - the header owns them. */
function BackendsTab({
  sources,
  mcpServers,
  memoryProviders,
  activatingProvider,
  onActivateProvider,
}: {
  sources: SourceStatus[] | null;
  mcpServers: McpServersResult | null;
  memoryProviders: MemoryProvidersResult | null;
  activatingProvider: string | null;
  onActivateProvider: (name: string) => void;
}) {
  if (!sources) {
    return (
      <div className="flex items-center justify-center py-16 text-xs text-muted-foreground">
        <BrandSpinner size={14} className="mr-2" />
        Probing memory sources
      </div>
    );
  }

  return (
    <Panel fill className="flex-1 min-h-0">
      <p className="text-xs text-muted-foreground shrink-0">
        Each source below was contacted just now. Every agent reaches them through the
        memory tools, whatever CLI it runs.
      </p>
      <div className="flex-1 min-h-0 overflow-y-auto mt-3 space-y-3">
        {sources.map(s => {
          const tone = !s.configured ? 'idle' : s.reachable ? 'running' : 'error';
          const state = !s.configured ? 'not configured' : s.reachable ? 'reachable' : 'unreachable';
          return (
            <div key={s.id} className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <StatusSquare tone={tone} />
                  <span className="text-xs font-medium text-foreground">{s.label}</span>
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground font-mono break-all">{s.detail}</p>
                {s.tools && s.tools.length > 0 && (
                  <p className="mt-0.5 text-[11px] text-muted-foreground font-mono break-all">
                    tools: {s.tools.join(', ')}
                  </p>
                )}
              </div>
              <StatusBadge tone={tone} className="shrink-0 font-mono">{state}</StatusBadge>
            </div>
          );
        })}

        <div className="pt-3 mt-1 border-t border-border">
          <p className="text-xs font-medium text-foreground mb-2">Gateway MCP servers</p>
          <GatewayMcpServers result={mcpServers} />
        </div>

        <div className="pt-3 mt-1 border-t border-border">
          <p className="text-xs font-medium text-foreground mb-2">Gateway memory provider</p>
          <GatewayMemoryProvider
            result={memoryProviders}
            activating={activatingProvider}
            onActivate={onActivateProvider}
          />
        </div>
      </div>
    </Panel>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function MemoryPage() {
  const {
    filteredProjects,
    agentCountByPath,
    selectedProject,
    selectedFile,
    loading,
    saving,
    error,
    isElectron,
    selectProject,
    selectFile,
    saveFile,
    createFile,
    deleteFile,
    refresh,
  } = useMemory();

  // In the card More opens (the new interface), the page fills the card
  // rather than the window: at the window's height, the bottom of the graph
  // was under the card's edge, past what it shows.
  const inCard = useCardTitle() !== null;
  const [activeTab, setActiveTab] = useState<Tab>('projects');
  const [showNewFileDialog, setShowNewFileDialog] = useState(false);
  const [deletingFile, setDeletingFile] = useState<string | null>(null);
  // Remounting the canvas is how the graph re-reads; it owns its own fetch.
  const [graphKey, setGraphKey] = useState(0);

  // ── Backends probe: hoisted so the page header can carry the Re-check ──
  const [sources, setSources] = useState<SourceStatus[] | null>(null);
  const [mcpServers, setMcpServers] = useState<McpServersResult | null>(null);
  const [memoryProviders, setMemoryProviders] = useState<MemoryProvidersResult | null>(null);
  const [activatingProvider, setActivatingProvider] = useState<string | null>(null);
  const [activateError, setActivateError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const projectPath = selectedProject?.projectPath;

  const probeSources = useCallback(async () => {
    setChecking(true);
    try {
      const [sourcesRes, mcpRes, providersRes] = await Promise.all([
        window.electronAPI?.memoryHub?.sources(projectPath),
        window.electronAPI?.hermes?.mcpServers(),
        window.electronAPI?.hermes?.memoryProviders(),
      ]);
      setSources(sourcesRes?.sources ?? []);
      setMcpServers(mcpRes ?? { success: false, error: 'No response from the gateway' });
      setMemoryProviders(providersRes ?? { success: false, error: 'No response from the gateway' });
    } catch {
      setSources([]);
      setMcpServers({ success: false, error: 'No response from the gateway' });
      setMemoryProviders({ success: false, error: 'No response from the gateway' });
    } finally {
      setChecking(false);
    }
  }, [projectPath]);

  const activateMemoryProvider = useCallback(async (name: string) => {
    setActivatingProvider(name);
    setActivateError(null);
    try {
      const res = await window.electronAPI?.hermes?.setMemoryProvider(name);
      if (res?.success) {
        const providersRes = await window.electronAPI?.hermes?.memoryProviders();
        setMemoryProviders(providersRes ?? { success: false, error: 'No response from the gateway' });
      } else {
        setActivateError(res?.error ?? 'Could not activate the provider');
      }
    } catch (err) {
      setActivateError(err instanceof Error ? err.message : 'Could not activate the provider');
    } finally {
      setActivatingProvider(null);
    }
  }, []);

  useEffect(() => {
    if (activeTab !== 'backends') return;
    void probeSources();
  }, [activeTab, probeSources]);

  const handleDelete = useCallback(async (filePath: string) => {
    setDeletingFile(filePath);
    await deleteFile(filePath);
    setDeletingFile(null);
  }, [deleteFile]);

  const handleCreateFile = useCallback(async (name: string) => {
    if (!selectedProject) return;
    setShowNewFileDialog(false);
    await createFile(selectedProject.memoryDir, name);
  }, [selectedProject, createFile]);

  if (!isElectron) {
    return (
      <div className="flex items-center justify-center h-[60vh] text-center">
        <p className="text-sm text-muted-foreground">Memory is only available in the desktop app.</p>
      </div>
    );
  }

  // Exactly one action, whichever tab is open.
  const headerAction = activeTab === 'backends' ? (
    <Button onClick={probeSources} disabled={checking}>Re-check</Button>
  ) : activeTab === 'agents' ? (
    <Button onClick={() => setGraphKey(k => k + 1)}>Refresh</Button>
  ) : (
    <Button onClick={refresh} disabled={loading}>Refresh</Button>
  );

  return (
    <div className={`flex flex-col ${inCard ? 'h-full' : 'h-[calc(100vh-7rem)] lg:h-[calc(100vh-44px)]'} overflow-hidden`}>

      <PageHeader
        title="Brain"
        subtitle="What your agents know, and which of it they can actually reach right now."
        actions={headerAction}
      />

      {/* ── Tabs ── */}
      <div className="mb-3 shrink-0">
        <SegmentedControl
          options={TABS}
          value={activeTab}
          onChange={setActiveTab}
          ariaLabel="Brain section"
        />
      </div>

      {/* ── Agents graph tab ── */}
      {activeTab === 'agents' && (
        <div className="flex-1 min-h-0">
          <AgentKnowledgeGraph key={graphKey} />
        </div>
      )}

      {/* ── Shared backends tab ── */}
      {activeTab === 'backends' && (
        <BackendsTab
          sources={sources}
          mcpServers={mcpServers}
          memoryProviders={memoryProviders}
          activatingProvider={activatingProvider}
          onActivateProvider={activateMemoryProvider}
        />
      )}
      {activeTab === 'backends' && activateError && (
        <div className="mt-2 p-2 bg-danger/10 border border-danger/30 text-danger text-xs flex items-center gap-2 shrink-0">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          {activateError}
        </div>
      )}

      {/* ── Projects tab content ── */}
      {activeTab === 'projects' && <>

        {/* ── Error ── */}
        {error && (
          <div className="mb-3 p-3 bg-danger/10 border border-danger/30 text-danger text-xs flex items-center gap-2 shrink-0">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {/* ── Three panels ── */}
        <div className="flex-1 flex gap-2 min-h-0">

          {/* ── Left: projects ── */}
          <Panel fill className="w-56 lg:w-64 shrink-0">
            <PanelCaption className="shrink-0">Projects with memory</PanelCaption>
            <div className="flex-1 overflow-y-auto mt-2">
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <BrandSpinner size={30} label="Loading projects" />
                </div>
              ) : filteredProjects.length === 0 ? (
                <div className="px-1 py-8 text-center">
                  <p className="text-xs text-muted-foreground">No Claude projects found</p>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    Memory is created automatically as you work with Claude Code
                  </p>
                </div>
              ) : (
                <motion.div
                  initial="hidden"
                  animate="visible"
                  variants={{
                    visible: { transition: { staggerChildren: 0.04 } },
                    hidden: {},
                  }}
                >
                  {filteredProjects.map((project) => (
                    <motion.div
                      key={project.id}
                      variants={{
                        hidden: { opacity: 0, x: -8 },
                        visible: { opacity: 1, x: 0 },
                      }}
                    >
                      <ProjectRow
                        project={project}
                        isSelected={selectedProject?.id === project.id}
                        activeAgents={agentCountByPath.get(project.projectPath) ?? 0}
                        onClick={() => selectProject(project)}
                      />
                    </motion.div>
                  ))}
                </motion.div>
              )}
            </div>
          </Panel>

          {/* ── Middle: files ── */}
          <Panel fill className="w-44 lg:w-52 shrink-0">
            <PanelCaption className="shrink-0">
              {selectedProject ? `${selectedProject.files.length} files` : 'Files'}
            </PanelCaption>
            <div className="flex-1 overflow-y-auto mt-2">
              {!selectedProject ? (
                <p className="px-1 py-8 text-center text-xs text-muted-foreground">Select a project</p>
              ) : !selectedProject.hasMemory ? (
                <p className="px-1 py-8 text-center text-xs text-muted-foreground">No memory files yet</p>
              ) : (
                selectedProject.files.map((file) => (
                  <button
                    key={file.path}
                    onClick={() => selectFile(file)}
                    className={`w-full text-left px-2 py-1.5 border transition-colors ${selectedFile?.path === file.path
                      ? 'bg-secondary border-border-accent text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary'
                      }`}
                  >
                    <span className="block text-xs font-mono truncate">{file.name}</span>
                    {file.isEntrypoint && (
                      <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground mt-0.5">
                        {guardNotice(selectedProject.guard) && <StatusSquare tone={guardNotice(selectedProject.guard)!.tone} />}
                        entrypoint
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>
          </Panel>

          {/* ── Right: file ── */}
          <Panel fill padded={false} className="flex-1 min-w-0">
            {selectedFile ? (
              <FilePane
                key={selectedFile.path}
                file={selectedFile}
                saving={saving}
                deleting={deletingFile === selectedFile.path}
                onSave={(content) => { void saveFile(selectedFile.path, content); }}
                onNewFile={() => setShowNewFileDialog(true)}
                onDelete={() => handleDelete(selectedFile.path)}
                guard={selectedProject?.guard}
              />
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-8">
                <p className="text-sm text-muted-foreground">
                  {selectedProject
                    ? 'Select a memory file to read or edit'
                    : 'Select a project to explore its memory'}
                </p>
                {selectedProject && (
                  <Button size="sm" className="font-mono" onClick={() => setShowNewFileDialog(true)}>
                    new file
                  </Button>
                )}
              </div>
            )}
          </Panel>
        </div>

        {showNewFileDialog && (
          <NewFileDialog
            onConfirm={handleCreateFile}
            onClose={() => setShowNewFileDialog(false)}
          />
        )}

      </>}
    </div>
  );
}
