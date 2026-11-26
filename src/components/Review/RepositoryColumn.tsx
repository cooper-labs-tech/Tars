'use client';

import { useState } from 'react';
import { FileCode2, FolderX, GitBranch, Search } from 'lucide-react';
import { Button, StatusSquare } from '@/components/ui';
import { pathName, tildePath } from '@/lib/display-path';
import { insidePath, nothingFoundLine, progressLine, type SearchRow } from '@/lib/review-repositories';
import type { ProjectView, ReviewRepository, SearchState } from './useReviewProjects';

/** What the column has picked: a repository of a project, or a project with no git, explained on the right. */
export type ReviewPick = { kind: 'repo'; project: string; repo: string; file?: string } | { kind: 'no-git'; project: string };

const nameOf = (p: string) => pathName(p) || p;
const changedWord = (n: number) => `${n} changed`;

function Caption({ children, right }: { children: string; right?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 pt-3 pb-1.5">
      <span className="text-[10px] tracking-[0.06em] text-text-secondary">{children.toUpperCase()}</span>
      {right && <span className="font-mono text-[10.5px] text-warning">{right}</span>}
    </div>
  );
}

/** A repository among several: its path in the project, its branch, and whether anything changed. */
function RepositoryRow({ project, repo, picked, onPick }: { project: string; repo: ReviewRepository; picked: boolean; onPick: () => void }) {
  const changed = repo.changed.length;
  return (
    <button
      type="button"
      aria-pressed={picked}
      onClick={onPick}
      className={`w-full flex items-center gap-2 px-2.5 py-[6px] border text-left ${picked ? 'bg-secondary border-border-accent' : 'border-transparent hover:bg-secondary/60'}`}
    >
      <GitBranch className={`w-3 h-3 shrink-0 ${picked ? 'text-primary' : 'text-muted-foreground'}`} />
      <span className={`font-mono text-[11.5px] truncate ${picked ? 'text-foreground' : 'text-text-secondary'}`}>{insidePath(project, repo.path)}</span>
      <span className="font-mono text-[10.5px] text-muted-foreground truncate">{repo.branch}</span>
      <span className="flex-1" />
      {repo.error
        ? <span className="font-mono text-[10.5px] text-danger" title={repo.error}>unreadable</span>
        : <span className={`font-mono text-[10.5px] shrink-0 ${changed ? 'text-warning' : 'text-muted-foreground'}`}>{changed ? changedWord(changed) : 'clean'}</span>}
    </button>
  );
}

/** A working tree of a project that is one repository: its branch, and the agents working there. */
function TreeRow({ repo, picked, onPick }: { repo: ReviewRepository; picked: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={picked}
      onClick={onPick}
      className={`w-full text-left px-2.5 py-2 border transition-colors ${picked ? 'bg-secondary border-border-accent' : 'bg-card border-border hover:bg-secondary'}`}
    >
      <span className={`block truncate text-[12.5px] ${picked ? 'text-foreground' : 'text-text-secondary'}`}>{repo.branch || nameOf(repo.path)}</span>
      <span className="block text-[10px] text-muted-foreground truncate mt-0.5">{repo.agents.length ? repo.agents.map((a) => a.name).join(', ') : 'no agent'}</span>
    </button>
  );
}

