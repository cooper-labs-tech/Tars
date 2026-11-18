'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dropdown, Input, PanelCaption } from '@/components/ui';
import type { TracePair } from '@/types/electron';
import { Notice, Unread } from '@/components/Resources/bits';
import { StateLine } from './bits';
import { tracesApi } from './hooks';

const HARNESSES = ['codex', 'pi', 'qwen-code', 'opencode'];
const COLS = 'grid grid-cols-[150px_240px_minmax(0,1fr)_90px] gap-3 items-center px-3';

const pairWords = (p: TracePair) => `${p.harness} · ${p.models}`;

/**
 * Traces · who may be traced: the owner's list of harness and model pairs whose sessions may be recorded. The
 * window reads and writes it (traces.pairs, addPair, removePair, importPairs from a file the owner picks); an agent
 * does not. It starts empty. Above it, the closed models: not recorded while Settings keeps that default on, in
 * main's words when it is off (closedModelsWarning). Frames: `Traces · who may be traced` and its states.
 */
export function PairsView() {
  const router = useRouter();
  const [pairs, setPairs] = useState<TracePair[] | null>(null);
  const [exclude, setExclude] = useState(true);
  const [warning, setWarning] = useState('');
  const [imported, setImported] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [harness, setHarness] = useState('');
  const [models, setModels] = useState('');
  const [note, setNote] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [removed, setRemoved] = useState<TracePair | null>(null);


  const read = useCallback(async () => {
    const api = tracesApi();
    if (!api) return;
    try {
      const view = await api.pairs();
      setPairs(view.pairs);
      setExclude(view.excludeClosedModels);
      setWarning(view.closedModelsWarning);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void read(); }, [read]);

  const duplicate = !!pairs?.some(p => p.harness === harness && p.models === models.trim());
  const add = async () => {
    const api = tracesApi();
    if (!api || !harness || !models.trim() || duplicate) return;
    const r = await api.addPair({ harness, models: models.trim(), ...(note.trim() ? { note: note.trim() } : {}) });
    if (!r.ok) { setRefusal(r.error); return; }
    setPairs(r.pairs);
    setRefusal(null);
    setHarness(''); setModels(''); setNote('');
  };

  const remove = async (pair: TracePair) => {
    const api = tracesApi();
    if (!api) return;
    const r = await api.removePair({ harness: pair.harness, models: pair.models });
    if (!r.ok) { setRefusal(r.error); return; }
    setPairs(r.pairs);
    setRemoved(pair);
  };

  const undo = async () => {
    const api = tracesApi();
    if (!api || !removed) return;
    const r = await api.addPair(removed);
    if (!r.ok) { setRefusal(r.error); return; }
    setPairs(r.pairs);
    setRemoved(null);
  };

  const importFile = async () => {
    const api = tracesApi();
    if (!api) return;
    const r = await api.importPairs();
    if (!r.ok) { if (!r.cancelled) setRefusal(`Nothing was imported: ${r.error}. Your list is unchanged.`); return; }
    setPairs(r.pairs);
    setRefusal(null);
    setImported(r.added === 0 ? 'Every pair of the file was already on your list.' : `${r.added} pair${r.added === 1 ? '' : 's'} added from the file. Nothing was removed.`);
  };

  if (error) return <Unread text="could not read the list:" detail={error} onRetry={() => { void read(); }} />;

  return (
    <div className="flex flex-col gap-2.5 flex-1 min-h-0 overflow-y-auto">
      <div role="note" data-closed-models={exclude ? 'excluded' : 'allowed'} className={`px-3.5 py-3 bg-secondary border ${exclude ? 'border-border' : 'border-border-accent'} space-y-1.5`}>
        <div className="flex items-center gap-3">
          <StateLine word={exclude ? 'closed models are not recorded: a default you can change' : 'closed models may be recorded: Never record closed models is off'} tone={exclude ? 'idle' : 'waiting'} />
          <span className="flex-1" />
          <Button size="sm" variant="ghost" className="font-mono" onClick={() => router.push('/settings?section=inference-endpoints')}>open Settings</Button>
        </div>
        <p className="text-xs leading-relaxed text-foreground">
          {exclude
            ? 'A model whose id names Claude, GPT, an o-series model or Gemini is not recorded, whatever this list says, while Settings, Inference endpoints, keeps Never record closed models on.'
            : `${warning || "Their providers' terms may forbid training on their outputs."} A pair on this list now records them too.`}
        </p>
      </div>

      {imported && <Notice tone="running" actions={<Button size="sm" variant="ghost" className="font-mono" onClick={() => setImported(null)}>close</Button>}>{imported}</Notice>}

      {removed && (
        <Notice tone="waiting" actions={<Button size="sm" className="font-mono" onClick={() => { void undo(); }}>undo</Button>}>
          {`${pairWords(removed)} removed: its agents record nothing from their next session. Their recorded sessions stay in Traces.`}
        </Notice>
      )}

      <section role="region" aria-label="Who may be traced" className="border border-border bg-card">
        <div className="flex items-start gap-3 px-3.5 pt-3 pb-2">
          <div className="min-w-0 flex-1 space-y-1">
            <PanelCaption>WHO MAY BE TRACED</PanelCaption>
            <p className="max-w-[760px] text-[11.5px] leading-relaxed text-text-secondary">
              A session is recorded only for a harness and a model on this list, on an endpoint that allows traces, in a project and for an agent that record them. The list starts empty: nothing is recorded until you add a pair.
            </p>
            <p className="font-mono text-[10.5px] text-muted-foreground">models is a glob: * is any model, qwen3-* every id that starts with qwen3-.</p>
          </div>
          <Button size="sm" onClick={() => { void importFile(); }}>Import from a file</Button>
        </div>

        <div className={`${COLS} h-[30px] border-y border-border font-mono text-[10px] text-muted-foreground`}>
          <span>HARNESS</span><span>MODELS</span><span>NOTE</span><span />
        </div>
        {pairs === null ? (
          <p className="px-3 py-2.5 font-mono text-[10.5px] text-muted-foreground">reading the list</p>
        ) : pairs.length === 0 ? (
          <div className="px-3 py-3 border-b border-border">
            <StateLine word="no pair yet: nothing is recorded. Add a harness and a model glob, or import a list from a file." tone="idle" />
          </div>
        ) : pairs.map((p, i) => (
          <div key={`${p.harness}-${p.models}-${i}`} data-trace-pair={pairWords(p)} className={`${COLS} h-9 border-b border-border`}>
            <span className="font-mono text-[11.5px] text-foreground truncate">{p.harness}</span>
            <span className="font-mono text-[11.5px] text-text-secondary truncate">{p.models}</span>
            <span className="text-[11.5px] text-muted-foreground truncate">{p.note ?? ''}</span>
            <span className="flex justify-end"><Button size="sm" variant="ghost" className="font-mono" onClick={() => { void remove(p); }}>remove</Button></span>
          </div>
        ))}

        <div className="flex items-center gap-2 px-3 py-2.5">
          <Dropdown size="sm" mono="trigger" ariaLabel="Harness" placeholder="harness" className="w-[150px]" value={harness}
            options={HARNESSES.map(h => ({ value: h, label: h }))} onChange={h => { setHarness(h); setRefusal(null); }} />
          <Input aria-label="Models" mono compact className="w-[240px]" width="full" placeholder="models: * or a glob, qwen3-*" value={models} error={!!refusal}
            onChange={e => { setModels(e.target.value); setRefusal(null); }} />
          <Input aria-label="Note" compact placeholder="a note, optional" value={note} onChange={e => setNote(e.target.value)} />
          <Button size="sm" className="font-mono shrink-0" disabled={!harness || !models.trim() || duplicate} onClick={() => { void add(); }}>add the pair</Button>
        </div>
        {(refusal || duplicate) && (
          <p className={`px-3 pb-2.5 font-mono text-[10.5px] ${refusal ? 'text-status-error' : 'text-status-waiting'}`}>
            {refusal ?? `${harness} · ${models.trim()} is already on the list.`}
          </p>
        )}
        <div className="px-3 py-2 border-t border-border font-mono text-[10.5px] text-muted-foreground">
          {pairs ? `${pairs.length} pair${pairs.length === 1 ? '' : 's'}` : ''}
        </div>
      </section>

    </div>
  );
}
