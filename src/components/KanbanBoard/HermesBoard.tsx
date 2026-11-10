'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Plus } from 'lucide-react';
import Link from 'next/link';
import { Button, Dropdown, Input, LoadingPanel, PanelCaption, Textarea, PageHeader } from '@/components/ui';
import { DialogShell } from '@/components/ui';
import { describeHermesFailure, HERMES_ABSENT_TEXT, isHermesAbsent } from './hermes-error';

/**
 * Hermes-backed board. The harness - task lifecycle, workers, runs - lives in
 * Hermes; Tars only reads the board and moves cards. Columns are Hermes'
 * own eight, never projected onto a smaller set (that would be lossy on write).
 */

const COLUMNS = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done'] as const;
type HermesColumn = (typeof COLUMNS)[number];

interface HermesTask {
  id: string;
  title?: string;
  status?: string;
  priority?: number;
  assignee?: string | null;
  body?: string | null;
}

interface HermesComment {
  id: number;
  author?: string;
  body: string;
  created_at?: number;
}

interface HermesTaskDetail {
  task: HermesTask;
  comments?: HermesComment[];
}

/**
 * The gateway's own board shape: `columns` is an ARRAY of `{ name, tasks }`,
 * not a map keyed by column name. Reading it as `board.columns[colName]`
 * (a string index into an array) is always `undefined`, so the board used to
 * render every column empty no matter what was actually on the gateway -
 * verified against a live Hermes 0.20 instance, where a task created and
 * left in `ready` never appeared. Normalise once, here, into the map every
 * render actually wants.
 */
function columnsByName(board: BoardPayload | null): Record<string, HermesTask[]> {
  const raw = board?.columns;
  if (!Array.isArray(raw)) return {};
  const out: Record<string, HermesTask[]> = {};
  for (const col of raw) {
    if (col && typeof col === 'object' && typeof col.name === 'string') {
      out[col.name] = Array.isArray(col.tasks) ? col.tasks : [];
    }
  }
  return out;
}

interface BoardPayload {
  columns?: Array<{ name: string; tasks: HermesTask[] }>;
}

const STATUS_OPTIONS = COLUMNS.map(c => ({ value: c, label: c }));

