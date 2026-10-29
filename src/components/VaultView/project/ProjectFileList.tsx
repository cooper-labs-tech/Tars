'use client';

import { Fragment } from 'react';
import { ChevronRight, File, FileCode, FileText, Folder, Link2, Lock, Package } from 'lucide-react';
import { BrandSpinner, Button, PanelCaption, StatusSquare } from '@/components/ui';
import { listTime } from './file-words';
import type { PlaceAnswer, PlaceEntry, ProjectFolder } from './useProjectFolders';

const ICONS = { markdown: FileText, text: FileText, code: FileCode, other: File } as const;

type FolderEntry = Extract<PlaceEntry, { type: 'folder' }>;
const isFolder = (e: PlaceEntry): e is FolderEntry => e.type === 'folder';

/** "3 FOLDERS · 7 FILES"; past a page, folders come first, so the split is known once a file is listed. */
function caption(entries: PlaceEntry[], total: number, more: number): string {
  const folders = entries.filter(isFolder).length;
  const files = entries.length - folders;
  const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
  if (more > 0 && files === 0) return plural(total, 'entry', 'entries').toUpperCase();
  const fileCount = more > 0 ? total - folders : files;
  return `${plural(folders, 'folder', 'folders')} · ${plural(fileCount, 'file', 'files')}`.toUpperCase();
}

/**
 * A folder of a project's folder: its folders, then its files and links newest first, 200 at a time (frame `Vault
 * (2.0.5) · project folders as a tree`, middle column, and the states of `· project folder tree · states`). A folder
 * opens in the tree and here; a tool's cache is named, never opened; a link is said, never followed nor read.
 */
