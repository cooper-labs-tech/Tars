'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, FieldError, Input, PasswordInput, StatusSquare } from '@/components/ui';
import type { StatusTone } from '@/components/ui';
import type { EndpointView, EndpointWait } from '@/types/electron';
import { useEndpoints } from '@/hooks/useEndpoints';
import { useUnsavedNote } from '@/components/Traces/hooks';
import { clauseOf, clockOf, clockSecondsOf, healthOf, modelsLineOf, usedByOf } from '@/lib/traces-format';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';
import { Toggle } from './Toggle';

const DEFAULT_HOLD = 120;

/** A state word in its tone, with its square: the frames' `state` line. */
const State = ({ word, tone }: { word: string; tone: StatusTone }) => (
  <span className={`flex items-center gap-1.5 font-mono text-[10.5px] ${tone === 'idle' ? 'text-muted-foreground' : `text-status-${tone}`}`}>
    <StatusSquare tone={tone} />
    <span className="truncate">{word}</span>
  </span>
);

/** A boxed line under an endpoint, with its answers: approval, removal. */
const Notice = ({ children, answers, danger }: { children: React.ReactNode; answers: React.ReactNode; danger?: boolean }) => (
  <div data-endpoint-notice className={`mt-2 px-3.5 py-3 bg-secondary border ${danger ? 'border-danger/40' : 'border-border-accent'} space-y-2.5`}>
    <div className="text-xs leading-snug text-foreground space-y-1">{children}</div>
    <div className="flex items-center gap-2">{answers}</div>
  </div>
);

function waitWord(waits: EndpointWait[]): string {
  const last = waits[0];
  const status = last.lastStatus ? `busy (${last.lastStatus})` : 'not reached';
  const next = last.nextTryAt ? ` · next try ${clockSecondsOf(last.nextTryAt)}` : '';
  return `${status} · holding ${waits.length} request${waits.length === 1 ? '' : 's'}${next}`;
}

/**
 * Settings > AI & Providers > Inference endpoints: OpenAI-compatible servers an open harness runs on, through
 * Tars. A key goes to ~/.tars-private through endpoints.setKey and never comes back: the window learns only
 * `keySet`. An endpoint an agent added, or whose base URL an agent changed, waits for the owner's approval here.
 * Frames: `Settings · Inference endpoints`, `· states`, and their light copies.
 */