export default function HermesBoard({ subtitle }: { subtitle?: string } = {}) {
  const [board, setBoard] = useState<BoardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  // No Hermes set up at all: not a failure, said as such (frame `First run (2.0.7) · states`).
  const [absent, setAbsent] = useState(false);

  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<HermesTaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [assigneeDraft, setAssigneeDraft] = useState('');
  const [commentDraft, setCommentDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setErrorDetail(null);
    try {
      const r = await window.electronAPI?.hermes?.kanbanBoard();
      if (!r) { setError('Electron API unavailable'); return; }
      if (!r.success) {
        setAbsent(isHermesAbsent(r.error || ''));
        setError(r.error || 'Could not read the Hermes board');
        setNeedsSignIn(!!r.needsSignIn);
        return;
      }
      setNeedsSignIn(false);
      setAbsent(false);
      setBoard((r.board ?? {}) as BoardPayload);
    } catch (err) {
      // The failure this fixes: a transport error rejects the IPC call instead
      // of returning a result, so the raw "Error invoking remote method ...
      // ECONNREFUSED" used to land on screen. Kanban is the Hermes board with
      // nothing to fall back to, so say which gateway went silent.
      const raw = err instanceof Error ? err.message : String(err);
      let baseUrl: string | null = null;
      try { baseUrl = (await window.electronAPI?.hermes?.getConnection())?.baseUrl || null; } catch { /* best effort */ }
      const { message, detail: d } = describeHermesFailure(raw, baseUrl);
      setNeedsSignIn(false);
      setAbsent(false);
      setError(message);
      setErrorDetail(d);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const openNewTask = () => {
    setNewTitle('');
    setNewBody('');
    setCreateError(null);
    setNewTaskOpen(true);
  };

  const submitNewTask = async () => {
    const title = newTitle.trim();
    if (!title) { setCreateError('Title is required.'); return; }
    setCreating(true);
    setCreateError(null);
    try {
      const r = await window.electronAPI?.hermes?.kanbanCreateTask({
        title,
        ...(newBody.trim() ? { body: newBody.trim() } : {}),
      });
      if (!r?.success) { setCreateError(r?.error || 'Could not create the task.'); return; }
      setNewTaskOpen(false);
      await load();
    } finally {
      setCreating(false);
    }
  };

  const openTask = async (id: string) => {
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const r = await window.electronAPI?.hermes?.kanbanGetTask({ taskId: id });
      if (!r?.success) { setDetailError(r?.error || 'Could not load the task.'); return; }
      const d = r.detail as HermesTaskDetail;
      setDetail(d);
      setAssigneeDraft(d.task?.assignee ?? '');
    } finally {
      setDetailLoading(false);
    }
  };

  const closeTask = () => {
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
    setCommentDraft('');
  };

  const moveTask = async (status: HermesColumn) => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const r = await window.electronAPI?.hermes?.kanbanUpdateTask({ taskId: selectedId, patch: { status } });
      if (!r?.success) { setDetailError(r?.error || 'Could not move the task.'); return; }
      setDetail(prev => prev ? { ...prev, task: { ...prev.task, status } } : prev);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const saveAssignee = async () => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const value = assigneeDraft.trim();
      const r = await window.electronAPI?.hermes?.kanbanUpdateTask({ taskId: selectedId, patch: { assignee: value || null } });
      if (!r?.success) { setDetailError(r?.error || 'Could not assign the task.'); return; }
      setDetail(prev => prev ? { ...prev, task: { ...prev.task, assignee: value || null } } : prev);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const submitComment = async () => {
    if (!selectedId || !commentDraft.trim()) return;
    setBusy(true);
    try {
      const r = await window.electronAPI?.hermes?.kanbanAddComment({ taskId: selectedId, body: commentDraft.trim() });
      if (!r?.success) { setDetailError(r?.error || 'Could not post the comment.'); return; }
      setCommentDraft('');
      await openTask(selectedId);
    } finally {
      setBusy(false);
    }
  };

  const deleteTask = async () => {
    if (!selectedId) return;
    setBusy(true);
    try {
      const r = await window.electronAPI?.hermes?.kanbanDeleteTask({ taskId: selectedId });
      if (!r?.success) { setDetailError(r?.error || 'Could not delete the task.'); return; }
      closeTask();
      await load();
    } finally {
      setBusy(false);
    }
  };

  // The frame puts "+ New task" in Header > Actions. It used to sit on a row of
  // its own under a header the route drew, which left it floating below the
  // title. Rendered here because only this component holds the dialog state,
  // and in every branch so the header does not vanish while the board loads.
  const header = (
    <PageHeader
      title="Kanban"
      subtitle={subtitle ?? 'The Hermes board. Hermes owns the tasks, the workers and the runs.'}
      actions={
        <Button variant="primary" onClick={openNewTask}>
          <Plus className="w-3.5 h-3.5" />
          New task
        </Button>
      }
    />
  );

  if (loading && !board) {
    return <div className="flex flex-col h-full">{header}<LoadingPanel what="Reading the Hermes board" /></div>;
  }

  if (error && absent) {
    return (
      <div className="flex flex-col h-full">
        {header}
        <div className="flex flex-1 items-center justify-center px-6">
          <div data-hermes-absent className="w-full max-w-[660px] flex flex-col gap-2 px-3.5 py-3 bg-secondary">
            <p className="text-[12.5px] leading-[1.45] text-foreground">{HERMES_ABSENT_TEXT}</p>
            <div className="flex items-center gap-1.5">
              <Link
                href="/settings?section=hermes"
                className="inline-flex items-center justify-center h-[26px] px-2.5 text-xs font-medium border border-primary bg-primary text-primary-foreground hover:bg-primary/90"
              >
                Open Hermes settings
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col h-full">
      {header}
      <div className="flex flex-col items-center justify-center flex-1 gap-3 text-center px-6">
        <AlertCircle className="w-6 h-6 text-warning" />
        <p className="text-sm text-foreground max-w-md">{error}</p>
        {errorDetail && (
          <p className="text-[11px] font-mono text-muted-foreground max-w-md break-all">{errorDetail}</p>
        )}
        <div className="flex items-center gap-2">
          {/* An anchor, so it cannot come through <Button>; the classes are the
              primary variant at the 26px control height, copied verbatim. */}
          <Link
            href="/settings?section=hermes"
            className="inline-flex items-center justify-center h-[26px] px-2.5 text-xs font-medium border border-primary bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {needsSignIn ? 'Sign in to Hermes' : 'Open Hermes settings'}
          </Link>
          <Button size="sm" onClick={load}>Retry</Button>
        </div>
      </div>
      </div>
    );
  }

  const columns = columnsByName(board);

  return (
    <div className="flex flex-col h-full">
      {header}

      <div className="flex-1 min-h-0 overflow-x-auto">
        {/* Tracks share the width and only scroll once they hit their floor -
            eight columns still overflow, which is Hermes' shape, not a bug. */}
        <div className="flex gap-2 h-full pb-2">
          {COLUMNS.map(col => {
            const tasks = columns[col] ?? [];
            return (
              <div key={col} className="flex-1 min-w-[200px] flex flex-col border border-border bg-card">
                <div className="flex items-center justify-between px-3 py-2">
                  <span className="text-[11.5px] text-text-secondary">{col}</span>
                  <span className="text-[10px] font-mono text-muted-foreground">{tasks.length}</span>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
                  {tasks.map(t => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => openTask(t.id)}
                      className="w-full text-left border border-border bg-bg-tertiary p-3 space-y-2 hover:border-border-accent transition-colors cursor-pointer"
                    >
                      <p className="text-xs text-foreground leading-snug">{t.title || t.id}</p>
                      {t.assignee && (
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] text-muted-foreground truncate">{t.assignee}</span>
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {newTaskOpen && (
        <DialogShell
          onClose={() => setNewTaskOpen(false)}
          title="New task"
          subtitle="Lands in Hermes' triage column."
          width={480}
          footerRight={
            <>
              <Button variant="secondary" onClick={() => setNewTaskOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={submitNewTask} disabled={creating}>
                {creating ? 'Creating…' : 'Create'}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <div className="space-y-1.5">
              <PanelCaption>Title</PanelCaption>
              <Input value={newTitle} onChange={e => setNewTitle(e.target.value)} placeholder="What needs doing?" autoFocus />
            </div>
            <div className="space-y-1.5">
              <PanelCaption>Description (optional)</PanelCaption>
              <Textarea value={newBody} onChange={e => setNewBody(e.target.value)} rows={4} />
            </div>
            {createError && <p className="text-[11px] text-danger">{createError}</p>}
          </div>
        </DialogShell>
      )}

      {selectedId && (
        <DialogShell
          onClose={closeTask}
          title={detail?.task?.title || selectedId}
          subtitle={detail ? `${detail.task.status ?? 'unknown'}${detail.task.assignee ? ` · ${detail.task.assignee}` : ''}` : undefined}
          width={560}
          footerLeft={<Button variant="danger" onClick={deleteTask} disabled={busy || detailLoading}>Delete</Button>}
          footerRight={<Button variant="secondary" onClick={closeTask}>Close</Button>}
        >
          {detailLoading && <LoadingPanel what="Reading the task" size={26} className="py-6" />}
          {detailError && <p className="text-[11px] text-danger">{detailError}</p>}
          {detail && (
            <div className="space-y-4">
              {detail.task.body && (
                <p className="text-xs text-foreground leading-snug whitespace-pre-wrap">{detail.task.body}</p>
              )}

              <div className="space-y-1.5">
                <PanelCaption>Column</PanelCaption>
                <Dropdown<HermesColumn>
                  value={(detail.task.status as HermesColumn) ?? 'triage'}
                  options={STATUS_OPTIONS}
                  onChange={moveTask}
                  className="w-48"
                />
              </div>

              <div className="space-y-1.5">
                <PanelCaption>Assignee</PanelCaption>
                <div className="flex items-center gap-2">
                  <Input
                    value={assigneeDraft}
                    onChange={e => setAssigneeDraft(e.target.value)}
                    placeholder="agent id, or leave blank"
                    className="max-w-[260px]"
                  />
                  <Button size="sm" onClick={saveAssignee} disabled={busy}>Save</Button>
                </div>
              </div>

              <div className="space-y-1.5">
                <PanelCaption>Comments</PanelCaption>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {(detail.comments ?? []).length === 0 && (
                    <p className="text-[11px] text-muted-foreground">No comments yet.</p>
                  )}
                  {(detail.comments ?? []).map(c => (
                    <div key={c.id} className="border border-border bg-bg-tertiary p-2">
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                        <span>{c.author || 'unknown'}</span>
                      </div>
                      <p className="text-xs text-foreground whitespace-pre-wrap">{c.body}</p>
                    </div>
                  ))}
                </div>
                <div className="flex items-start gap-2 pt-1">
                  <Textarea
                    value={commentDraft}
                    onChange={e => setCommentDraft(e.target.value)}
                    placeholder="Add a comment…"
                    rows={2}
                    className="flex-1"
                  />
                  <Button size="sm" onClick={submitComment} disabled={busy || !commentDraft.trim()}>Post</Button>
                </div>
              </div>
            </div>
          )}
        </DialogShell>
      )}
    </div>
  );
}