export function ProjectFileList({ folder, place, list, selected, notesMoved, onOpenFolder, onOpen, onMore, onRetry, onShowFolder }: {
  folder: ProjectFolder;
  place: string[];
  list: PlaceAnswer | null;
  selected: string | null;
  /** Where its notes went in 2.0.4 (reports/notes), said under its reports. */
  notesMoved?: string;
  onOpenFolder: (place: string[]) => void;
  onOpen: (entry: PlaceEntry) => void;
  onMore: () => void;
  onRetry: () => void;
  onShowFolder: () => void;
}) {
  const entries = list && 'entries' in list ? list.entries : [];
  const more = list && 'entries' in list ? list.more ?? 0 : 0;
  const total = list && 'entries' in list ? list.total : 0;
  const folderPath = ['~/.tars/project-files', folder.key, ...place].join('/');
  const crumbs = [folder.name, ...place];
  const notesName = notesMoved ? notesMoved.split(/[\\/]/).filter(Boolean).pop() : undefined;
  const unreadable = list !== null && !('entries' in list);

  return (
    <section aria-label="Files" className="flex flex-col h-full min-h-0 p-3.5 gap-1.5">
      <nav aria-label="Folder path" className="flex items-center gap-1 flex-wrap font-mono text-[11px]">
        {crumbs.map((crumb, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="text-muted-foreground">›</span>}
            {i === crumbs.length - 1 ? (
              <span className="text-foreground">{crumb}</span>
            ) : (
              <button type="button" onClick={() => onOpenFolder(place.slice(0, i))} className="text-text-secondary hover:text-foreground">{crumb}</button>
            )}
          </Fragment>
        ))}
      </nav>
      <div className="flex items-center justify-between gap-2 pb-0.5">
        <PanelCaption>{list === null || unreadable ? '' : total === 0 ? 'EMPTY' : caption(entries, total, more)}</PanelCaption>
        {total > 0 && <span className="font-mono text-[10.5px] text-muted-foreground">folders, then newest first</span>}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {list === null ? (
          <div className="flex items-center justify-center py-8"><BrandSpinner size={24} label={`Reading ${crumbs[crumbs.length - 1]}`} /></div>
        ) : !('entries' in list) ? (
          <div role="alert" className="flex items-center gap-2.5 px-2.5 py-2 bg-secondary border border-border">
            <StatusSquare tone="error" />
            <p className="flex-1 text-[11.5px] leading-[1.45] text-foreground">
              {list.code === 'unreadable' ? 'Tars cannot read this folder: permission denied.' : `Tars cannot read this folder: ${list.error}`}
            </p>
            <Button size="sm" className="font-mono" onClick={onRetry}>try again</Button>
          </div>
        ) : entries.length === 0 ? (
          <p className="text-[11.5px] leading-[1.45] text-text-secondary">
            {`This folder is empty. What the agents of ${folder.name} write in it shows here as it is written.`}
          </p>
        ) : (
          <>
            {entries.map((entry) => {
              if (entry.type === 'folder') {
                const Icon = entry.heavy ? Package : entry.error ? Lock : Folder;
                const note = entry.heavy ? 'not opened' : entry.error ? 'cannot be read' : null;
                return (
                  <button
                    key={`d:${entry.name}`}
                    type="button"
                    data-folder-name={entry.name}
                    disabled={!!entry.heavy}
                    onClick={() => onOpenFolder([...place, entry.name])}
                    title={entry.heavy ? "A tool's cache: named, never opened" : entry.error}
                    className="w-full flex items-center gap-2 px-2.5 py-[7px] text-left hover:bg-secondary/60 disabled:hover:bg-transparent disabled:cursor-default"
                  >
                    <Icon className="w-3 h-3 shrink-0 text-muted-foreground" />
                    <span className={`font-mono text-[11.5px] truncate ${note ? 'text-text-secondary' : 'text-foreground'}`}>{entry.name}</span>
                    <span className="flex-1" />
                    {note ? (
                      <span className={`font-mono text-[10px] ${entry.error ? 'text-danger' : 'text-muted-foreground'}`}>{note}</span>
                    ) : (
                      <>
                        <span className="font-mono text-[10.5px] text-muted-foreground">{entry.entries}</span>
                        <ChevronRight className="w-3 h-3 shrink-0 text-muted-foreground" />
                      </>
                    )}
                  </button>
                );
              }
              const link = entry.type === 'link';
              const hardlink = entry.type === 'file' && entry.hardlink;
              const Icon = link || hardlink ? Link2 : ICONS[entry.kind];
              const active = entry.name === selected;
              return (
                <button
                  key={`f:${entry.name}`}
                  type="button"
                  data-file-name={entry.name}
                  aria-pressed={active}
                  onClick={() => onOpen(entry)}
                  className={`w-full flex items-center gap-2 px-2.5 py-[7px] text-left ${active ? 'bg-secondary' : 'hover:bg-secondary/60'}`}
                >
                  <Icon className={`w-3 h-3 shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
                  <span className={`font-mono text-[11.5px] truncate ${active ? 'text-foreground' : link || hardlink ? 'text-text-secondary' : 'text-muted-foreground'}`}>{entry.name}</span>
                  <span className="flex-1" />
                  {(link || hardlink) && <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{link ? 'link · not followed' : 'hard link · not read'}</span>}
                  <span className="w-[76px] shrink-0 text-right font-mono text-[10.5px] text-muted-foreground">{listTime(entry.mtimeMs)}</span>
                </button>
              );
            })}
            {more > 0 && (
              <div className="flex items-center gap-2 px-2.5 py-2 border-t border-border">
                <span className="font-mono text-[11px] text-text-secondary">{`${more.toLocaleString('en-US')} more`}</span>
                <span className="flex-1" />
                <Button size="sm" className="font-mono" onClick={onMore}>{`show ${Math.min(more, 200)} more`}</Button>
              </div>
            )}
          </>
        )}
      </div>

      {place.length === 1 && place[0] === 'reports' && notesName && (
        <div className="flex items-center gap-2.5 px-2.5 py-2 bg-secondary border border-border">
          <StatusSquare tone="idle" />
          <p className="flex-1 text-[11.5px] leading-[1.45] text-muted-foreground">{`Its notes are in reports/${notesName} since 2.0.4.`}</p>
          <Button size="sm" className="font-mono" onClick={() => onOpenFolder(['reports', notesName])}>show notes</Button>
        </div>
      )}

      <div className="flex items-center gap-2 pt-2 border-t border-border">
        <span className="flex-1 min-w-0 font-mono text-[10.5px] text-muted-foreground break-all">{folderPath}</span>
        <Button size="sm" className="font-mono" onClick={onShowFolder}>show folder</Button>
      </div>
    </section>
  );
}
