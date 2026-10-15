'use client';

import { useCallback, useEffect, useState } from 'react';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';
import { Toggle } from './Toggle';
import type { OverseerAutoRule, OverseerSettings } from '@/types/electron';

/**
 * What the Chat agent may do without asking.
 *
 * The overseer proposes and JeanBrasse approves, and that gate does not move: an
 * enabled rule here is an approval given in advance for one narrow situation,
 * and it still goes through the same code path a pressed button does.
 *
 * In Settings rather than on the Chat page because turning one on is a
 * standing decision about what may happen while you are not looking, not a
 * property of the message you are about to send.
 */
export function OverseerAutonomy() {
  const [rules, setRules] = useState<OverseerAutoRule[]>([]);
  const [enabled, setEnabled] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [available, settings] = await Promise.all([
      window.electronAPI?.overseer?.autoActions(),
      window.electronAPI?.overseer?.settings(),
    ]);
    if (available) setRules(available);
    if (settings) setEnabled(settings.autoActions ?? []);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const toggle = async (id: string) => {
    const next = enabled.includes(id) ? enabled.filter(x => x !== id) : [...enabled, id];
    const res = await window.electronAPI?.overseer?.setSettings({ autoActions: next } as Partial<OverseerSettings>);
    // The main process returns what it stored, which is the list after it has
    // dropped any rule it does not recognise.
    if (res?.settings) setEnabled(res.settings.autoActions ?? []);
    setError(res && !res.success ? (res.error ?? 'Could not save that.') : null);
  };

  if (rules.length === 0) return null;

  return (
    <SettingsCard>
      {rules.map(rule => (
        <SettingsRow
          key={rule.id}
          label={rule.label}
          description={rule.description}
          control={<Toggle enabled={enabled.includes(rule.id)} onChange={() => toggle(rule.id)} />}
        />
      ))}
      <div className="px-4 py-3">
        <p className="bg-bg-tertiary px-3 py-2 text-[11px] text-muted-foreground">
          {error ?? 'Everything else still waits for you. When the overseer does send something on its own, the message in the chat says so and names the rule that allowed it.'}
        </p>
      </div>
    </SettingsCard>
  );
}