export const InferenceEndpointsSection = () => {
  const router = useRouter();
  const { endpoints, waits, error, changedBy, reload, api } = useEndpoints();
  const [form, setForm] = useState<{ id?: string } | null>(null);
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  /** The removal asked, refused while agents run on it, or refused by main for a reason of its own (settings not saved). */
  const [removing, setRemoving] = useState<{ id: string; refusedBy?: string[]; error?: string } | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  /** Traces turned off for an endpoint, held by main and not written yet: main's words under its row until it is. */
  const [rowUnsaved, setRowUnsaved] = useUnsavedNote<{ id: string; word: string }>();
  /** An endpoint removed, held by main and not written yet: its row is gone, so main's words go above the list. */
  const [removeUnsaved, setRemoveUnsaved] = useUnsavedNote();

  const list = endpoints ?? [];
  const editing = form?.id ? list.find(e => e.id === form.id) : undefined;

  const check = async (id: string) => {
    if (!api) return;
    setChecking(c => ({ ...c, [id]: true }));
    try { await api.check(id); } finally {
      setChecking(c => ({ ...c, [id]: false }));
      void reload();
    }
  };

  const setAllowTraces = async (e: EndpointView) => {
    if (!api) return;
    let r: Awaited<ReturnType<typeof api.save>>;
    try {
      r = await api.save({ id: e.id, name: e.name, baseUrl: e.baseUrl, allowTraces: !e.allowTraces, holdMaxSeconds: e.holdMaxSeconds, sendSessionHeaders: e.sendSessionHeaders, allowPlainHttp: e.allowPlainHttp });
    } catch (err) {
      setRowError(m => ({ ...m, [e.id]: err instanceof Error ? err.message : String(err) }));
      return;
    }
    setRowError(m => ({ ...m, [e.id]: r.ok ? '' : r.error }));
    // Traces turned off apply at once; when main could not write it yet, its words say so under the row.
    if (r.ok) setRowUnsaved(r.unsaved ? { id: e.id, word: r.unsaved } : null);
    void reload();
  };

  const askRemove = (e: EndpointView) => {
    setRemoving(e.agents.length > 0 ? { id: e.id, refusedBy: e.agents.map(a => a.name) } : { id: e.id });
  };

  const remove = async (id: string) => {
    if (!api) return;
    let r: Awaited<ReturnType<typeof api.remove>>;
    try {
      r = await api.remove(id);
    } catch (err) {
      setRemoving({ id, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    // A removal applies at once; when main could not write it yet, its words go above the list (the row is gone).
    if (r.ok) { setRemoving(null); setRemoveUnsaved(r.unsaved ?? null); }
    // No agent on it: main's own reason (a full disk, an endpoint already gone), never the plain question again.
    else if (r.agents && r.agents.length > 0) setRemoving({ id, refusedBy: r.agents });
    else setRemoving({ id, error: r.error });
    void reload();
  };

  const approve = async (id: string) => {
    if (!api) return;
    const r = await api.approve(id);
    setRowError(m => ({ ...m, [id]: r.ok ? '' : r.error }));
    void reload();
  };

  const putBack = async (e: EndpointView) => {
    if (!api || !e.approvedBaseUrl) return;
    const r = await api.save({ id: e.id, name: e.name, baseUrl: e.approvedBaseUrl, allowTraces: e.allowTraces, holdMaxSeconds: e.holdMaxSeconds, sendSessionHeaders: e.sendSessionHeaders, allowPlainHttp: e.allowPlainHttp });
    setRowError(m => ({ ...m, [e.id]: r.ok ? '' : r.error }));
    void reload();
  };

  return (
    <SettingsCard>
      {error && (
        <div data-settings-row className="px-4 py-[11px]">
          <State word={error} tone="error" />
        </div>
      )}

      <SettingsRow
        wrap
        label="Inference endpoints"
        description={
          <>
            <span className="block">OpenAI-compatible servers: a remote inference host, a vLLM or an Ollama of your own. An open harness (Codex, Pi, Qwen Code, opencode) runs on the model you pick for each agent, through Tars.</span>
            <span className="block">A key goes with Tars&apos;s other secrets, in ~/.tars-private: no agent gets it, and the window never gets it back.</span>
          </>
        }
        control={
          <Button size="sm" className="font-mono lowercase" disabled={!api} onClick={() => setForm({})}>
            add an endpoint
          </Button>
        }
      />

      <ClosedModelsRow />

      {removeUnsaved && (
        <div data-endpoint-remove-unsaved className="px-4 py-[11px]">
          <State word={removeUnsaved} tone="waiting" />
        </div>
      )}

      {list.map(e => {
        const own = waits.filter(w => w.endpointId === e.id);
        const health = own.length > 0 ? { word: waitWord(own), tone: 'waiting' as StatusTone } : healthOf(e.health, checking[e.id]);
        const baseUrlWaits = !e.approved && !!e.approvedBaseUrl && e.approvedBaseUrl !== e.baseUrl;
        const state = !e.approved
          ? { word: baseUrlWaits ? 'new base URL waiting for your approval' : 'waiting for your approval', tone: 'waiting' as StatusTone }
          : health;
        const read = e.modelsReadAt ? ` · read ${clockOf(e.modelsReadAt)}` : '';
        const by = changedBy[e.id];
        return (
          <div key={e.id} data-endpoint={e.name} className="px-4 py-[11px]">
            <div className="flex items-center gap-4">
              <div className="w-[330px] shrink-0 min-w-0 space-y-0.5">
                <button type="button" className="text-[12.5px] text-foreground hover:underline cursor-pointer truncate max-w-full text-left" onClick={() => setForm({ id: e.id })}>
                  {e.name}
                </button>
                <State word={state.word} tone={state.tone} />
                <p className="font-mono text-[10.5px] text-muted-foreground truncate">{e.plainHttp ? `${e.baseUrl} · unencrypted` : e.baseUrl}</p>
                <p className="font-mono text-[10.5px] text-muted-foreground">{`${e.keySet ? 'a key is set · never shown' : e.changedBy && !e.approved ? 'key to set again: it went with the old address' : 'no key'}${e.sendSessionHeaders ? ' · session headers sent' : ''}`}</p>
                <p className="font-mono text-[10.5px] text-muted-foreground truncate">{usedByOf(e.agents)}</p>
              </div>
              <div className="w-[250px] shrink-0 min-w-0 space-y-0.5">
                {e.modelsError ? (
                  <>
                    <p className="font-mono text-[10.5px] text-status-waiting">{`models not read: ${e.modelsError}`}</p>
                    <p className="font-mono text-[10.5px] text-muted-foreground">{`the last list is kept: ${modelsLineOf(e.models)}`}</p>
                  </>
                ) : (
                  <>
                    <p className="font-mono text-[10.5px] text-text-secondary">{`${e.models.length} model${e.models.length === 1 ? '' : 's'}${read}`}</p>
                    <p className="font-mono text-[10.5px] text-muted-foreground">{modelsLineOf(e.models)}</p>
                  </>
                )}
              </div>
              <div className="flex-1" />
              <div className="flex items-center gap-2 shrink-0">
                <span className="font-mono text-[10.5px] text-muted-foreground">allows traces</span>
                <Toggle label={`${e.name} allows traces`} enabled={e.allowTraces} onChange={() => { void setAllowTraces(e); }} />
                <Button size="sm" className="font-mono lowercase" onClick={() => { void check(e.id); }} disabled={checking[e.id]}>check</Button>
                <Button size="sm" className="font-mono lowercase" onClick={() => askRemove(e)}>remove</Button>
              </div>
            </div>

            {rowError[e.id] && <p data-endpoint-row-error className="mt-2 font-mono text-[10.5px] text-status-error">{rowError[e.id]}</p>}
            {rowUnsaved?.id === e.id && <div data-endpoint-unsaved className="mt-2"><State word={rowUnsaved.word} tone="waiting" /></div>}

            {by && !e.allowTraces && (
              <p className="mt-2 font-mono text-[10.5px] text-status-waiting">
                {`Changed by ${by.agentName} at ${clockOf(by.at)}. Recording stopped for its agents; the sessions already recorded stay in Traces. Only you can turn traces on again.`}
              </p>
            )}

            {!e.approved && !baseUrlWaits && (
              <Notice answers={<>
                <Button size="sm" variant="primary" className="font-mono lowercase" onClick={() => { void approve(e.id); }}>approve</Button>
                <Button size="sm" className="font-mono lowercase" onClick={() => askRemove(e)}>remove</Button>
              </>}>
                <p>{`${e.changedBy?.agentName ?? 'An agent'} added it${e.changedBy ? ` at ${clockOf(e.changedBy.at)}` : ''}. No agent can use it until you approve it here: agents cannot approve an endpoint.`}</p>
              </Notice>
            )}

            {baseUrlWaits && (
              <Notice answers={<>
                {!e.keySet && <Button size="sm" className="font-mono lowercase" onClick={() => setForm({ id: e.id })}>set the key</Button>}
                <Button size="sm" variant="primary" className="font-mono lowercase" onClick={() => { void approve(e.id); }}>approve the new URL</Button>
                <Button size="sm" className="font-mono lowercase" onClick={() => { void putBack(e); }}>put back the approved one</Button>
              </>}>
                <p>{`${e.changedBy?.agentName ?? 'An agent'} changed its base URL${e.changedBy ? ` at ${clockOf(e.changedBy.at)}` : ''}.${e.keySet ? ' Requests still go to the approved one until you approve the new one.' : ' Its key went with the old address: set it again, then approve the new one.'}`}</p>
                <p className="font-mono text-[11px] text-text-secondary">{`approved   ${e.approvedBaseUrl}`}</p>
                <p className="font-mono text-[11px] text-status-waiting">{`new        ${e.baseUrl}`}</p>
              </Notice>
            )}

            {removing?.id === e.id && (removing.refusedBy && removing.refusedBy.length > 0 ? (
              <Notice answers={<>
                <Button size="sm" className="font-mono lowercase" onClick={() => router.push('/agents')}>open Agents</Button>
                <Button size="sm" variant="ghost" className="font-mono lowercase" onClick={() => setRemoving(null)}>close</Button>
              </>}>
                <p>{`Not removed: ${removing.refusedBy.join(' and ')} ${removing.refusedBy.length === 1 ? 'runs' : 'run'} on it. Move them to another endpoint, or to their own account, then remove it.`}</p>
              </Notice>
            ) : (
              <Notice danger answers={<>
                <Button size="sm" variant="danger" className="font-mono lowercase" onClick={() => { void remove(e.id); }}>remove</Button>
                <Button size="sm" className="font-mono lowercase" onClick={() => setRemoving(null)}>keep it</Button>
              </>}>
                {removing.error
                  ? <p data-endpoint-remove-refused>{`Not removed: ${clauseOf(removing.error)}.`}</p>
                  : <p>{`Remove ${e.name}? Its key goes with it. Sessions recorded on it stay in Traces until you delete them there.`}</p>}
              </Notice>
            ))}
          </div>
        );
      })}

      {form && (
        <div data-settings-row className="px-4 py-[11px]">
          <EndpointForm
            key={form.id ?? 'new'}
            endpoint={editing}
            onDone={done => {
              setForm(null);
              if (done?.error) setRowError(m => ({ ...m, [done.id]: done.error ?? '' }));
              if (done?.unsaved) setRowUnsaved({ id: done.id, word: done.unsaved });
              void reload();
            }}
          />
        </div>
      )}
    </SettingsCard>
  );
};

/**
 * Add an endpoint, or open one again. Adding saves it (approved by that act), stores the key, then reads its
 * models and checks it. Reopening shows only that a key is set: Replace writes a new one, Clear removes it.
 */
/** What a save leaves under the endpoint's row: models not listed (`error`), or traces turned off and not yet written. */
type FormDone = { id: string; error?: string; unsaved?: string };

function EndpointForm({ endpoint, onDone }: { endpoint?: EndpointView; onDone: (done?: FormDone) => void }) {
  const api = window.electronAPI?.endpoints;
  const [name, setName] = useState(endpoint?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(endpoint?.baseUrl ?? '');
  const [key, setKey] = useState('');
  const [replacingKey, setReplacingKey] = useState(!endpoint || !endpoint.keySet);
  const [hold, setHold] = useState(String(endpoint?.holdMaxSeconds ?? DEFAULT_HOLD));
  const [allowTraces, setAllowTraces] = useState(endpoint?.allowTraces ?? false);
  const [sessionHeaders, setSessionHeaders] = useState(endpoint?.sendSessionHeaders ?? false);
  const [plainHttp, setPlainHttp] = useState(endpoint?.allowPlainHttp ?? false);
  const isHttp = /^http:\/\//i.test(baseUrl.trim());
  const [urlError, setUrlError] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; tone: StatusTone } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);

  const holdSeconds = Number(hold);
  const holdOk = Number.isInteger(holdSeconds) && holdSeconds >= 0 && holdSeconds <= 3600;
  const ready = !!api && name.trim() !== '' && baseUrl.trim() !== '' && holdOk && !busy;

  const submit = async () => {
    if (!api) return;
    setBusy(true);
    setUrlError(null);
    setNote(null);
    try {
      const saved = await api.save({ id: endpoint?.id, name: name.trim(), baseUrl: baseUrl.trim(), allowTraces, holdMaxSeconds: holdSeconds, sendSessionHeaders: sessionHeaders, allowPlainHttp: isHttp && plainHttp });
      if (!saved.ok) { setUrlError(saved.error); return; }
      const id = saved.endpoint.id;
      if (replacingKey && key !== '') {
        const k = await api.setKey(id, key);
        setKey('');
        if (!k.ok) { setNote({ text: k.error, tone: 'error' }); return; }
      }
      if (!endpoint) {
        const models = await api.refreshModels(id);
        await api.check(id);
        // The endpoint is saved; its models are not (not read, or not saved): said under its row, in main's words.
        if (!models.ok) { onDone({ id, error: `added without its models: ${clauseOf(models.error)}.` }); return; }
      }
      // Traces turned off here apply at once; main's words say so under the row while they are not written.
      onDone(saved.unsaved ? { id, unsaved: saved.unsaved } : undefined);
    } finally {
      setBusy(false);
    }
  };

  const clearKey = async () => {
    if (!api || !endpoint) return;
    const r = await api.setKey(endpoint.id, null);
    setNote(r.ok ? { text: 'the key is cleared', tone: 'idle' } : { text: r.error, tone: 'error' });
  };

  const readAgain = async () => {
    if (!api || !endpoint) return;
    setReading(true);
    const r = await api.refreshModels(endpoint.id);
    setReading(false);
    setNote(r.ok ? { text: `${r.models.length} models read`, tone: 'running' } : { text: `list not updated: ${clauseOf(r.error)}. The last list is kept.`, tone: 'waiting' });
  };

  return (
    <div data-endpoint-form className="border border-border-accent bg-background px-4 py-3.5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12.5px] text-foreground">{endpoint ? endpoint.name : 'Add an endpoint'}</p>
        <p className="font-mono text-[10.5px] text-muted-foreground">OpenAI-compatible: /v1/models, /v1/chat/completions, /v1/responses</p>
      </div>

      <div className="flex gap-3">
        <label className="w-[280px] shrink-0 space-y-1.5">
          <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">Name</span>
          <Input aria-label="Endpoint name" value={name} maxLength={60} onChange={e => setName(e.target.value)} placeholder="Remote inference host" />
        </label>
        <label className="flex-1 min-w-0 space-y-1.5">
          <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">Base URL</span>
          <Input aria-label="Base URL" mono value={baseUrl} error={!!urlError} onChange={e => { setBaseUrl(e.target.value); setUrlError(null); }} placeholder="https://inference.example.com/v1" />
          {urlError && <FieldError>{urlError}</FieldError>}
        </label>
      </div>

      <div className="space-y-1.5">
        <span className="block font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">Key</span>
        {replacingKey ? (
          <div className="relative">
            <PasswordInput aria-label="Key" value={key} onChange={e => setKey(e.target.value)} placeholder={endpoint ? 'a new key' : 'kept in ~/.tars-private, never shown again'} autoComplete="off" />
            {endpoint && !endpoint.keySet && endpoint.changedBy && !endpoint.approved && (
              <p className="mt-1 font-mono text-[10.5px] text-status-waiting">key to set again: it went with the old address when an agent changed it</p>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Input aria-label="Key" mono readOnly value={endpoint?.keySet ? 'a key is set · never shown' : 'no key'} />
            <Button onClick={() => setReplacingKey(true)}>Replace</Button>
            {endpoint?.keySet && <Button onClick={() => { void clearKey(); }}>Clear</Button>}
          </div>
        )}
      </div>

      {endpoint ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">Models</span>
            <span className="font-mono text-[10.5px] text-muted-foreground">
              {`${endpoint.models.length} read from /v1/models${endpoint.modelsReadAt ? ` at ${clockOf(endpoint.modelsReadAt)}` : ''}`}
            </span>
            <span className="flex-1" />
            <Button size="sm" className="font-mono lowercase" disabled={reading} onClick={() => { void readAgain(); }}>read again</Button>
          </div>
          <p className="font-mono text-[11px] leading-relaxed text-text-secondary">{endpoint.models.join(' · ') || 'no model read'}</p>
        </div>
      ) : (
        <div className="flex items-center gap-2.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">Models</span>
          <span className="font-mono text-[10.5px] text-muted-foreground">read from /v1/models with this key as soon as it is added</span>
        </div>
      )}

      {isHttp && (
        <div data-plain-http className="px-3.5 py-3 bg-secondary border border-border-accent space-y-1.5">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] text-foreground">Allow plain http to this address</p>
              <p className="mt-0.5 max-w-[620px] text-[11px] leading-tight text-muted-foreground">
                Requests, the endpoint&apos;s key and your agents&apos; context cross the network unencrypted: anyone on the way can read them. Only for a network you trust. A private address needs no leave; a public one needs yours.
              </p>
            </div>
            <Toggle label="Allow plain http to this address" enabled={plainHttp} onChange={() => setPlainHttp(v => !v)} />
          </div>
          {plainHttp && <State word="allowed by you: unencrypted" tone="waiting" />}
        </div>
      )}

      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] text-foreground">When it is busy, hold a request for up to</p>
          <p className="mt-0.5 max-w-[620px] text-[11px] leading-tight text-muted-foreground">
            While the endpoint answers 503, 429 or 502, or refuses the connection, the agent waits instead of failing, and Tars tries again. Past this, the error reaches the agent as it came.
          </p>
        </div>
        <div className="w-[90px] shrink-0 flex items-center gap-1.5">
          <Input aria-label="Hold, in seconds" mono compact value={hold} error={!holdOk} onChange={e => setHold(e.target.value)} />
          <span className="font-mono text-[10.5px] text-muted-foreground">s</span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] text-foreground">Send session headers</p>
          <p className="mt-0.5 max-w-[620px] text-[11px] leading-tight text-muted-foreground">
            Adds X-Session-Id and X-Agent-Id to every request, for a server that groups requests into sessions. Off by default: nothing about your agents goes with a request unless you turn it on.
          </p>
        </div>
        <Toggle label="Send session headers" enabled={sessionHeaders} onChange={() => setSessionHeaders(v => !v)} />
      </div>

      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] text-foreground">Allows traces</p>
          <p className="mt-0.5 max-w-[620px] text-[11px] leading-tight text-muted-foreground">
            Its agents may record their sessions in Traces, once their project and the agent itself say so. Off until you turn it on; an agent can turn it off, never on.
          </p>
        </div>
        <Toggle label="Allows traces" enabled={allowTraces} onChange={() => setAllowTraces(v => !v)} />
      </div>

      <div className="flex items-center gap-2">
        {note ? <State word={note.text} tone={note.tone} /> : (
          <span className="font-mono text-[10.5px] text-muted-foreground">
            {endpoint ? 'agents on it start their next session on what you save' : 'Adding it approves it: it is yours'}
          </span>
        )}
        <span className="flex-1" />
        <Button onClick={() => onDone()}>Cancel</Button>
        <Button variant="primary" disabled={!ready} onClick={() => { void submit(); }}>{endpoint ? 'Save' : 'Add the endpoint'}</Button>
      </div>
    </div>
  );
}

