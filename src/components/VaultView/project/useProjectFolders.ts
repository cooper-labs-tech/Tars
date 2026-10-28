'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Each project's folder in the Vault, every folder of it (2.0.5, vault.projectPlace of PR 530; frames `Vault (2.0.5) ·
 * project folders as a tree` and `· project folder tree · states`): the projects, the folders the tree has opened, one
 * level at a time, the folder chosen with its entries 200 at a time, and what the agents write meanwhile
 * (vault.onProjectFilesChanged, which names the folder), so the tree, the list and an open file follow them. A file is
 * named by its folder's key, its place (the folder names from the project's folder) and its name, never a path.
 */

type VaultApi = NonNullable<NonNullable<Window['electronAPI']>['vault']>;
export type ProjectFolder = Awaited<ReturnType<VaultApi['projectFolders']>>['folders'][number];
export type PlaceAnswer = Awaited<ReturnType<VaultApi['projectPlace']>>;
export type PlaceList = Extract<PlaceAnswer, { entries: unknown }>;
export type PlaceEntry = PlaceList['entries'][number];
export interface ProjectPlace { key: string; place: string[] }

/** A folder's id in the tree and the cache: its project and its place. */
export const placeId = (key: string, place: readonly string[]) => [key, ...place].join('\u0000');
const samePlace = (a: ProjectPlace | null, b: ProjectPlace) => !!a && a.key === b.key && placeId(a.key, a.place) === placeId(b.key, b.place);

/** A folder's notes moved into reports in 2.0.4 are said only by the listing that moved them: kept here per key. */
const NOTES_KEY = 'vault-notes-moved';

function readNotes(): Record<string, string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTES_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
}

function keepNotes(notes: Record<string, string>) {
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  } catch { /* the notice is a convenience: without storage it shows once */ }
}

/** Two pages of one folder as one: the next page's entries after the first's. */
function joinPages(first: PlaceAnswer, next: PlaceAnswer): PlaceAnswer {
  if (!('entries' in first) || !('entries' in next)) return next;
  return { ...next, offset: first.offset, entries: [...first.entries, ...next.entries] };
}

