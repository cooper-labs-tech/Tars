'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, DialogShell, Input, PanelCaption } from '@/components/ui';
import type { TraceSettingsView, UploadNotice, UploadState } from '@/types/electron';
import type { ElectronAPI } from '@/types/electron';

/** What traces.preview answers for a session: the exact payload the upload sends, and what was masked, by kind. */
type UploadPreview = NonNullable<Awaited<ReturnType<NonNullable<ElectronAPI['traces']>['preview']>>>;
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

/**
 * Main's own reason for a failure, in words a line of the view can carry: without Electron's "Error invoking remote
 * method '<channel>': Error: " in front, without a system error's code and the call it failed in ("ENOSPC: no space
 * left on device, write" says "no space left on device"), and without the final period, which the line's own sentence
 * puts (QA's re-check of #599: "404 not_found.. Nothing was forgotten", and the channel's name shown to the user).
 */
function reasonOf(e: unknown): string {
  let s = (e instanceof Error ? e.message : String(e)).trim();
  s = s.replace(/^Error invoking remote method '[^']*':\s*/, '');
  while (/^[A-Za-z]*Error:\s*/.test(s)) s = s.replace(/^[A-Za-z]*Error:\s*/, '');
  // A system error's code (ENOSPC, EACCES...), not a message that happens to start with ERROR.
  const system = s.match(/^(?!ERROR:)E[A-Z]+:\s*([^,]+)(?:,.*)?$/);
  if (system) s = system[1];
  return s.replace(/[.\s]+$/, '');
}

/**
 * A failure thrown on the way to main, said on its line in main's own words (reasonOf), and logged whole for whoever
 * diagnoses it: the line drops a system error's path and Electron's channel, the console keeps them (the Audit's I-1
 * on #599).
 */
function said(what: string, e: unknown): string {
  console.warn(`[traces upload] ${what} failed:`, e);
  return reasonOf(e);
}

