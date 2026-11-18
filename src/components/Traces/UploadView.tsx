'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, DialogShell, Input, PanelCaption } from '@/components/ui';
import type { TraceSettingsView, UploadNotice, UploadState } from '@/types/electron';
import { Box, Row, Unread } from '@/components/Resources/bits';
import { Toggle } from '@/components/Settings/Toggle';
import { clockOf, dayClockOf, dayOf } from '@/lib/traces-format';
import { StateLine } from './bits';
import { tracesApi } from './hooks';

/** One list of the notice, its items under a caption, each after a dot in its tone. */
function Bullets({ caption, items, tone }: { caption: string; items: string[]; tone: string }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <PanelCaption>{caption}</PanelCaption>
      <ul className="space-y-1">
        {items.map(t => (
          <li key={t} className="flex gap-2 text-[11.5px] leading-[1.45] text-text-secondary">
            <span className={`font-mono ${tone}`}>·</span><span className="min-w-0">{t}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The upload's state in words: queued, sent, failed with the back-office's reason, offline. */
function stateWord(s: UploadState): { word: string; tone: 'running' | 'waiting' | 'error' | 'idle' } {
  const next = s.nextTryAt ? ` · next try ${clockOf(s.nextTryAt)}` : '';
  // Said plainly, not as an error: the back-office's own choice. Main looks again in 6 hours.
  if (s.notice === 'registration_closed') return { word: 'this back-office does not take new installs · looked at again in 6 hours', tone: 'idle' };
  if (s.notice === 'install_blocked') return { word: 'this back-office blocked this install · looked at again in 6 hours', tone: 'waiting' };
  if (s.lastError && /^\d{3} /.test(s.lastError)) return { word: `failed: ${s.lastError}${next}`, tone: 'error' };
  if (s.lastError) return { word: `offline: the back-office was not reached (${s.lastError})${next}`, tone: 'waiting' };
  if (s.pendingSessions > 0) return { word: `sending · ${s.pendingSessions} session${s.pendingSessions === 1 ? '' : 's'} queued`, tone: 'waiting' };
  if (s.sentSessions > 0) return { word: `all sent · ${s.sentSessions} session${s.sentSessions === 1 ? '' : 's'}`, tone: 'running' };
  return { word: 'nothing to send yet', tone: 'idle' };
}

/**
 * Traces · upload: the back-office's address (empty until set), the notice of what leaves this computer and the
 * consent, a session as it would be sent, the upload's state, and deleting everything this Tars sent. Nothing leaves
 * the computer until an address is set and the notice read (traces.giveUploadConsent). Frames: `Traces · upload`,
 * `Traces · upload · states`, and their light copies.
 */
export function UploadView() {
  const [settings, setSettings] = useState<TraceSettingsView | null>(null);
  const [state, setState] = useState<UploadState | null>(null);
  const [notice, setNotice] = useState<UploadNotice | null>(null);
  const [url, setUrl] = useState('');
  const [plainHttp, setPlainHttp] = useState(false);
  const isHttp = /^http:\/\//i.test(url.trim());
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showNotice, setShowNotice] = useState(false);
  const [preview, setPreview] = useState<{ title: string; document: unknown; counts: Record<string, number>; scrubVersion: string } | 'none' | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState<{ word: string; tone: 'running' | 'error' } | null>(null);

  const read = useCallback(async () => {
    const api = tracesApi();
    if (!api) return;
    try {
      const s = await api.settings();
      setSettings(s);
      setUrl(s.uploadUrl);
      setPlainHttp(s.uploadAllowPlainHttp === true);
      setState(await api.uploadState());
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => {
    void read();
    void tracesApi()?.uploadNotice().then(setNotice).catch(() => undefined);
    const off = tracesApi()?.onChanged(() => { void read(); });
    // The uploader works on its own: its state is read again every 10 s while the view is open.
    const tick = setInterval(() => { void tracesApi()?.uploadState().then(setState).catch(() => undefined); }, 10_000);
    return () => { off?.(); clearInterval(tick); };
  }, [read]);

  const saveUrl = async () => {
    const api = tracesApi();
    if (!api || !settings) return;
    const leave = isHttp && plainHttp;
    if (url.trim() === settings.uploadUrl && leave === (settings.uploadAllowPlainHttp === true)) return;
    const r = await api.setSettings({ uploadUrl: url.trim(), uploadAllowPlainHttp: leave });
    if (!r.ok) { setSaveError(r.error); return; }
    setSaveError(null);
    setSettings(r.settings);
    // A new address clears the consent: the notice comes before anything is sent.
    if (r.settings.uploadUrl && r.settings.uploadUrl !== settings.uploadUrl) setShowNotice(true);
    void read();
  };

  const consent = async () => {
    const api = tracesApi();
    if (!api) return;
    const r = await api.giveUploadConsent();
    setShowNotice(false);
    if (!r.ok) setSaveError(r.error);
    void read();
  };

  /** The newest session of a project opted in, as it would be uploaded. */
  const previewOne = async () => {
    const api = tracesApi();
    if (!api) return;
    const projects = settings?.projects ?? [];
    for (const project of projects.length > 0 ? projects : [undefined]) {
      const list = await api.list({ project, limit: 1 });
      const s = list.sessions[0];
      if (!s) continue;
      const p = await api.preview(s.traceId);
      if (p) { setPreview({ title: `${s.agentName ?? s.agentId}, ${dayClockOf(s.startedAt)}, as it would be uploaded`, ...p }); return; }
    }
    setPreview('none');
  };

  const deleteAll = async () => {
    const api = tracesApi();
    if (!api) return;
    setDeleting(false);
    const r = await api.deleteEverywhere();
    setDeleted(r.ok
      ? { word: `the back-office deleted ${r.deleted ?? 'every'} session${r.deleted === 1 ? '' : 's'} · this install is forgotten`, tone: 'running' }
      : { word: `not deleted: ${r.error}. Nothing was forgotten; try again.`, tone: 'error' });
    void read();
  };

  if (error) return <Unread text="could not read the upload's settings:" detail={error} onRetry={() => { void read(); }} />;

  const address = settings?.uploadUrl ?? '';
  const consentWord = !address
    ? { word: 'no address: nothing leaves this computer', tone: 'idle' as const }
    : settings?.uploadConsentAt
      ? { word: `consent given ${dayClockOf(Date.parse(settings.uploadConsentAt))}${state?.registered ? ' · this install is registered' : ''}`, tone: 'running' as const }
      : { word: 'nothing is sent until you read what leaves this computer', tone: 'waiting' as const };
  const status = state && address ? stateWord(state) : null;
  const masked = preview && preview !== 'none'
    ? Object.entries(preview.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(' · ')
    : '';

  return (
    <div className="flex flex-col gap-2.5 flex-1 min-h-0 overflow-y-auto">
      <div className="grid grid-cols-2 gap-2.5 items-start">
        <div className="flex flex-col gap-2.5 min-w-0">
          <Box name="Back-office" caption="BACK-OFFICE">
            <div className="px-4 pb-3 space-y-2.5">
              <p className="text-[11.5px] leading-relaxed text-text-secondary">
                Tars can upload the sessions of the projects you opt in to a back-office: a server of your own, or a hosted one. Nothing is uploaded until you set its address and read what leaves this computer.
              </p>
            </div>
            <Row className="flex items-center gap-4 py-2.5">
              <div className="flex-1 min-w-0">
                <p className="text-[12.5px] text-foreground">Address</p>
                <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">The back-office&apos;s API, yours or a hosted one. Empty: nothing leaves this computer. A new address asks for your consent again.</p>
              </div>
              <Input aria-label="Back-office address" mono width="control" placeholder="https://traces.example.com" value={url} error={!!saveError}
                onChange={e => { setUrl(e.target.value); setSaveError(null); }}
                onBlur={() => { void saveUrl(); }}
                onKeyDown={e => { if (e.key === 'Enter') void saveUrl(); }} />
            </Row>
            {isHttp && (
              <Row className="space-y-1.5 py-2.5" data-plain-http>
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] text-foreground">Allow plain http to the back-office</p>
                    <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">The sessions you opt in cross the network unencrypted: anyone on the way can read them. Only for a network you trust. A private address needs no leave; a public one needs yours.</p>
                  </div>
                  <Toggle label="Allow plain http to the back-office" enabled={plainHttp} onChange={() => setPlainHttp(v => !v)} />
                </div>
                {plainHttp && <StateLine word="allowed by you: unencrypted" tone="waiting" />}
              </Row>
            )}
            {saveError && <Row><StateLine word={saveError} tone="error" /></Row>}
            <Row className="space-y-2 py-2.5">
              <StateLine word={consentWord.word} tone={consentWord.tone} />
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => setShowNotice(true)} disabled={!notice}>What leaves this computer</Button>
                <Button size="sm" onClick={() => { void previewOne(); }}>Preview a session</Button>
              </div>
            </Row>
          </Box>

          {status && state && (
            <Box name="Upload" caption="UPLOAD">
              <div className="px-4 pb-3 space-y-2.5">
                <StateLine word={status.word} tone={status.tone} />
                <div className="grid grid-cols-3 gap-4">
                  {[['QUEUED', String(state.pendingSessions), 'sessions to send'], ['SENT', String(state.sentSessions), 'sessions'],
                    ['LAST UPLOAD', state.lastUploadAt ? clockOf(state.lastUploadAt) : '-', state.lastUploadAt ? dayOf(state.lastUploadAt) : 'none yet']].map(([k, v, sub]) => (
                    <div key={k} className="min-w-0">
                      <PanelCaption>{k}</PanelCaption>
                      <p className="mt-0.5 font-serif text-xl leading-[1.15] text-foreground">{v}</p>
                      <p className="font-mono text-[10.5px] text-muted-foreground">{sub}</p>
                    </div>
                  ))}
                </div>
                <p className="font-mono text-[10.5px] text-muted-foreground">
                  {`Opted in: ${(settings?.projects ?? []).map(p => p.split(/[\\/]/).pop()).join(', ') || 'no project yet'}. A project's switch is its consent; an agent says so itself.`}
                </p>
              </div>
            </Box>
          )}
        </div>

        <div className="flex flex-col gap-2.5 min-w-0">
          {notice && (
            <Box name="Scrubbing" caption={`SCRUBBING · ${notice.scrubbing.version}`}>
              <div className="px-4 pb-3 space-y-2">
                <Bullets caption="" items={notice.scrubbing.catches.slice(0, 3)} tone="text-muted-foreground" />
                <p className="font-mono text-[10.5px] text-muted-foreground">
                  {`and ${Math.max(0, notice.scrubbing.catches.length - 3)} more; ${notice.scrubbing.cannot.length} things it cannot catch`}
                </p>
                <Button size="sm" onClick={() => setShowNotice(true)}>What leaves this computer</Button>
              </div>
            </Box>
          )}
          <Box name="Delete everything this Tars sent" caption="DELETE EVERYTHING THIS TARS SENT">
            <div className="px-4 pb-3 space-y-2.5">
              <p className="text-[11.5px] leading-relaxed text-text-secondary">
                Asks the back-office to delete every session this install sent, then forgets the install and what was sent. Recording on this computer goes on, and so does uploading, as a new install, while the address and your consent stay.
              </p>
              {deleted && <StateLine word={deleted.word} tone={deleted.tone} />}
              <Button size="sm" variant="danger" disabled={!address} onClick={() => setDeleting(true)}>Delete everything this Tars sent</Button>
            </div>
          </Box>
        </div>
      </div>

      {showNotice && notice && (
        <DialogShell
          onClose={() => setShowNotice(false)}
          width={760}
          title="Before anything leaves this computer"
          subtitle={`Tars uploads${address ? ` to ${address}` : ''} the sessions you opt in, scrubbed by its own rules (scrub ${notice.scrubbing.version}). Read what leaves and what stays, and preview a session as it would be sent.`}
          footerLeft={<Button onClick={() => { void previewOne(); }}>Preview a session</Button>}
          footerRight={<>
            <Button onClick={() => setShowNotice(false)}>Not now</Button>
            <Button variant="primary" disabled={!address || !!settings?.uploadConsentAt} onClick={() => { void consent(); }}>Upload what I opt in</Button>
          </>}
        >
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-6">
              <Bullets caption="WHAT LEAVES" items={notice.leaves} tone="text-status-waiting" />
              <Bullets caption="WHAT STAYS" items={notice.stays} tone="text-status-running" />
            </div>
            <div className="grid grid-cols-2 gap-6">
              <Bullets caption="SCRUBBING CATCHES" items={notice.scrubbing.catches} tone="text-muted-foreground" />
              <Bullets caption="IT CANNOT CATCH" items={notice.scrubbing.cannot} tone="text-status-error" />
            </div>
            <p className="text-[11px] text-muted-foreground">You can delete everything this Tars sent at any time, from Traces, Upload.</p>
          </div>
        </DialogShell>
      )}

      {preview && (
        <DialogShell
          onClose={() => setPreview(null)}
          width={760}
          title={preview === 'none' ? 'No session to preview yet' : preview.title}
          subtitle={preview === 'none' ? 'No session of a project opted in was recorded yet.' : undefined}
          footerRight={<Button onClick={() => setPreview(null)}>Close</Button>}
        >
          {preview !== 'none' && (
            <div className="space-y-2.5">
              <p className="font-mono text-[11px] text-status-waiting">{`masked: ${masked || 'nothing'} · scrub ${preview.scrubVersion}`}</p>
              <pre data-upload-preview className="max-h-[420px] overflow-auto px-2.5 py-2 bg-term-bg border border-border font-mono text-[11.5px] leading-normal text-foreground whitespace-pre-wrap break-words">
                {JSON.stringify(preview.document, null, 2)}
              </pre>
              <p className="text-[11px] text-muted-foreground">This is the document Tars would send, whole: projects, agents and endpoints go as keys, never their names or addresses.</p>
            </div>
          )}
        </DialogShell>
      )}

      {deleting && (
        <DialogShell
          onClose={() => setDeleting(false)}
          width={560}
          title="Delete everything this Tars sent?"
          subtitle={`The back-office at ${address} is asked to delete the ${state?.sentSessions ?? 0} sessions this install sent. Tars then forgets the install. Sessions recorded on this computer stay.`}
          footerRight={<>
            <Button onClick={() => setDeleting(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => { void deleteAll(); }}>Delete everything</Button>
          </>}
        />
      )}
    </div>
  );
}