function ProjectBlock({ project, pick, onPick, onRemove }: {
  project: ProjectView;
  pick: ReviewPick | null;
  onPick: (pick: ReviewPick) => void;
  onRemove: (path: string) => void;
}) {
  const [asking, setAsking] = useState(false);
  const name = nameOf(project.path);
  const repos = project.repositories;
  const changed = repos.filter((r) => r.changed.length > 0).length;
  const pickedRepo = (repo: ReviewRepository) => pick?.kind === 'repo' && pick.repo === repo.path;
  const toRepo = (repo: ReviewRepository) => onPick({ kind: 'repo', project: project.path, repo: repo.path });

  // A project the window's project rule refuses: main's reason, word for word, and nothing of it scanned (frame
  // `Projects · a project the rule refuses · states`).
  if (project.refused) {
    return (
      <div>
        <Caption>{name}</Caption>
        <p className="flex gap-2 text-[11.5px] leading-[1.45] text-danger"><StatusSquare tone="error" className="mt-1 shrink-0" /><span data-review-project-refused>{project.refused}</span></p>
      </div>
    );
  }
  if (project.state === 'gone') {
    return (
      <div>
        <Caption>{name}</Caption>
        <p className="flex gap-2 text-[11.5px] leading-[1.45] text-text-secondary"><StatusSquare tone="waiting" className="mt-1" />{`The folder ${tildePath(project.path)} is gone: moved, renamed or deleted.`}</p>
        {project.custom && !asking && <Button size="sm" className="font-mono mt-2" onClick={() => setAsking(true)}>remove from Tars</Button>}
        {asking && (
          <div role="alertdialog" aria-label={`Remove ${name} from Tars`} className="mt-2 flex items-start gap-2.5 px-3 py-2 bg-secondary border border-border">
            <StatusSquare tone="waiting" className="mt-1" />
            <p className="flex-1 text-[11.5px] leading-[1.45] text-foreground">{`Remove ${name} from Tars? Nothing on your disk changes.`}</p>
            <Button size="sm" className="font-mono" onClick={() => setAsking(false)}>cancel</Button>
            <Button size="sm" className="font-mono" onClick={() => { setAsking(false); onRemove(project.path); }}>remove</Button>
          </div>
        )}
      </div>
    );
  }
  if (project.state === 'unreachable') {
    return (
      <div>
        <Caption>{name}</Caption>
        <p className="flex gap-2 text-[11.5px] leading-[1.45] text-text-secondary"><StatusSquare tone="waiting" className="mt-1" />{`The folder ${tildePath(project.path)} cannot be reached now: a drive that is not there, or no permission to open it.`}</p>
      </div>
    );
  }
  if (project.state === 'no-git') {
    return (
      <div>
        <Caption>{name}</Caption>
        <button
          type="button"
          aria-pressed={pick?.kind === 'no-git' && pick.project === project.path}
          onClick={() => onPick({ kind: 'no-git', project: project.path })}
          className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] text-muted-foreground hover:text-foreground"
        >
          <FolderX className="w-3 h-3 shrink-0" />No git here: not a repository, and none inside.
        </button>
      </div>
    );
  }

  const many = project.state === 'repositories' || (project.state === undefined && repos.length > 1);
  return (
    <div>
      <Caption right={many && changed ? changedWord(changed) : undefined}>{many ? `${name} · ${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}` : name}</Caption>
      {project.scanning && project.state === undefined && (
        <p className="flex gap-2 pb-1.5 text-[11.5px] leading-[1.45] text-text-secondary">
          <StatusSquare tone="waiting" className="mt-1" />
          {project.progress ? progressLine(project.path, project.progress.foldersRead, project.progress.repos) : `Looking through ${tildePath(project.path)}. Each repository shows as it is found.`}
        </p>
      )}
      {project.error && <p className="pb-1.5 text-[11.5px] text-danger">{`Could not read ${name}: ${project.error}`}</p>}
      {project.skipped.map((s) => (
        <p key={s.path} className="pb-1.5 text-[11.5px] leading-[1.45] text-danger">{`Could not open ${tildePath(s.path)}: ${s.why}. It was skipped; the ${repos.length} other ${repos.length === 1 ? 'repository is' : 'repositories are'} listed.`}</p>
      ))}
      <div className={many ? 'space-y-px' : 'space-y-2'}>
        {repos.map((repo) => many
          ? <RepositoryRow key={repo.path} project={project.path} repo={repo} picked={pickedRepo(repo)} onPick={() => toRepo(repo)} />
          : <TreeRow key={repo.path} repo={repo} picked={pickedRepo(repo)} onPick={() => toRepo(repo)} />)}
      </div>
    </div>
  );
}