export function useProjectFolders(enabled: boolean) {
  const [folders, setFolders] = useState<ProjectFolder[]>([]);
  const [place, setPlace] = useState<ProjectPlace | null>(null);
  /** The selected folder's entries, the pages asked so far joined. */
  const [list, setList] = useState<PlaceAnswer | null>(null);
  /** Every folder the tree has opened, by placeId: its first pages, as the tree shows them. */
  const [levels, setLevels] = useState<Record<string, PlaceAnswer>>({});
  /** The folders open in the tree, by placeId; a project is open when placeId(key, []) is. Kept until Tars quits. */
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [notes, setNotes] = useState<Record<string, string>>({});
  /** Bumped each time an agent writes in the folder chosen: the open file reads itself again. */
  const [changes, setChanges] = useState(0);
  const placeRef = useRef<ProjectPlace | null>(null);
  const openRef = useRef(open);
  const listRef = useRef(list);
  const levelsRef = useRef(levels);
  // Before the effects that read them: an answer that comes late for a place left is dropped.
  useEffect(() => { placeRef.current = place; }, [place]);
  useEffect(() => { openRef.current = open; }, [open]);
  useEffect(() => { listRef.current = list; }, [list]);
  useEffect(() => { levelsRef.current = levels; }, [levels]);

  const ask = useCallback(async (at: ProjectPlace, offset = 0, limit?: number): Promise<PlaceAnswer | null> => {
    const vault = window.electronAPI?.vault;
    if (!vault?.projectPlace) return null;
    return vault.projectPlace({ key: at.key, place: at.place, offset, ...(limit ? { limit } : {}) });
  }, []);

  const loadFolders = useCallback(async () => {
    const vault = window.electronAPI?.vault;
    if (!vault?.projectFolders) return;
    const { folders: found } = await vault.projectFolders();
    setFolders(found);
    const moved = found.filter((f) => f.notesMoved);
    if (moved.length > 0) {
      const next = { ...readNotes() };
      for (const f of moved) next[f.key] = f.notesMoved as string;
      keepNotes(next);
      setNotes(next);
    }
  }, []);

  /** A folder of the tree read again, as many entries as it showed. */
  const loadLevel = useCallback(async (at: ProjectPlace, shown?: number) => {
    const answer = await ask(at, 0, shown && shown > 200 ? Math.min(shown, 1000) : undefined);
    if (answer) setLevels((prev) => ({ ...prev, [placeId(at.key, at.place)]: answer }));
  }, [ask]);

  /** The selected folder read again, as many entries as the list shows. */
  const loadList = useCallback(async (at: ProjectPlace, shown?: number) => {
    const answer = await ask(at, 0, shown && shown > 200 ? Math.min(shown, 1000) : undefined);
    if (answer && samePlace(placeRef.current, at)) setList(answer);
  }, [ask]);

  useEffect(() => {
    if (!enabled) return;
    setNotes(readNotes());
    void loadFolders();
  }, [enabled, loadFolders]);

  useEffect(() => {
    if (!place) return;
    setList(null);
    void loadList(place);
  }, [place, loadList]);

  /** Opens or closes a folder (or a project) in the tree; opened, its level is read. */
  const toggle = useCallback((at: ProjectPlace, force?: boolean) => {
    const id = placeId(at.key, at.place);
    const opening = force ?? !openRef.current.has(id);
    setOpen((prev) => {
      const next = new Set(prev);
      if (opening) next.add(id); else next.delete(id);
      return next;
    });
    if (opening) void loadLevel(at);
  }, [loadLevel]);

  /** Chooses a folder: the list shows it, and the tree opens it and every folder above it. */
  const choose = useCallback((at: ProjectPlace) => {
    setPlace(at);
    for (let depth = 0; depth <= at.place.length; depth++) {
      const above = { key: at.key, place: at.place.slice(0, depth) };
      if (!openRef.current.has(placeId(above.key, above.place))) toggle(above, true);
    }
  }, [toggle]);

  /** The next 200 entries of the list. */
  const moreOfList = useCallback(async () => {
    const at = placeRef.current;
    const shown = listRef.current;
    if (!at || !shown || !('entries' in shown)) return;
    const next = await ask(at, shown.offset + shown.entries.length);
    if (next && samePlace(placeRef.current, at)) setList((prev) => (prev ? joinPages(prev, next) : next));
  }, [ask]);

  /** The next 200 folders of a level of the tree. */
  const moreOfLevel = useCallback(async (at: ProjectPlace) => {
    const id = placeId(at.key, at.place);
    const level = levelsRef.current[id];
    if (!level || !('entries' in level)) return;
    const next = await ask(at, level.offset + level.entries.length);
    if (next) setLevels((prev) => ({ ...prev, [id]: prev[id] ? joinPages(prev[id], next) : next }));
  }, [ask]);

  useEffect(() => {
    const vault = window.electronAPI?.vault;
    if (!enabled || !vault?.onProjectFilesChanged) return;
    return vault.onProjectFilesChanged(({ key, place: changed }) => {
      void loadFolders();
      // The folder written in, and its parent, whose count moved: read again where the tree shows them.
      for (const at of [{ key, place: changed }, { key, place: changed.slice(0, -1) }]) {
        if (openRef.current.has(placeId(at.key, at.place))) void loadLevel(at);
      }
      const chosen = placeRef.current;
      if (chosen && chosen.key === key && placeId(key, chosen.place) === placeId(key, changed)) {
        const shown = listRef.current;
        void loadList(chosen, shown && 'entries' in shown ? shown.entries.length : undefined);
        setChanges((n) => n + 1);
      }
    });
  }, [enabled, loadFolders, loadLevel, loadList]);

  const refresh = useCallback(async () => {
    await loadFolders();
    for (const id of openRef.current) {
      const [key, ...rest] = id.split('\u0000');
      await loadLevel({ key, place: rest });
    }
    if (placeRef.current) await loadList(placeRef.current);
    setChanges((n) => n + 1);
  }, [loadFolders, loadLevel, loadList]);

  const leave = useCallback(() => setPlace(null), []);

  return { folders, place, choose, leave, list, levels, open, toggle, moreOfList, moreOfLevel, notes, changes, refresh };
}
