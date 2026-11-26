'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderX } from 'lucide-react';
import { Button, LoadingState, PageHeader, Panel } from '@/components/ui';
import type { ChangedFile, ReviewDiff } from '@/types/electron';
import { PATCH_LINES, cutNote, patchLines } from '@/lib/review';
import { insidePath } from '@/lib/review-repositories';
import { pathName, tildePath } from '@/lib/display-path';
import { ipcReason } from '@/lib/ipc-error';
import { RepositoryColumn, type ReviewPick } from '@/components/Review/RepositoryColumn';
import { useReviewProjects, type ProjectView } from '@/components/Review/useReviewProjects';

/**
 * What the agents actually changed, in every repository of every project (2.0.4, #472; frames `Review · projects
 * and their repositories`, `· search`, `· a folder with no git`, `· states`).
 *
 * The Git panel showed twenty lines of `git diff --stat`; the question a
 * reviewer has is which files moved and what the patch says. The left column
 * lists what main's scan found (components/Review), the middle one the picked
 * repository's files, the right one a picked file's patch.
 */

function statusTone(status: ChangedFile['status']): string {
  if (status === 'added' || status === 'untracked') return 'text-success';
  if (status === 'deleted') return 'text-danger';
  if (status === 'renamed') return 'text-primary';
  return 'text-muted-foreground';
}

function PatchView({ patch }: { patch: string }) {
  const lines = useMemo(() => patchLines(patch).slice(0, PATCH_LINES), [patch]);

  return (
    <pre className="text-[11px] font-mono leading-relaxed overflow-x-auto">
      {lines.map((line, i) => {
        const tone = line.startsWith('+') && !line.startsWith('+++')
          ? 'text-success'
          : line.startsWith('-') && !line.startsWith('---')
            ? 'text-danger'
            : line.startsWith('@@')
              ? 'text-primary'
              : 'text-muted-foreground';
        return <div key={i} className={tone}>{line || ' '}</div>;
      })}
    </pre>
  );
}

