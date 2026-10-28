'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import Link from 'next/link';
import { motion, AnimatePresence } from 'framer-motion';
import { useStore } from '@/store';
import { Archive, Brain } from 'lucide-react';
import type { VaultDocumentElectron, VaultFolderElectron, VaultAttachmentElectron } from '@/types/electron';

import { BrandSpinner, Button, PageHeader, Panel, PanelCaption } from '@/components/ui';
import FolderTree from './components/FolderTree';
import DocumentList from './components/DocumentList';
import DocumentViewer from './components/DocumentViewer';
import DocumentEditor from './components/DocumentEditor';
import { VaultEmptyState } from './shared';
import { useDesktopApi } from '@/hooks/useDesktopApi';
import { useProjectFolders, type PlaceEntry, type ProjectPlace } from './project/useProjectFolders';
import { ProjectFolders } from './project/ProjectFolders';
import { ProjectFileList } from './project/ProjectFileList';
import { ProjectFilePanel } from './project/ProjectFilePanel';
import { ProjectLinkNote } from './project/ProjectLinkNote';

function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI?.vault;
}

// The list no longer leaves the screen when a document opens, so the mode only
// says what the right-hand panel is showing.
type ViewMode = 'list' | 'view' | 'edit';

const READ_DOCS_KEY = 'vault-read-docs';

function loadReadDocs(): Set<string> {
  try {
    const stored = localStorage.getItem(READ_DOCS_KEY);
    if (stored) return new Set(JSON.parse(stored));
    return new Set(); // First load - will be populated after initial fetch
  } catch {
    return new Set();
  }
}

function isFirstLoad(): boolean {
  return localStorage.getItem(READ_DOCS_KEY) === null;
}

function saveReadDocs(ids: Set<string>) {
  localStorage.setItem(READ_DOCS_KEY, JSON.stringify([...ids]));
}

