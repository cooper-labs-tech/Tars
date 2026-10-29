'use client';

import type { KeyboardEvent, ReactNode } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderOpen, Lock, Package } from 'lucide-react';
import { BrandSpinner, PanelCaption } from '@/components/ui';
import { placeId, type PlaceAnswer, type PlaceEntry, type ProjectFolder, type ProjectPlace } from './useProjectFolders';

/** 10 px, then 16 a level, as the frame nests them. */
const indent = (depth: number) => ({ paddingLeft: 10 + depth * 16 });

/**
 * The projects' folders above the Vault's documents, as a tree (frame `Vault (2.0.5) · project folders as a tree`, left
 * column, and the states of `· project folder tree · states`): every folder of each project's folder, opened one level
 * at a time by its chevron, a click on it or the right arrow (the left closes it), with how many entries it holds. A
 * tool's cache (heavy) is named and never opened; a folder that cannot be read says so; past 200 folders, "N more".
 * The folder chosen is a box, never an accent rule.
 */
export function ProjectFolders({ folders, place, levels, open, onToggle, onChoose, onMore }: {
  folders: ProjectFolder[];
  place: ProjectPlace | null;
  levels: Record<string, PlaceAnswer>;
  open: ReadonlySet<string>;
  onToggle: (at: ProjectPlace, force?: boolean) => void;
  onChoose: (at: ProjectPlace) => void;
  onMore: (at: ProjectPlace) => void;
}) {
  const chosen = place ? placeId(place.key, place.place) : null;

  const keys = (at: ProjectPlace) => (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); onToggle(at, true); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); onToggle(at, false); }
  };

  /** A folder's own folders, as the tree shows them once it is open. */
  const level = (key: string, at: string[], depth: number): ReactNode => {
    const answer = levels[placeId(key, at)];
    if (!answer) {
      return <div className="h-[30px] flex items-center" style={indent(depth + 1)}><BrandSpinner size={14} label="Reading" /></div>;
    }
    if (!('entries' in answer)) {
      return <p className="py-1.5 pr-3 text-[11px] text-danger" style={indent(depth + 1)}>{`Cannot be read: ${answer.error}`}</p>;
    }
    const shownFolders = answer.entries.filter((e): e is Extract<PlaceEntry, { type: 'folder' }> => e.type === 'folder');
    return (
      <>
        {shownFolders.map((entry) => row(key, [...at, entry.name], entry, depth + 1))}
        {answer.more ? (
          <button
            type="button"
            onClick={() => onMore({ key, place: at })}
            className="w-full h-[30px] flex items-center pr-3 text-left font-mono text-[10.5px] text-text-secondary hover:text-foreground"
            style={{ paddingLeft: 10 + (depth + 1) * 16 + 20 }}
          >
            {`${answer.more} more`}
          </button>
        ) : null}
      </>
    );
  };

  const row = (key: string, at: string[], entry: Extract<PlaceEntry, { type: 'folder' }>, depth: number): ReactNode => {
    const id = placeId(key, at);
    const name = at[at.length - 1];
    if (entry.heavy) {
      return (
        <div key={id} data-tree-folder={at.join('/')} className="h-[30px] flex items-center gap-2 pr-3 text-[12px]" style={indent(depth)} title="A tool's cache: named, never opened">
          <span className="w-3 shrink-0" />
          <Package className="w-3 h-3 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-text-secondary">{name}</span>
          <span className="flex-1" />
          <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground">not opened</span>
        </div>
      );
    }
    const active = chosen === id;
    if (entry.error) {
      return (
        <button
          key={id}
          type="button"
          data-tree-folder={at.join('/')}
          aria-pressed={active}
          onClick={() => onChoose({ key, place: at })}
          className={`w-full h-[30px] flex items-center gap-2 pr-3 text-left text-[12px] ${active ? 'bg-secondary' : 'hover:bg-secondary/60'}`}
          style={indent(depth)}
          title={entry.error}
        >
          <span className="w-3 shrink-0" />
          <Lock className="w-3 h-3 shrink-0 text-muted-foreground" />
          <span className="truncate text-text-secondary">{name}</span>
          <span className="flex-1" />
          <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-danger">cannot be read</span>
        </button>
      );
    }
    const expanded = open.has(id);
    const Chevron = expanded ? ChevronDown : ChevronRight;
    const Icon = active || expanded ? FolderOpen : Folder;
    return (
      <div key={id}>
        <div className={`h-[30px] flex items-center gap-2 pr-3 text-[12px] ${active ? 'bg-secondary' : 'hover:bg-secondary/60'}`} style={indent(depth)}>
          <button type="button" aria-label={`${expanded ? 'Close' : 'Open'} ${name}`} aria-expanded={expanded} onClick={() => onToggle({ key, place: at })} className="shrink-0 text-muted-foreground hover:text-foreground">
            <Chevron className="w-3 h-3" />
          </button>
          <button
            type="button"
            data-tree-folder={at.join('/')}
            aria-pressed={active}
            onClick={() => onChoose({ key, place: at })}
            onKeyDown={keys({ key, place: at })}
            className="flex-1 min-w-0 h-full flex items-center gap-2 text-left"
          >
            <Icon className={`w-3 h-3 shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
            <span className="truncate flex-1 text-foreground">{name}</span>
            {entry.entries !== undefined && <span className="font-mono text-[10.5px] text-muted-foreground">{entry.entries}</span>}
          </button>
        </div>
        {expanded && level(key, at, depth)}
      </div>
    );
  };

  return (
    <nav aria-label="Project folders" className="pb-2">
      <PanelCaption className="px-3 pt-3 pb-2">{`Projects · ${folders.length}`}</PanelCaption>
      {folders.length === 0 && (
        <p className="px-3 text-[11.5px] leading-[1.45] text-muted-foreground">
          No project folder yet. Each project gets one the first time an agent starts in it, with reports and tools: ~/.tars/project-files/&lt;project&gt;.
        </p>
      )}
      {folders.map((folder) => {
        const at = { key: folder.key, place: [] as string[] };
        const expanded = open.has(placeId(folder.key, []));
        const Chevron = expanded ? ChevronDown : ChevronRight;
        return (
          <div key={folder.key}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => onToggle(at)}
              onKeyDown={keys(at)}
              className="w-full h-[30px] flex items-center gap-2 px-3 text-left text-[12px] text-muted-foreground hover:text-foreground"
            >
              <Chevron className="w-3 h-3 shrink-0" />
              <span className="truncate flex-1 text-foreground">{folder.name}</span>
            </button>
            {expanded && level(folder.key, [], 0)}
          </div>
        );
      })}
    </nav>
  );
}
