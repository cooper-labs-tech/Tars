'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check, Search } from 'lucide-react';
import { pickerTriggerClass } from '@/components/ui';
import type { OverseerModelProvider } from '@/types/electron';

/**
 * One control for what the overseer runs on: the provider, the model, and the
 * effort behind them.
 *
 * They were three separate dropdowns in a row that also holds attach and the
 * watch cadence, which is five controls for one message box. JeanBrasse's frame
 * merges them: the trigger reads "<model> <effort>", and the choosing happens
 * inside, which is the submenu-inside-the-submenu he asked for.
 *
 * Provider is a section rather than its own control because a gateway can
 * offer a hundred models under one provider, so the two cannot be a single
 * flat list, but they are one decision.
 *
 * Frame: `Chat · composer redesign` > `control bar` > `sel deepseek`.
 */

/** Past this many, the model list gets a filter field. */
const SEARCHABLE_FROM = 8;

export function ModelEffortPicker({
  providers,
  provider,
  model,
  effort,
  effortOptions,
  onProvider,
  onModel,
  onEffort,
  disabledReason,
}: {
  providers: OverseerModelProvider[];
  provider: string;
  model: string;
  effort: string | null;
  effortOptions: string[];
  onProvider: (id: string) => void;
  onModel: (id: string) => void;
  onEffort: (value: string) => void;
  /** Why there is nothing to choose from. Set, the control stays where it is,
   *  greyed and saying so, rather than leaving the row. */
  disabledReason?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Closing is what resets the filter: reopening on a stale query would show a
  // short list with no sign of why.
  useEffect(() => { if (!open) setQuery(''); }, [open]);

  const current = providers.find(p => p.slug === provider);
  const models = current?.models ?? [];
  const filtered = query.trim()
    ? models.filter(m => m.toLowerCase().includes(query.trim().toLowerCase()))
    : models;

  const off = !!disabledReason;

  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        disabled={off}
        onClick={() => { if (!off) setOpen(o => !o); }}
        aria-label="Overseer model and reasoning effort"
        title={disabledReason ?? 'Sets the model and the reasoning effort your Hermes gateway runs at, for everything that uses it, not only this chat'}
        // The composer's picker trigger, as the recipient picker beside it in
        // the room: borderless at rest, a box when open, never the accent.
        className={pickerTriggerClass(open)}
      >
        <span className="truncate">{model || 'model'}</span>
        {effort && <span className="font-normal text-text-muted shrink-0">{effort}</span>}
        <ChevronDown
          className={`w-3.5 h-3.5 text-muted-foreground shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && !off && (
        <div className="absolute z-[90] bottom-full mb-1 left-0 w-[248px] bg-card border border-border">
          {providers.length > 1 && (
            <div className="border-b border-border">
              <p className="px-2.5 pt-2 pb-1 font-mono text-[9.5px] uppercase tracking-[0.06em] text-text-muted">
                provider
              </p>
              <div className="flex flex-wrap gap-1 px-2.5 pb-2">
                {providers.map(p => (
                  <button
                    key={p.slug}
                    type="button"
                    onClick={() => onProvider(p.slug)}
                    className={`h-[22px] px-2 rounded text-[11px] border ${
                      p.slug === provider
                        ? 'border-border bg-secondary text-foreground'
                        : 'border-transparent text-muted-foreground hover:bg-secondary'
                    }`}
                  >
                    {p.name || p.slug}
                  </button>
                ))}
              </div>
            </div>
          )}

          {models.length >= SEARCHABLE_FROM && (
            <div className="flex items-center gap-2 h-8 px-2.5 border-b border-border">
              <Search className="w-3 h-3 text-text-muted shrink-0" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="filter"
                className="w-full bg-transparent text-[11px] text-foreground placeholder:text-text-muted outline-none"
              />
            </div>
          )}

          <div className="max-h-[220px] overflow-y-auto py-1">
            {filtered.length === 0 && (
              <p className="px-2.5 py-2 text-[11px] text-text-muted">Nothing matches.</p>
            )}
            {filtered.map(m => (
              <button
                key={m}
                type="button"
                onClick={() => { onModel(m); setOpen(false); }}
                className="w-full flex items-center gap-2 px-2.5 h-7 text-left text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground"
              >
                <Check className={`w-3 h-3 shrink-0 ${m === model ? 'text-foreground' : 'opacity-0'}`} />
                <span className="truncate">{m}</span>
              </button>
            ))}
          </div>

          {/* The effort stays inside the same control because it is a property
              of the same answer. It is the gateway's setting, not the
              message's, so there is one value rather than one per turn. */}
          {effort && effortOptions.length > 0 && (
            <div className="border-t border-border">
              <p className="px-2.5 pt-2 pb-1 font-mono text-[9.5px] uppercase tracking-[0.06em] text-text-muted">
                reasoning effort
              </p>
              <div className="flex gap-1 px-2.5 pb-2">
                {effortOptions.map(o => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => onEffort(o)}
                    className={`flex-1 h-[22px] px-2 rounded text-[11px] border ${
                      o === effort
                        ? 'border-border bg-secondary text-foreground'
                        : 'border-transparent text-muted-foreground hover:bg-secondary'
                    }`}
                  >
                    {o}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