function ResultRow({ row, picked, onPick }: { row: SearchRow; picked: boolean; onPick: () => void }) {
  const Icon = row.kind === 'repo' ? GitBranch : FileCode2;
  return (
    <button
      type="button"
      aria-pressed={picked}
      onClick={onPick}
      className={`w-full text-left px-2.5 py-2 border ${picked ? 'bg-secondary border-border-accent' : 'border-transparent hover:bg-secondary/60'}`}
    >
      <span className="flex items-center gap-2 min-w-0">
        <Icon className="w-3 h-3 shrink-0 text-muted-foreground" />
        <span className={`font-mono text-[11.5px] truncate ${picked ? 'text-foreground' : 'text-text-secondary'}`}>{row.label}</span>
      </span>
      <span className="block pl-5 font-mono text-[10.5px] text-muted-foreground truncate">{`${row.project} · ${row.branch}`}</span>
    </button>
  );
}

/** Review's left column (frame `Review · projects and their repositories`): the search, then every project. */
export function RepositoryColumn({ projects, search, pick, onSearch, onPick, onRemove }: {
  projects: ProjectView[];
  search: SearchState | null;
  pick: ReviewPick | null;
  onSearch: (query: string) => void;
  onPick: (pick: ReviewPick) => void;
  onRemove: (path: string) => void;
}) {
  const [query, setQuery] = useState('');
  const repoCount = projects.reduce((n, p) => n + p.repositories.length, 0);
  const rowPicked = (row: SearchRow) => pick?.kind === 'repo' && pick.repo === row.repo && (row.kind === 'repo' ? !pick.file : pick.file === row.file);

  return (
    <nav aria-label="Repositories" className="flex flex-col h-full min-h-0">
      <label className="flex items-center gap-2 h-8 px-2.5 bg-secondary border border-border focus-within:border-accent/40">
        <Search className="w-3 h-3 shrink-0 text-muted-foreground" />
        <input
          type="search"
          aria-label="Search every repository and changed file"
          placeholder="Search every repository and changed file"
          value={query}
          onChange={(e) => { setQuery(e.target.value); onSearch(e.target.value); }}
          className="flex-1 min-w-0 bg-transparent text-[12px] text-foreground placeholder:text-muted-foreground outline-none"
        />
        {search && <span className="font-mono text-[10.5px] text-muted-foreground shrink-0">{search.rows.length}</span>}
      </label>

      <div className="flex-1 min-h-0 overflow-y-auto mt-1">
        {search ? (
          <>
            <Caption>Results · every project, no limit</Caption>
            {search.error && <p className="text-[11.5px] text-danger">{`Could not search: ${search.error}`}</p>}
            {search.done && !search.error && search.rows.length === 0 && (
              <p className="text-[11.5px] leading-[1.45] text-muted-foreground">{nothingFoundLine(search.query, repoCount, projects.length)}</p>
            )}
            {search.rows.map((row, i) => (
              <ResultRow
                key={`${row.repo}-${row.kind === 'file' ? row.file : ''}-${i}`}
                row={row}
                picked={rowPicked(row)}
                onPick={() => onPick({ kind: 'repo', project: projects.find((p) => row.repo.startsWith(p.path))?.path ?? row.repo, repo: row.repo, file: row.kind === 'file' ? row.file : undefined })}
              />
            ))}
          </>
        ) : projects.length === 0 ? (
          <>
            <Caption>Working trees</Caption>
            <p className="text-[11.5px] leading-[1.45] text-muted-foreground">No working tree yet. Add a project in Projects, or start an agent in one.</p>
          </>
        ) : (
          projects.map((project) => <ProjectBlock key={project.path} project={project} pick={pick} onPick={onPick} onRemove={onRemove} />)
        )}
      </div>
    </nav>
  );
}
