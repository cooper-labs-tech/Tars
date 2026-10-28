'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button, PasswordInput, StatusSquare } from '@/components/ui';
import { SettingsRow } from './SettingsRow';

/**
 * A secret of the settings as Settings shows it since #466 (2.0.4; frames `Secrets · states` and the pages drawn
 * with it): whether one is set, never its value, and no field holding anything a save could write back over it.
 * Set hands what was pasted to secrets.set and forgets it; replace opens an empty field; clear asks once. The look
 * of Providers' key row (CliPanels.tsx, #460).
 */
export function SecretRow({ field, label, description, wrap, set, noun = 'key', placeholder, clearWarning, onChanged }: {
  /** The setting secrets.set takes, `slackBotToken`. */
  field: string;
  label: string;
  description?: ReactNode;
  /** A description read whole, as SettingsRow wraps it. */
  wrap?: boolean;
  /** What main says of it (`secretsSet`). */
  set: boolean;
  noun?: 'key' | 'token' | 'secret';
  placeholder?: string;
  /** What clear asks, with what clearing does. */
  clearWarning: string;
  /** What secrets.set answered, for the page's copy (useSettings' setSecretState). */
  onChanged: (field: string, set: boolean) => void;
}) {
  const [draft, setDraft] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (value: string | null) => {
    if (!window.electronAPI?.secrets) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.secrets.set(field, value);
      if (!result?.success) { setError(`Not saved: ${result?.error || 'Tars could not save it.'}`); return; }
      setDraft('');
      setReplacing(false);
      setConfirming(false);
      onChanged(field, result.set ?? value !== null);
    } catch (err) {
      setError(`Not saved: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SettingsRow
        label={label}
        description={description}
        wrap={wrap}
        control={set && !replacing ? (
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-[11.5px] text-success"><StatusSquare tone="running" />{`a ${noun} is set`}</span>
            <Button size="sm" className="font-mono" onClick={() => { setReplacing(true); setConfirming(false); }}>replace</Button>
            <Button size="sm" className="font-mono" onClick={() => setConfirming(true)}>clear</Button>
          </div>
        ) : (
          <form
            className="flex w-full items-center gap-2"
            onSubmit={(e) => { e.preventDefault(); if (draft.trim() && !busy) void save(draft.trim()); }}
          >
            <PasswordInput
              className="min-w-0 flex-1"
              aria-label={label}
              value={draft}
              autoComplete="off"
              onChange={(e) => setDraft(e.target.value)}
              placeholder={placeholder ?? `Paste a ${noun}`}
            />
            <Button type="submit" size="sm" variant="primary" disabled={busy || !draft.trim()}>set</Button>
            {replacing && (
              <Button type="button" size="sm" className="font-mono" onClick={() => { setReplacing(false); setDraft(''); setError(null); }}>cancel</Button>
            )}
          </form>
        )}
      />
      {confirming && (
        <div role="alertdialog" aria-label={`Clear ${label}`} className="mx-4 my-2 flex items-center gap-3 px-3 py-2 bg-secondary border border-border">
          <StatusSquare tone="waiting" />
          <p className="flex-1 text-[12px] text-foreground">{clearWarning}</p>
          <Button size="sm" className="font-mono" onClick={() => setConfirming(false)}>cancel</Button>
          <Button size="sm" className="font-mono" disabled={busy} onClick={() => void save(null)}>clear</Button>
        </div>
      )}
      {error && <p className="px-4 pb-2 text-[11.5px] text-danger">{error}</p>}
    </>
  );
}