/** The upload's state in words: queued, sent, failed with the back-office's reason, offline. */
function stateWord(s: UploadState): { word: string; tone: 'running' | 'waiting' | 'error' | 'idle' } {
  const next = s.nextTryAt ? ` · next try ${clockOf(s.nextTryAt)}` : '';
  // Said plainly, not as an error: the back-office's own choice. Main looks again in 6 hours.
  if (s.notice === 'registration_closed') return { word: 'this back-office does not take new installs · looked at again in 6 hours', tone: 'idle' };
  if (s.notice === 'install_blocked') return { word: 'this back-office blocked this install · looked at again in 6 hours', tone: 'waiting' };
  // Forgotten by your deletion or by its operator: uploads stopped and the consent withdrawn; sharing again is your act.
  if (s.notice === 'forgotten') return { word: 'this back-office no longer knows this Tars · uploading stopped, the traces on this computer stay', tone: 'idle' };
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
  /**
   * The address the owner is typing, not yet saved: a read of the settings (at mount, on every traces event) never
   * overwrites it, until it is saved or Escape takes it back (QA's M7: a typed address was wiped without a word).
   */
  const edited = useRef(false);
  const [plainHttp, setPlainHttp] = useState(false);
  const isHttp = /^http:\/\//i.test(url.trim());
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showNotice, setShowNotice] = useState(false);
  /** The session as the upload sends it, built by the same function: its batches (id and body) and blobs (hash and content). */
  const [preview, setPreview] = useState<({ title: string } & UploadPreview) | 'none' | { error: string } | null>(null);
  /** The notice main could not read: said under the consent's state, and its button reads it again. */
  const [noticeError, setNoticeError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** The deletion under way: main stops the running upload pass first, then asks the back-office to delete. */
  const [inProgress, setInProgress] = useState(false);
  const [deleted, setDeleted] = useState<{ word: string; tone: 'running' | 'error' } | null>(null);
  /** Giving up an owed deletion: asked first in its plain words, then main's refusal if none is owed. */
  const [givingUp, setGivingUp] = useState(false);
  const [giveUpError, setGiveUpError] = useState<string | null>(null);
  /** A give-up main could not finish after it forgot the install: given up, with the reason it could not finish. */
  const [giveUpUnfinished, setGiveUpUnfinished] = useState<string | null>(null);
  /** The acknowledgment of a cleared deletion that main could not write: said in its box, OK tries again. */
  const [ackError, setAckError] = useState<string | null>(null);
  /** A consent main could not save: said in the notice, above its answers, which stays open. */
  const [consentError, setConsentError] = useState<string | null>(null);

  const read = useCallback(async () => {
    const api = tracesApi();
    if (!api) return;
    try {
      const s = await api.settings();
      setSettings(s);
      if (!edited.current) {
        setUrl(s.uploadUrl);
        setPlainHttp(s.uploadAllowPlainHttp === true);
      }
      setState(await api.uploadState());
      setError(null);
    } catch (e) { setError(said('reading the settings', e)); }
  }, []);

  /** Main's notice of what leaves this computer; a read main cannot answer is said, never silent (the Audit's I-1 on PR 599). */
  const readNotice = useCallback(async (): Promise<UploadNotice | null> => {
    const api = tracesApi();
    if (!api) return null;
    try {
      const n = await api.uploadNotice();
      setNotice(n);
      setNoticeError(null);
      return n;
    } catch (e) {
      setNoticeError(said('reading the notice', e));
      return null;
    }
  }, []);

  useEffect(() => {
    void read();
    void readNotice();
    const off = tracesApi()?.onChanged(() => { void read(); });
    // The uploader works on its own: its state is read again every 10 s while the view is open.
    const tick = setInterval(() => { void tracesApi()?.uploadState().then(setState).catch(() => undefined); }, 10_000);
    return () => { off?.(); clearInterval(tick); };
  }, [read, readNotice]);

  /** Saves the address and the plain http leave; `allow` is the switch's new value when the switch itself saves. */
  const saveUrl = async (allow: boolean = plainHttp) => {
    const api = tracesApi();
    // The field takes no typing before the settings are read, so there is nothing to lose here.
    if (!api || !settings) return;
    const leave = isHttp && allow;
    if (url.trim() === settings.uploadUrl && leave === (settings.uploadAllowPlainHttp === true)) { edited.current = false; return; }
    let r: Awaited<ReturnType<typeof api.setSettings>>;
    try {
      r = await api.setSettings({ uploadUrl: url.trim(), uploadAllowPlainHttp: leave });
    } catch (e) {
      setSaveError(`not saved: ${said('saving the address', e)}. Enter tries again, Escape goes back.`);
      return;
    }
    // Main's refusal says why in its own words (a public address over plain http); the address stays as typed.
    if (!r.ok) { setSaveError(r.error); return; }
    edited.current = false;
    setSaveError(null);
    setSettings(r.settings);
    setUrl(r.settings.uploadUrl);
    // A new address clears the consent: the notice comes before anything is sent.
    if (r.settings.uploadUrl && r.settings.uploadUrl !== settings.uploadUrl) setShowNotice(true);
    void read();
  };

  /** The notice closed: a consent it could not save is no longer said. */
  const closeNotice = () => {
    setShowNotice(false);
    setConsentError(null);
  };

  const consent = async () => {
    const api = tracesApi();
    if (!api) return;
    setConsentError(null);
    let r: Awaited<ReturnType<typeof api.giveUploadConsent>>;
    try {
      r = await api.giveUploadConsent();
    } catch (e) {
      // Main can throw before the consent is saved (a full disk): said in the notice, which stays open, never an
      // unhandled rejection (the Audit's L1 on #599). Nothing is sent without a saved consent.
      setConsentError(said('saving the consent', e));
      void read();
      return;
    }
    closeNotice();
    if (!r.ok) setSaveError(r.error);
    void read();
  };

  /** The newest session of a project opted in, as it would be uploaded. */
  const previewOne = async () => {
    const api = tracesApi();
    if (!api) return;
    const projects = settings?.projects ?? [];
    try {
      for (const project of projects.length > 0 ? projects : [undefined]) {
        const list = await api.list({ project, limit: 1 });
        const s = list.sessions[0];
        if (!s) continue;
        const p = await api.preview(s.traceId);
        if (p) { setPreview({ title: `${s.agentName ?? s.agentId}, ${dayClockOf(s.startedAt)}, as it would be uploaded`, ...p }); return; }
      }
    } catch (e) {
      // On a fresh install the preview first writes the install's secret, which a full disk refuses: said in the
      // preview's dialog, where Try again builds it again, never an unhandled rejection (the Audit's L1 on #599).
      setPreview({ error: said('previewing a session', e) });
      return;
    }
    setPreview('none');
  };

  const deleteAll = async () => {
    const api = tracesApi();
    if (!api) return;
    setDeleting(false);
    setDeleted(null);
    setInProgress(true);
    let r: Awaited<ReturnType<typeof api.deleteEverywhere>>;
    try {
      r = await api.deleteEverywhere();
    } catch (e) {
      // Main can throw before the back-office is asked (a full disk): said, never an unhandled rejection.
      r = { ok: false, error: said('deleting', e) };
    } finally {
      setInProgress(false);
    }
    // The back-office's reason may end with its own period: the sentence ends once.
    setDeleted(r.ok
      ? { word: `the back-office deleted ${r.deleted ?? 'every'} session${r.deleted === 1 ? '' : 's'} · this install is forgotten, your consent withdrawn`, tone: 'running' }
      : { word: `not deleted: ${reasonOf(r.error)}. Nothing was forgotten; try again.`, tone: 'error' });
    void read();
  };

  const giveUp = async () => {
    const api = tracesApi();
    if (!api) return;
    setGivingUp(false);
    setGiveUpError(null);
    setGiveUpUnfinished(null);
    try {
      const r = await api.abandonDeletion();
      if (r.ok) setState(r.state); else setGiveUpError(reasonOf(r.error));
    } catch (e) {
      // Main forgets the install first, then resets what was sent: a failure after the first step leaves the deletion
      // given up. What is true is read from main, never assumed (QA's re-check of #599).
      const reason = said('giving up the deletion', e);
      const after = await api.uploadState().catch(() => null);
      if (after && !after.deletionOwed) { setState(after); setGiveUpUnfinished(reason); } else setGiveUpError(reason);
    }
    void read();
  };

  /** A deletion cleared by itself stays said until the window acknowledges it. */
  const ackCleared = async () => {
    try {
      await tracesApi()?.ackDeletionCleared();
      setAckError(null);
    } catch (e) {
      setAckError(said('acknowledging the cleared deletion', e));
    }
    void read();
  };

  if (error) return <Unread text="could not read the upload's settings:" detail={error} onRetry={() => { void read(); }} />;

  const address = settings?.uploadUrl ?? '';
  const consentWord = !address
    ? { word: 'no address: nothing leaves this computer', tone: 'idle' as const }
    : settings?.uploadConsentAt
      ? { word: `consent given ${dayClockOf(Date.parse(settings.uploadConsentAt))}${state?.registered ? ' · this install is registered' : ''}`, tone: 'running' as const }
      : settings?.uploadDeletionOwed || state?.deletionOwed
        ? { word: "a deletion waits for the back-office's confirmation: sharing stays off until it confirms, or you give it up", tone: 'waiting' as const }
      : state?.notice === 'forgotten'
        ? { word: 'consent withdrawn: nothing is sent until you read what leaves this computer', tone: 'waiting' as const }
        : { word: 'nothing is sent until you read what leaves this computer', tone: 'waiting' as const };
  const status = state && address ? stateWord(state) : null;
  /** A deletion asked for and not confirmed: sharing stays off; delete again, or give it up. */
  const owed = !!(settings?.uploadDeletionOwed || state?.deletionOwed);
  /** The session previewed, or the reason main could not build it. */
  const shown = preview && preview !== 'none' && !('error' in preview) ? preview : null;
  const previewError = preview && preview !== 'none' && 'error' in preview ? preview.error : null;
  const masked = shown
    ? Object.entries(shown.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(' · ')
    : '';

  return (
    <div className="flex flex-col gap-2.5 flex-1 min-h-0 overflow-y-auto">
      <div className="grid grid-cols-2 gap-2.5 items-start">
        <div className="flex flex-col gap-2.5 min-w-0">
          {state?.deletionCleared && (
            <Box name="Deletion cleared" caption="DELETION CLEARED">
              <div className="px-4 pb-3 space-y-2" data-deletion-cleared>
                {/* Said when Tars no longer holds the install a deletion waited on: the back-office never confirmed it. */}
                <StateLine word="Tars forgot this install; the back-office never confirmed the deletion it waited for" tone="waiting" />
                <p className="text-[11.5px] leading-relaxed text-text-secondary">What this install sent may still be on the back-office: ask whoever runs it to delete it. Sharing may start again, as a new install; what was recorded before the deletion is still never sent.</p>
                {ackError && <StateLine word={`not acknowledged: ${ackError}. OK tries again.`} tone="error" />}
                <Button size="sm" onClick={() => { void ackCleared(); }}>OK</Button>
              </div>
            </Box>
          )}
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
              <Input aria-label="Back-office address" mono width="control" value={url} error={!!saveError}
                disabled={!settings} placeholder={settings ? 'https://traces.example.com' : 'reading the settings'}
                onChange={e => { edited.current = true; setUrl(e.target.value); setSaveError(null); }}
                onBlur={() => { void saveUrl(); }}
                onKeyDown={e => {
                  if (e.key === 'Enter') void saveUrl();
                  if (e.key === 'Escape' && settings) {
                    edited.current = false;
                    setUrl(settings.uploadUrl);
                    setPlainHttp(settings.uploadAllowPlainHttp === true);
                    setSaveError(null);
                  }
                }} />
            </Row>
            {isHttp && (
              <Row className="space-y-1.5 py-2.5" data-plain-http>
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[12.5px] text-foreground">Allow plain http to the back-office</p>
                    <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">The sessions you opt in cross the network unencrypted: anyone on the way can read them. Only for a network you trust. A private address needs no leave; a public one needs yours.</p>
                  </div>
                  <Toggle label="Allow plain http to the back-office" enabled={plainHttp} onChange={() => { const next = !plainHttp; edited.current = true; setPlainHttp(next); void saveUrl(next); }} />
                </div>
                {plainHttp && settings?.uploadAllowPlainHttp && <StateLine word="allowed by you: unencrypted" tone="waiting" />}
              </Row>
            )}
            {saveError && <Row><StateLine word={saveError} tone="error" /></Row>}
            <Row className="space-y-2 py-2.5">
              <StateLine word={consentWord.word} tone={consentWord.tone} />
              {noticeError && <StateLine word={`notice not read: ${noticeError}. What leaves this computer reads it again.`} tone="error" />}
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => { if (notice) setShowNotice(true); else void readNotice().then(n => { if (n) setShowNotice(true); }); }} disabled={!notice && !noticeError}>What leaves this computer</Button>
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
                Asks the back-office to delete every session this install sent, then forgets the install and what was sent, and withdraws your consent. Recording on this computer goes on; uploading starts again only when you consent again, as a new install.
              </p>
              {inProgress && <StateLine word="stopping the upload under way, then asking the back-office to delete" tone="waiting" />}
              {deleted && !inProgress && <StateLine word={deleted.word} tone={deleted.tone} />}
              {owed && !inProgress && <StateLine word={`not confirmed yet${state?.lastError ? `: ${state.lastError}` : ''}. Nothing new is sent meanwhile.`} tone="waiting" />}
              {giveUpError && <StateLine word={`not given up: ${giveUpError}`} tone="error" />}
              {giveUpUnfinished && <StateLine word={`given up, though Tars could not finish: ${giveUpUnfinished}`} tone="waiting" />}
              <div className="flex items-center gap-2">
                <Button size="sm" variant="danger" disabled={!address || inProgress} onClick={() => setDeleting(true)}>{inProgress ? 'deleting' : owed ? 'Delete again' : 'Delete everything this Tars sent'}</Button>
                {owed && !inProgress && <Button size="sm" variant="ghost" onClick={() => { setGiveUpError(null); setGiveUpUnfinished(null); setGivingUp(true); }}>Give up this deletion</Button>}
              </div>
            </div>
          </Box>
        </div>
      </div>

      {showNotice && notice && (
        <DialogShell
          onClose={closeNotice}
          width={760}
          title="Before anything leaves this computer"
          subtitle={`Tars uploads${address ? ` to ${address}` : ''} the sessions you opt in, scrubbed by its own rules (scrub ${notice.scrubbing.version}). Read what leaves and what stays, and preview a session as it would be sent.`}
          footerLeft={<Button onClick={() => { void previewOne(); }}>Preview a session</Button>}
          footerRight={<>
            <Button onClick={closeNotice}>Not now</Button>
            <Button variant="primary" disabled={!address || !!settings?.uploadConsentAt || owed} onClick={() => { void consent(); }}>Upload what I opt in</Button>
          </>}
        >
          <div className="space-y-4">
            {notice.onlyAfter && (
              <p data-only-after className="text-[12px] text-status-waiting">{`Only sessions started after ${dayClockOf(Date.parse(notice.onlyAfter))} are sent: what was recorded before your deletion never is.`}</p>
            )}
            <div className="grid grid-cols-2 gap-6">
              <Bullets caption="WHAT LEAVES" items={notice.leaves} tone="text-status-waiting" />
              <Bullets caption="WHAT STAYS" items={notice.stays} tone="text-status-running" />
            </div>
            <div className="grid grid-cols-2 gap-6">
              <Bullets caption="SCRUBBING CATCHES" items={notice.scrubbing.catches} tone="text-muted-foreground" />
              <Bullets caption="IT CANNOT CATCH" items={notice.scrubbing.cannot} tone="text-status-error" />
            </div>
            <p className="text-[11px] text-muted-foreground">You can delete everything this Tars sent at any time, from Traces, Upload.</p>
            {consentError && <StateLine word={`not saved: ${consentError}. Upload what I opt in tries again.`} tone="error" />}
          </div>
        </DialogShell>
      )}

      {preview && (
        <DialogShell
          onClose={() => setPreview(null)}
          width={760}
          title={preview === 'none' ? 'No session to preview yet' : 'error' in preview ? 'No session previewed' : preview.title}
          subtitle={preview === 'none' ? 'No session of a project opted in was recorded yet.' : undefined}
          footerLeft={previewError !== null ? <Button onClick={() => { void previewOne(); }}>Try again</Button> : undefined}
          footerRight={<Button onClick={() => setPreview(null)}>Close</Button>}
        >
          {previewError !== null && <StateLine word={`not previewed: ${previewError}. Try again builds it again.`} tone="error" />}
          {shown && (
            <div className="space-y-2.5">
              <p className="font-mono text-[11px] text-status-waiting">{`masked: ${masked || 'nothing'} · scrub ${shown.scrubVersion}`}</p>
              <pre data-upload-preview className="max-h-[420px] overflow-auto px-2.5 py-2 bg-term-bg border border-border font-mono text-[11.5px] leading-normal text-foreground whitespace-pre-wrap break-words">
                {JSON.stringify(shown.document, null, 2)}
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

      {givingUp && (
        <DialogShell
          onClose={() => setGivingUp(false)}
          width={560}
          title="Give up this deletion?"
          subtitle="What you shared there may still be there; Tars stops trying to delete it, and still never sends what was recorded before the deletion. Sharing may then start again, to this or another back-office."
          footerRight={<>
            <Button onClick={() => setGivingUp(false)}>Keep trying</Button>
            <Button variant="danger" onClick={() => { void giveUp(); }}>Give up the deletion</Button>
          </>}
        />
      )}
    </div>
  );
}