export default function VaultView({ embedded, subtitle }: { embedded?: boolean; subtitle?: string } = {}) {
  // False for the pre-render and for the hydration pass, true right after, so
  // the page renders the same tree in both: see useDesktopApi.
  const hasVaultApi = useDesktopApi(api => api.vault);

  // Data state
  const [documents, setDocuments] = useState<VaultDocumentElectron[]>([]);
  const [allDocuments, setAllDocuments] = useState<VaultDocumentElectron[]>([]);
  const [folders, setFolders] = useState<VaultFolderElectron[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<VaultDocumentElectron | null>(null);
  const [selectedDocAttachments, setSelectedDocAttachments] = useState<VaultAttachmentElectron[]>([]);
  const [readDocIds, setReadDocIds] = useState<Set<string>>(() => loadReadDocs());

  // UI state
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const setVaultUnreadCount = useStore(s => s.setVaultUnreadCount);

  // Each project's folder, every folder of it (2.0.5, the places of PR 530), beside the documents made here.
  const projects = useProjectFolders(hasVaultApi);
  const [projectEntry, setProjectEntry] = useState<PlaceEntry | null>(null);
  const openProjectPlace = (place: ProjectPlace) => {
    projects.choose(place);
    setProjectEntry(null);
    setSelectedDoc(null);
    setViewMode('list');
  };
  const leaveProjects = () => {
    projects.leave();
    setProjectEntry(null);
  };
  const projectFolder = projects.place ? projects.folders.find((f) => f.key === projects.place?.key) ?? null : null;
  const projectEntries = projects.list && 'entries' in projects.list ? projects.list.entries : [];
  const projectNames = projectEntries.filter((e) => e.type === 'file').map((e) => e.name);
  const openProjectFile = (name: string) => setProjectEntry(projectEntries.find((e) => e.type === 'file' && e.name === name) ?? null);
  const projectFile = projectEntry?.type === 'file' && !projectEntry.hardlink ? projectEntry.name : null;

  // Sync unread count to global store for sidebar badge
  const unreadCount = useMemo(
    () => allDocuments.filter(d => !readDocIds.has(d.id)).length,
    [allDocuments, readDocIds]
  );
  useEffect(() => {
    setVaultUnreadCount(unreadCount);
  }, [unreadCount, setVaultUnreadCount]);

  const markAsRead = useCallback((id: string) => {
    setReadDocIds(prev => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      saveReadDocs(next);
      return next;
    });
  }, []);

  // Load documents and folders
  const loadDocuments = useCallback(async () => {
    if (!isElectron()) return;
    try {
      const params = selectedFolderId ? { folder_id: selectedFolderId } : undefined;
      const result = await window.electronAPI!.vault!.listDocuments(params);
      if (result.documents) {
        setDocuments(result.documents);
      }
    } catch (err) {
      console.error('Failed to load documents:', err);
    }
  }, [selectedFolderId]);

  const loadAllDocuments = useCallback(async () => {
    if (!isElectron()) return;
    try {
      const result = await window.electronAPI!.vault!.listDocuments();
      if (result.documents) {
        setAllDocuments(result.documents);
      }
    } catch (err) {
      console.error('Failed to load all documents:', err);
    }
  }, []);

  const loadFolders = useCallback(async () => {
    if (!isElectron()) return;
    try {
      const result = await window.electronAPI!.vault!.listFolders();
      if (result.folders) {
        setFolders(result.folders);
      }
    } catch (err) {
      console.error('Failed to load folders:', err);
    }
  }, []);

  // The initial load must run exactly once, so it reads the loaders from a ref
  // captured at mount instead of depending on them. It used to depend on
  // [loadDocuments, loadAllDocuments, loadFolders], and `loadDocuments` is keyed
  // on `selectedFolderId`, so every folder click recreated it and re-ran this
  // whole init path: four vault IPC round-trips instead of one, plus `loading`
  // flipping back to true, which unmounted the document pane and flashed the
  // spinner on each click. The `if (!loading)` guard below could not catch it
  // either, since both effects flush together and that closure always saw
  // `loading === false`.
  const initialLoadersRef = useRef({ loadDocuments, loadAllDocuments, loadFolders });

  // Initial load - on first ever load, mark all existing docs as read
  useEffect(() => {
    const firstLoad = isFirstLoad();
    const loaders = initialLoadersRef.current;
    const init = async () => {
      setLoading(true);
      await Promise.all([loaders.loadDocuments(), loaders.loadAllDocuments(), loaders.loadFolders()]);
      // On first load, mark all existing documents as already read
      if (firstLoad) {
        const result = await window.electronAPI?.vault?.listDocuments();
        if (result?.documents) {
          const ids = new Set(result.documents.map((d: VaultDocumentElectron) => d.id));
          setReadDocIds(ids);
          saveReadDocs(ids);
        }
      }
      setLoading(false);
    };
    init();
  }, []);

  // Reload documents when folder changes. Seeded with the initial folder id so
  // it does not re-fetch what the init effect above already loaded (and so a
  // StrictMode double-mount stays a single fetch).
  const loadedFolderIdRef = useRef<string | null>(selectedFolderId);
  useEffect(() => {
    if (loadedFolderIdRef.current === selectedFolderId) return;
    loadedFolderIdRef.current = selectedFolderId;
    loadDocuments();
  }, [loadDocuments, selectedFolderId]);

  // Real-time event listeners
  useEffect(() => {
    if (!isElectron()) return;

    const unsubCreated = window.electronAPI!.vault!.onDocumentCreated((doc) => {
      setDocuments(prev => [doc, ...prev]);
      setAllDocuments(prev => [doc, ...prev]);
    });

    const unsubUpdated = window.electronAPI!.vault!.onDocumentUpdated((doc) => {
      setDocuments(prev => prev.map(d => d.id === doc.id ? doc : d));
      setAllDocuments(prev => prev.map(d => d.id === doc.id ? doc : d));
      if (selectedDoc?.id === doc.id) {
        setSelectedDoc(doc);
      }
    });

    const unsubDeleted = window.electronAPI!.vault!.onDocumentDeleted(({ id }) => {
      setDocuments(prev => prev.filter(d => d.id !== id));
      setAllDocuments(prev => prev.filter(d => d.id !== id));
      if (selectedDoc?.id === id) {
        setSelectedDoc(null);
        setViewMode('list');
      }
    });

    return () => {
      unsubCreated();
      unsubUpdated();
      unsubDeleted();
    };
  }, [selectedDoc?.id]);

  // Select document
  const handleSelectDocument = async (id: string) => {
    if (!isElectron()) return;
    try {
      const result = await window.electronAPI!.vault!.getDocument(id);
      if (result.document) {
        leaveProjects();
        setSelectedDoc(result.document);
        setSelectedDocAttachments(result.attachments || []);
        setViewMode('view');
        markAsRead(id);
      }
    } catch (err) {
      console.error('Failed to load document:', err);
    }
  };

  // Attach pending files to a document. The editor inserts markdown that
  // points at the file's original path on disk (the only path it knows about
  // before the file is copied into the vault); attachFile then copies that
  // file to ~/.tars/vault/attachments/<id>-<name>, a path the vault-owned
  // /api/local-file route will actually serve. Without rewriting the content
  // to the new path, every inserted image or link 403s forever, because the
  // source file lives outside the allowed attachments directory. Returns the
  // original-path to vault-path mapping so the caller can fix the content up.
  const attachPendingFiles = async (documentId: string, files: string[]): Promise<{ from: string; to: string }[]> => {
    if (!isElectron() || files.length === 0) return [];
    const mappings: { from: string; to: string }[] = [];
    for (const filePath of files) {
      try {
        const result = await window.electronAPI!.vault!.attachFile({ document_id: documentId, file_path: filePath });
        if (result.success && result.attachment) {
          mappings.push({ from: filePath, to: result.attachment.filepath });
        }
      } catch (err) {
        console.error('Failed to attach file:', filePath, err);
      }
    }
    return mappings;
  };

  // Replace every occurrence of an attached file's original source path with
  // where it now actually lives in the vault, so markdown image/link
  // references resolve instead of 403ing.
  const rewriteAttachmentPaths = (content: string, mappings: { from: string; to: string }[]): string => {
    return mappings.reduce((text, { from, to }) => text.split(from).join(to), content);
  };

  // Create document
  const handleCreateDocument = async (data: { title: string; content: string; tags: string[]; folder_id: string | null; pendingFiles?: string[] }) => {
    if (!isElectron()) return;
    try {
      const result = await window.electronAPI!.vault!.createDocument({
        title: data.title,
        content: data.content,
        folder_id: data.folder_id || undefined,
        author: 'user',
        tags: data.tags,
      });
      if (result.document) {
        markAsRead(result.document.id);
        if (data.pendingFiles?.length) {
          const mappings = await attachPendingFiles(result.document.id, data.pendingFiles);
          if (mappings.length > 0) {
            await window.electronAPI!.vault!.updateDocument({
              id: result.document.id,
              content: rewriteAttachmentPaths(data.content, mappings),
            });
          }
        }
      }
      setViewMode('list');
      loadDocuments();
      loadAllDocuments();
    } catch (err) {
      console.error('Failed to create document:', err);
    }
  };

  // Update document
  const handleUpdateDocument = async (data: { title: string; content: string; tags: string[]; folder_id: string | null; pendingFiles?: string[] }) => {
    if (!isElectron() || !selectedDoc) return;
    try {
      let content = data.content;
      if (data.pendingFiles?.length) {
        const mappings = await attachPendingFiles(selectedDoc.id, data.pendingFiles);
        content = rewriteAttachmentPaths(content, mappings);
      }
      await window.electronAPI!.vault!.updateDocument({
        id: selectedDoc.id,
        title: data.title,
        content,
        tags: data.tags,
        folder_id: data.folder_id,
      });
      setViewMode('view');
      // Reload to get updated doc
      const result = await window.electronAPI!.vault!.getDocument(selectedDoc.id);
      if (result.document) {
        setSelectedDoc(result.document);
        setSelectedDocAttachments(result.attachments || []);
      }
    } catch (err) {
      console.error('Failed to update document:', err);
    }
  };

  // Delete document
  const handleDeleteDocument = async (id: string) => {
    if (!isElectron()) return;
    try {
      await window.electronAPI!.vault!.deleteDocument(id);
      setSelectedDoc(null);
      setViewMode('list');
      loadDocuments();
      loadAllDocuments();
    } catch (err) {
      console.error('Failed to delete document:', err);
    }
  };

  // Create folder
  const handleCreateFolder = async (name: string, parentId?: string) => {
    if (!isElectron()) return;
    try {
      await window.electronAPI!.vault!.createFolder({ name, parent_id: parentId });
      loadFolders();
    } catch (err) {
      console.error('Failed to create folder:', err);
    }
  };

  // Delete folder
  const handleDeleteFolder = async (id: string) => {
    if (!isElectron()) return;
    try {
      await window.electronAPI!.vault!.deleteFolder({ id });
      if (selectedFolderId === id) {
        setSelectedFolderId(null);
      }
      loadFolders();
      loadDocuments();
      loadAllDocuments();
    } catch (err) {
      console.error('Failed to delete folder:', err);
    }
  };

  // Non-electron fallback
  if (!hasVaultApi) {
    return (
      <VaultEmptyState
        icon={Archive}
        title="Vault"
        description="Available in the desktop app"
      />
    );
  }

  // Below lg there is no room for three columns, so the body takes the list's
  // place while a document is open - the two panels swap instead of stacking.
  const showBody = viewMode === 'edit' || !!selectedDoc || !!projectFile;

  const headerActions = (
    <>
      <Button size="md" onClick={() => { void projects.refresh(); }}>Refresh</Button>
      <Button
        variant="primary"
        size="md"
        onClick={() => {
          leaveProjects();
          setSelectedDoc(null);
          setViewMode('edit');
        }}
      >
        + Document
      </Button>
    </>
  );

  return (
    <div className={embedded ? 'flex flex-col h-full overflow-hidden' : 'flex flex-col h-[calc(100vh-7rem)] lg:h-[calc(100vh-44px)] overflow-hidden'}>
      {/* One header, whoever renders the route. The embedded case used to put
          the action on its own row below a header the route drew, which left
          "+ Document" floating under the title instead of beside it. */}
      <PageHeader
        title="Vault"
        subtitle={subtitle ?? 'What your agents produce: every folder of each project\'s folder, and the documents made here.'}
        actions={headerActions}
      />

      {/* Three panels sharing one top and one bottom edge: folders, the list of
          documents, and the document itself. The list stays on screen while a
          document is open - it used to unmount and the reader lost their place. */}
      <div className="flex-1 flex gap-2 overflow-hidden min-h-0">
        {/* Folders */}
        <Panel fill padded={false} className="w-[280px] max-xl:w-[228px] shrink-0 max-lg:hidden">
          <div className="flex-1 overflow-y-auto pb-2">
            <ProjectFolders
              folders={projects.folders}
              place={projects.place}
              levels={projects.levels}
              open={projects.open}
              onToggle={projects.toggle}
              onChoose={openProjectPlace}
              onMore={(at) => { void projects.moreOfLevel(at); }}
            />
            <div className="mx-3 border-t border-border" />
            <PanelCaption className="px-3 pt-3 pb-2">{`Documents · ${folders.length}`}</PanelCaption>
            <FolderTree
              folders={folders}
              documents={allDocuments}
              selectedFolderId={selectedFolderId}
              selectedDocId={selectedDoc?.id || null}
              readDocIds={readDocIds}
              onSelectFolder={(id) => {
                leaveProjects();
                setSelectedFolderId(id);
                setViewMode('list');
                setSelectedDoc(null);
              }}
              onSelectDocument={handleSelectDocument}
              onCreateFolder={handleCreateFolder}
              onDeleteFolder={handleDeleteFolder}
            />
          </div>
          {/* Brain is what agents know; the Vault is what they produce. */}
          <div className="mx-3 mb-3 pt-3 border-t border-border">
            <p className="text-[11px] leading-[1.45] text-muted-foreground">What agents know, their memory, is in Brain. Here is what they produce.</p>
            <Link href="/memory" className="mt-2 inline-flex items-center gap-1.5 h-[26px] px-2.5 border border-border font-mono text-[11.5px] text-text-secondary hover:text-foreground">
              <Brain className="w-3 h-3" />
              open Brain
            </Link>
          </div>
        </Panel>

        {/* Document list - the opened row stays boxed as active */}
        <Panel
          fill
          padded={false}
          className={`${projects.place ? 'w-[380px] max-xl:w-[344px]' : 'w-[300px]'} shrink-0 min-w-0 max-lg:w-auto max-lg:flex-1 ${showBody ? 'max-lg:hidden' : ''}`}
        >
          {projects.place && projectFolder ? (
            <ProjectFileList
              folder={projectFolder}
              place={projects.place.place}
              list={projects.list}
              selected={projectEntry?.name ?? null}
              notesMoved={projects.notes[projectFolder.key]}
              onOpenFolder={(place) => openProjectPlace({ key: projectFolder.key, place })}
              onOpen={setProjectEntry}
              onMore={() => { void projects.moreOfList(); }}
              onRetry={() => { void projects.refresh(); }}
              onShowFolder={() => { void window.electronAPI?.vault?.showProjectFile({ key: projectFolder.key, place: projects.place!.place }); }}
            />
          ) : loading ? (
            <div className="flex items-center justify-center h-full">
              <BrandSpinner size={30} label="Loading documents" />
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto">
              <DocumentList
                documents={documents}
                selectedDocId={selectedDoc?.id || null}
                onSelectDocument={handleSelectDocument}
                onCreateDocument={() => {
                  setSelectedDoc(null);
                  setViewMode('edit');
                }}
              />
            </div>
          )}
        </Panel>

        {/* Document body */}
        <Panel fill padded={false} className={`flex-1 min-w-0 ${showBody ? '' : 'max-lg:hidden'}`}>
          <AnimatePresence mode="wait">
            {projects.place && projectEntry && !projectFile ? (
              <motion.div key={`link-${projectEntry.name}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full overflow-y-auto">
                <ProjectLinkNote entry={projectEntry} />
              </motion.div>
            ) : projects.place && projectFile ? (
              <motion.div
                key={`file-${projects.place.key}-${projects.place.place.join('/')}-${projectFile}`}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.15 }}
                className="h-full overflow-hidden"
              >
                <ProjectFilePanel
                  projectKey={projects.place.key}
                  place={projects.place.place}
                  name={projectFile}
                  names={projectNames}
                  changes={projects.changes}
                  onOpenFile={openProjectFile}
                />
              </motion.div>
            ) : viewMode === 'edit' ? (
              <motion.div
                key="edit"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.15 }}
                className="h-full overflow-y-auto"
              >
                <DocumentEditor
                  document={selectedDoc}
                  folders={folders}
                  defaultFolderId={!selectedDoc ? selectedFolderId : undefined}
                  onSave={selectedDoc ? handleUpdateDocument : handleCreateDocument}
                  onCancel={() => {
                    setViewMode(selectedDoc ? 'view' : 'list');
                  }}
                />
              </motion.div>
            ) : selectedDoc ? (
              <motion.div
                key={`view-${selectedDoc.id}`}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.15 }}
                className="h-full overflow-y-auto"
              >
                <DocumentViewer
                  document={selectedDoc}
                  attachments={selectedDocAttachments}
                  onBack={() => {
                    setSelectedDoc(null);
                    setViewMode('list');
                  }}
                  onEdit={() => setViewMode('edit')}
                  onDelete={handleDeleteDocument}
                />
              </motion.div>
            ) : (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground"
              >
                {projects.place ? 'Pick a file in the list to read it.' : 'Pick a document on the left to read it.'}
              </motion.div>
            )}
          </AnimatePresence>
        </Panel>
      </div>
    </div>
  );
}
