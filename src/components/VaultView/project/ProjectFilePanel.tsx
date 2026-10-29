'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { BrandSpinner, Button, StatusSquare } from '@/components/ui';
import { SimpleMarkdown } from '../components/MarkdownRenderer';
import { changedAt, clockOf, extensionOf, runnerOf, sizeWords } from './file-words';

type Read = Awaited<ReturnType<NonNullable<NonNullable<Window['electronAPI']>['vault']>['readProjectFile']>>;
type FileRead = Extract<Read, { path: string }>;

/** Numbered lines of a tool or a text, as the frame `Vault · project folders · a tool` shows them. */
function NumberedLines({ text }: { text: string }) {
  const lines = text.replace(/\n$/, '').split('\n');
  return (
    <div className="font-mono text-[11.5px] leading-[1.6] bg-term-bg border border-border px-2.5 py-2 overflow-x-auto">
      {lines.map((line, i) => (
        <div key={i} className="flex gap-3 whitespace-pre">
          <span className="w-7 shrink-0 text-right text-muted-foreground select-none">{i + 1}</span>
          <span className="text-foreground">{line}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * One file of a project's folder, read and edited (frames `Vault · project folders · a report`, `· a report,
 * editing`, `· a tool`, `· states`). A save carries the time the file was opened, so a file an agent changed
 * meanwhile is never written over without the user knowing it.
 */
export function ProjectFilePanel({ projectKey, place, name, names, changes, onOpenFile }: {
  projectKey: string;
  /** Its folder's names from the project's folder (2.0.5, the places of PR 530). */
  place: string[];
  name: string;
  /** The files of the folder: a report's links to them open them here. */
  names: readonly string[];
  /** Bumped when an agent writes in the folder: an open file not being edited reads itself again. */
  changes: number;
  onOpenFile: (name: string) => void;
}) {
  const [read, setRead] = useState<Read | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [mtimeSeen, setMtimeSeen] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [changedBy, setChangedBy] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const editingRef = useRef(false);
  useEffect(() => { editingRef.current = editing; }, [editing]);

  const load = useCallback(async () => {
    const vault = window.electronAPI?.vault;
    if (!vault?.readProjectFile) return;
    const answer = await vault.readProjectFile({ key: projectKey, place, name });
    setRead(answer);
    if ('path' in answer) setMtimeSeen(answer.mtimeMs);
  }, [projectKey, place, name]);

  useEffect(() => {
    setRead(null);
    setEditing(false);
    setSaveError(null);
    setChangedBy(null);
    void load();
  }, [load]);

  // An agent wrote in the folder: what is read follows it; what is being edited waits for its save.
  useEffect(() => {
    if (changes > 0 && !editingRef.current) void load();
  }, [changes, load]);

  if (read === null) {
    return <div className="flex h-full items-center justify-center"><BrandSpinner size={24} label={`Reading ${name}`} /></div>;
  }
  if (!('path' in read)) {
    return <section aria-label="File" className="p-3.5 text-[11.5px] text-danger">{`Could not read ${name}: ${read.error}`}</section>;
  }
  const file: FileRead = read;
  const ext = extensionOf(file.name);
  const isText = file.text !== undefined;
  const dirty = editing && draft !== (file.text ?? '');

  const save = async () => {
    const vault = window.electronAPI?.vault;
    if (!vault?.writeProjectFile || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const answer = await vault.writeProjectFile({ key: projectKey, place, name, text: draft, mtimeSeen });
      if ('ok' in answer) {
        setEditing(false);
        setChangedBy(null);
        await load();
      } else if ('changed' in answer) {
        setChangedBy(answer.mtimeMs ?? Date.now());
      } else {
        setSaveError(answer.error);
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const seeTheirs = async () => {
    setEditing(false);
    setChangedBy(null);
    await load();
  };

  const meta = editing
    ? 'Editing the file on disk. Save writes it; an agent that reads it next gets your version.'
    : !isText
      ? `Not text: ${sizeWords(file.size)}, shown by its name only. Open it from its folder.`
      : file.truncated
        ? `${sizeWords(file.size)}: read here up to its first 200 KB, and edited in your own editor. Show in folder opens it.`
        : file.runnable && runnerOf(file.name)
          ? `An agent runs it from this path: ${runnerOf(file.name)} <path> <command>. Changed ${changedAt(file.mtimeMs)}, ${sizeWords(file.size)}, ${(file.text ?? '').replace(/\n$/, '').split('\n').length} lines.`
          : file.kind === 'markdown'
            ? `Changed ${changedAt(file.mtimeMs)}, ${sizeWords(file.size)}. Markdown shown as text and formatting only: no HTML or script in it runs.`
            : `Changed ${changedAt(file.mtimeMs)}, ${sizeWords(file.size)}, ${(file.text ?? '').replace(/\n$/, '').split('\n').length} lines.`;

  return (
    <section aria-label="File" className="flex flex-col h-full min-h-0 p-3.5 gap-2.5">
      <div className="flex items-center gap-2 min-w-0">
        <h2 className="text-[13px] text-foreground truncate">{file.name}</h2>
        {ext && <span className="h-5 px-1.5 inline-flex items-center bg-secondary border border-border font-mono text-[10px] text-muted-foreground">{ext}</span>}
        {file.runnable && <span className="h-5 px-1.5 inline-flex items-center bg-secondary border border-border font-mono text-[10px] text-muted-foreground">executable</span>}
        <span className="flex-1" />
        {editing ? (
          <>
            {dirty && <span className="flex items-center gap-1.5 text-[11px] text-warning"><StatusSquare tone="waiting" />unsaved</span>}
            <Button size="sm" className="font-mono" onClick={() => { setEditing(false); setChangedBy(null); setSaveError(null); }}>cancel</Button>
            <Button size="sm" variant="primary" disabled={saving} onClick={() => void save()}>save</Button>
          </>
        ) : (
          <>
            <div className="inline-flex h-[26px] border border-border">
              <button type="button" aria-pressed className="px-2.5 bg-secondary border border-border-accent font-mono text-[11px] text-foreground">read</button>
              <button
                type="button"
                aria-pressed={false}
                disabled={!file.editable}
                onClick={() => { setDraft(file.text ?? ''); setMtimeSeen(file.mtimeMs); setEditing(true); }}
                className="px-2.5 font-mono text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed"
              >
                edit
              </button>
            </div>
            <Button size="sm" className="font-mono" onClick={() => { void navigator.clipboard?.writeText(file.path); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
              {copied ? 'copied' : 'copy path'}
            </Button>
            <Button size="sm" className="font-mono" onClick={() => void window.electronAPI?.vault?.showProjectFile({ key: projectKey, place, name })}>show in folder</Button>
          </>
        )}
      </div>

      <div className="px-2.5 py-1.5 bg-background border border-border font-mono text-[11px] text-foreground break-all">{file.path}</div>
      <p className="text-[11px] leading-[1.45] text-muted-foreground">{meta}</p>

      {changedBy !== null && (
        <div role="alert" className="flex items-center gap-3 px-3 py-2 bg-secondary border border-border">
          <StatusSquare tone="waiting" />
          <p className="flex-1 text-[12px] text-foreground">{`An agent changed this file at ${clockOf(changedBy)}, after you opened it. Saving now would replace its version.`}</p>
          <Button size="sm" className="font-mono" onClick={() => void seeTheirs()}>see its version</Button>
          <Button size="sm" className="font-mono" onClick={() => { setMtimeSeen(changedBy); setChangedBy(null); }}>keep mine</Button>
        </div>
      )}
      {saveError !== null && (
        <div role="alert" className="flex items-center gap-3 px-3 py-2 border border-danger/40">
          <StatusSquare tone="error" />
          <p className="flex-1 text-[12px] text-foreground">{`Could not save: ${saveError} on ${file.name}. Your text is still here; nothing on disk changed.`}</p>
          <Button size="sm" className="font-mono" onClick={() => void save()}>try again</Button>
        </div>
      )}

      <div className="h-px bg-border" />
      <div className="flex-1 min-h-0 overflow-y-auto">
        {editing ? (
          <textarea
            aria-label={`Edit ${file.name}`}
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            className="w-full h-full min-h-[320px] resize-none bg-term-bg border border-accent/40 p-2.5 font-mono text-[12px] leading-[1.6] text-foreground outline-none"
          />
        ) : !isText ? null : file.kind === 'markdown' && !file.truncated ? (
          <SimpleMarkdown content={file.text ?? ''} links={{ names, openFile: onOpenFile }} />
        ) : (
          <NumberedLines text={file.text ?? ''} />
        )}
      </div>
    </section>
  );
}
