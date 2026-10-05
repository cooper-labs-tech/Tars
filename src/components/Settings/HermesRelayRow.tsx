'use client';

import { useEffect, useState } from 'react';
import { Button, StatusBadge, StatusSquare } from '@/components/ui';
import type { HermesRelayStatus } from '@/types/electron';
import { relayView } from '@/lib/hermes-relay';
import { SettingsRow } from './SettingsRow';
import { Toggle } from './Toggle';

const LABEL = 'Telegram through Hermes';
const CONFIRM =
  "Turning it on erases the Tars bot's token and switches the bot off: your Telegram then hears from Hermes alone. Tars needs the tars-relay plugin on your Hermes.";

/**
 * The relay's switch, `hermesRelayEnabled` (#285). Turning it on erases the
 * Tars bot's token and switches the bot off, so a click on the switch asks
 * first and nothing is saved before turn on; turning it off erases nothing and
 * saves at once. Once on, the row says how the relay stands, from main's
 * `relayStatus()` and each `onRelayStatus` after it. Frames: `Settings ·
 * Connection`, and `Settings · Connection · Telegram through Hermes` with its
 * light copy.
 */
export function HermesRelayRow({ enabled, onSave }: { enabled: boolean; onSave: (on: boolean) => void }) {
  const [status, setStatus] = useState<HermesRelayStatus | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let live = true;
    window.electronAPI?.hermes?.relayStatus?.().then(s => { if (live) setStatus(s); }).catch(() => undefined);
    const off = window.electronAPI?.hermes?.onRelayStatus?.(s => { if (live) setStatus(s); });
    return () => { live = false; off?.(); };
  }, []);

  const view = relayView(enabled ? status : null);

  return (
    <>
      <SettingsRow
        label={LABEL}
        description={view.line}
        wrap
        control={
          <div className="flex items-center gap-3 w-full justify-end">
            {view.word && view.tone && (
              <StatusBadge tone={view.tone} className="font-mono">
                <StatusSquare tone={view.tone} />
                {view.word}
              </StatusBadge>
            )}
            <Toggle enabled={enabled} label={LABEL} onChange={() => (enabled ? onSave(false) : setAsking(true))} />
          </div>
        }
      />
      {asking && !enabled && (
        <div className="px-4 py-[11px]">
          <div className="flex items-center gap-2.5 border border-border bg-secondary px-3 py-2">
            <StatusSquare tone="waiting" />
            <p className="flex-1 text-xs text-foreground">{CONFIRM}</p>
            <Button size="sm" variant="ghost" className="font-mono lowercase" onClick={() => setAsking(false)}>cancel</Button>
            <Button size="sm" className="font-mono lowercase" onClick={() => { setAsking(false); onSave(true); }}>turn on</Button>
          </div>
        </div>
      )}
    </>
  );
}