/**
 * Never record closed models: on by default (traces.settings excludeClosedModels), a default the owner may change.
 * Turned off, its warning (main's words, closedModelsWarning) is said in the waiting tone under it.
 */
function ClosedModelsRow() {
  const api = typeof window !== 'undefined' ? window.electronAPI?.traces : undefined;
  const [exclude, setExclude] = useState<boolean | null>(null);
  const [warning, setWarning] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** Closed models left out, held by main and not written yet: main's words under the switch until it is. */
  const [unsaved, setUnsaved] = useUnsavedNote();

  const read = useCallback(() => {
    if (!api) return;
    void api.pairs().then(v => { setExclude(v.excludeClosedModels); setWarning(v.closedModelsWarning); }).catch(e => setError(String(e)));
  }, [api]);
  useEffect(() => { read(); }, [read]);

  if (!api) return null;
  const toggle = async () => {
    if (exclude === null) return;
    let r: Awaited<ReturnType<typeof api.setSettings>>;
    try {
      r = await api.setSettings({ excludeClosedModels: !exclude });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!r.ok) { setError(r.error); return; }
    setExclude(r.settings.excludeClosedModels);
    setError(null);
    // Leaving closed models out applies at once; when main could not write it yet, its words say so, and the
    // switch is read again from main.
    setUnsaved(r.unsaved ?? null);
    if (r.unsaved) read();
  };

  return (
    <div data-closed-models={exclude ? 'excluded' : 'allowed'}>
      <SettingsRow
        wrap
        label="Never record closed models"
        description={
          <>
            <span className="block">On by default: a session on a model whose id names Claude, GPT, an o-series model or Gemini is not recorded, whatever the pairs say.</span>
            <span className="block">{warning || "Their providers' terms may forbid training on their outputs: read them before you turn this off."}</span>
          </>
        }
        control={<Toggle label="Never record closed models" enabled={exclude === true} disabled={exclude === null} onChange={() => { void toggle(); }} />}
      />
      {exclude === false && (
        <div className="px-4 pb-[11px]">
          <div className="px-3.5 py-3 bg-secondary border border-border-accent space-y-1">
            <State word="closed models may now be recorded, where a pair and the switches allow it" tone="waiting" />
            <p className="text-xs text-foreground">{warning || "Their providers' terms may forbid training on their outputs."} Tars records what you allow; what you do with it is yours to check.</p>
          </div>
        </div>
      )}
      {error && <p className="px-4 pb-2 font-mono text-[10.5px] text-status-error">{error}</p>}
      {unsaved && <div data-closed-models-unsaved className="px-4 pb-[11px]"><State word={unsaved} tone="waiting" /></div>}
    </div>
  );
}