export default function ReviewPage() {
  const projects = useReviewProjects();
  const [picked, setPicked] = useState<ReviewPick | null>(null);
  const [diff, setDiff] = useState<ReviewDiff | null>(null);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [filePatch, setFilePatch] = useState<string>('');
  const [fileError, setFileError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The tree and the file last asked for: an answer for another one came back
  // late, after the person moved on, and is dropped.
  const treeAsked = useRef<string | null>(null);
  const fileAsked = useRef<string | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Until something is picked, the first repository main found.
  const pick: ReviewPick | null = picked ?? firstRepository(projects.projects);
  const repoPath = pick?.kind === 'repo' ? pick.repo : null;
  const pickedFile = pick?.kind === 'repo' ? pick.file ?? null : null;

  const load = useCallback(async (path: string) => {
    treeAsked.current = path;
    fileAsked.current = null;
    setLoading(true);
    setError(null);
    setActiveFile(null);
    setFilePatch('');
    setFileError(null);
    try {
      // The files alone (#247): each file's patch is read once it is picked,
      // so the tree's whole patch, up to 2 MB, is neither built nor carried.
      const res = await window.electronAPI?.review?.diff(path, undefined, { listOnly: true });
      if (treeAsked.current !== path) return;
      if (!res?.success || !res.diff) {
        setDiff(null);
        setError(res?.error || 'Could not read this repository');
        return;
      }
      setDiff(res.diff);
    } catch (err) {
      if (treeAsked.current === path) setError(ipcReason(err, 'Could not read this repository'));
    } finally {
      if (treeAsked.current === path) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (repoPath) void load(repoPath);
  }, [repoPath, load]);

  const openFile = useCallback(async (file: string) => {
    if (!diff) return;
    fileAsked.current = file;
    setActiveFile(file);
    setFilePatch('');
    setFileError(null);
    const res: { success: boolean; patch?: string; error?: string } | undefined = await window.electronAPI?.review
      ?.file(diff.repo, file, diff.baseBranch ?? undefined)
      .catch((err: unknown) => ({ success: false, error: ipcReason(err, 'unknown error') }));
    if (fileAsked.current !== file) return;
    if (res && !res.success) setFileError(res.error || 'unknown error');
    else setFilePatch(res?.patch || '');
  }, [diff]);

  // A search result names a file: once its repository's files are read, open it.
  useEffect(() => {
    if (pickedFile && diff && diff.repo === repoPath && fileAsked.current !== pickedFile) void openFile(pickedFile);
  }, [pickedFile, diff, repoPath, openFile]);

  const search = (query: string) => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => { void projects.find(query); }, 250);
  };

  const cut = activeFile ? cutNote(patchLines(filePatch).length) : null;
  const project = pick ? projects.projects.find((p) => p.path === pick.project) : undefined;
  const title = pick?.kind === 'repo' && project ? `${pathName(project.path) || project.path} / ${insidePath(project.path, pick.repo)}` : null;

  return (
    <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-44px)] flex flex-col">
      <PageHeader
        title="Review"
        subtitle="What your agents changed, in every repository of every project."
        actions={
          <Button
            size="md"
            onClick={() => { void projects.refresh(); if (repoPath) void load(repoPath); }}
            disabled={loading}
          >
            Refresh
          </Button>
        }
      />

      {!projects.loaded ? (
        <div className="flex flex-1 items-center justify-center">
          <LoadingState loading what="Still finding your projects' repositories…" detail="reading the projects and the agent list" />
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex gap-3">
          {/* Three panels, not one strip cut up by `border-l`: the repositories,
              the files in the picked one, and the patch of the picked file. */}
          <Panel fill className="w-[300px] shrink-0">
            <RepositoryColumn
              projects={projects.projects}
              search={projects.search}
              pick={pick}
              onSearch={search}
              onPick={setPicked}
              onRemove={(path) => { void projects.remove(path); if (pick?.project === path) setPicked(null); }}
            />
          </Panel>

          {pick?.kind === 'no-git' ? (
            <NoGit project={project} path={pick.project} />
          ) : (
            <>
              {/* Files */}
              <Panel fill className="w-[320px] shrink-0">
                <section aria-label="Changed files" className="flex flex-col h-full min-h-0">
                  {title && <p className="font-mono text-[12px] text-foreground truncate mb-1.5">{title}</p>}
                  <LoadingState
                    loading={loading}
                    what="Still reading the working tree…"
                    detail="git diff against the base branch"
                  />
                  {/* Main's own sentence in the changed files' place: a repository the window's rule refuses, or none read. */}
                  {error && <p data-review-error className="text-xs text-danger py-4">{error}</p>}
                  {diff && !loading && (
                    <>
                      <p className="text-[11px] font-mono text-muted-foreground">
                        {diff.branch}
                        {diff.baseBranch ? ` vs ${diff.baseBranch}` : ''}
                        {diff.ahead ? ` · ${diff.ahead} commit${diff.ahead > 1 ? 's' : ''} ahead` : ''}
                      </p>
                      <p className="text-[11px] font-mono mt-1">
                        <span className="text-success">+{diff.totalAdditions}</span>{' '}
                        <span className="text-danger">-{diff.totalDeletions}</span>{' '}
                        <span className="text-muted-foreground">
                          in {diff.files.length} file{diff.files.length === 1 ? '' : 's'}
                        </span>
                      </p>
                      {diff.files.length === 0 && (
                        <p className="text-xs text-muted-foreground mt-3">
                          {`Nothing changed in ${pick?.kind === 'repo' && project ? insidePath(project.path, pick.repo) : 'this tree'} since its last commit on ${diff.branch}.`}
                        </p>
                      )}
                      {/* The open file is a box the width of the panel's inside, with
                          its path, counts and status in it - not a bare wash. */}
                      <div className="flex-1 min-h-0 overflow-y-auto mt-3 space-y-1">
                        {diff.files.map(f => (
                          <button
                            key={f.path}
                            onClick={() => openFile(f.path)}
                            className={`w-full text-left px-2 py-1.5 border text-[11px] font-mono transition-colors ${
                              f.path === activeFile
                                ? 'bg-secondary border-border-accent text-foreground'
                                : 'border-transparent text-muted-foreground hover:text-foreground'
                            }`}
                          >
                            <span className="flex items-center justify-between gap-2">
                              <span className="truncate">{f.path}</span>
                              <span className="shrink-0 text-[10px]">
                                <span className="text-success">+{f.additions}</span>{' '}
                                <span className="text-danger">-{f.deletions}</span>
                              </span>
                            </span>
                            <span className={`block text-[10px] ${statusTone(f.status)}`}>{f.status}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </section>
              </Panel>

              {/* Patch */}
              <Panel fill className="flex-1 min-w-0">
                <div className="flex-1 min-h-0 overflow-auto">
                  {activeFile ? (
                    <>
                      <p className="text-xs font-mono text-foreground mb-2 sticky top-0 bg-card py-1">{activeFile}</p>
                      {/* Main's own sentence in the patch's place, word for word (a file named like a credential, a
                          repository the window's rule refuses), never an empty patch. */}
                      {fileError ? (
                        <p className="text-xs text-danger">Could not read this file&apos;s patch: <span data-review-file-error>{fileError}</span></p>
                      ) : filePatch ? <PatchView patch={filePatch} /> : (
                        <p className="text-xs text-muted-foreground">No textual change to show for this file.</p>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">Pick a file to read its patch.</p>
                  )}
                  {cut && !fileError && <p className="text-[11px] text-muted-foreground mt-2">{cut}</p>}
                </div>
              </Panel>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** The first repository main found, in the column's order: what the page opens on. */
function firstRepository(projects: ProjectView[]): ReviewPick | null {
  for (const p of projects) {
    const repo = p.repositories[0];
    if (repo) return { kind: 'repo', project: p.path, repo: repo.path };
  }
  return null;
}

/** A project with no git, picked (frame `Review · projects and their repositories · a folder with no git`). */
function NoGit({ project, path }: { project?: ProjectView; path: string }) {
  const name = pathName(path) || path;
  return (
    <Panel fill className="flex-1 min-w-0">
      <div className="max-w-[560px] p-3 space-y-3">
        <FolderX className="w-4 h-4 text-muted-foreground" />
        <h2 className="text-[17px] text-foreground">{`${name} is not under git`}</h2>
        <p className="text-[12px] leading-[1.5] text-text-secondary">
          {`Tars found no repository in ${tildePath(path)} or in any folder inside it. Review shows what changed in a git repository, so there is nothing to show here, and the agents' changes in this folder are not tracked.`}
        </p>
        <p className="font-mono text-[12px] text-foreground">{tildePath(path)}</p>
        <Button size="sm" className="font-mono" disabled={!project} onClick={() => { void window.electronAPI?.shell?.reveal(path); }}>show folder</Button>
      </div>
    </Panel>
  );
}
