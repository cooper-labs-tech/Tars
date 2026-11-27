'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, DialogShell, Dropdown, Input, PanelCaption } from '@/components/ui';
import type { TraceSettingsView } from '@/types/electron';
import { Box, Notice, Row, Unread } from '@/components/Resources/bits';
import { BACK_OFFICE_COPY_MANY, dayClockOf, dayOf, projectNameOf, reasonOf, sizeOf } from '@/lib/traces-format';
import { Meter, StateLine } from './bits';
import { tracesApi, useTraceStats } from './hooks';
import { ExportDialog } from './ExportDialog';

const GB = 1024 ** 3;
const DAYS = ['7', '14', '30', '60', '90', '180', '365'];

type Reader = { exists: boolean; createdAt?: string; lastUsedAt?: string; route: string; listen: 'loopback' };

/**
 * Traces · storage and reader access: what the store holds against its cap, how long it keeps a session, the store
 * by project; the reader token, made and shown once, rotated or revoked; and export. Frames: `Traces · storage and
 * reader access`, `Traces · states` (the token, rotate, revoke, delete, at the cap).
 */
export function StorageView() {
  const { stats, error, read } = useTraceStats();
  const [settings, setSettings] = useState<TraceSettingsView | null>(null);
  const [cap, setCap] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reader, setReader] = useState<Reader | null>(null);
  const [dialog, setDialog] = useState<'create' | 'rotate' | 'revoke' | 'delete-all' | null>(null);
  /** Deleting every session refused by main: said in its dialog, above its answers; its button tries again. */
  const [removeError, setRemoveError] = useState<string | null>(null);
  /**
   * A reader token not made, rotated or revoked: said in its dialog, above its answers; its button tries again.
   * `answered`: main refused, in a sentence that says what holds now; else the call itself failed, and nothing is known
   * of the token (the Audit's I-2 on PR 599).
   */
  const [tokenError, setTokenError] = useState<{ reason: string; answered: boolean } | null>(null);
  /** I-4: what could not be read or copied in this view, said where it was asked. */
  const [readError, setReadError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const closeDialog = () => { setDialog(null); setRemoveError(null); setTokenError(null); };
  const [shown, setShown] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const readAll = useCallback(async () => {
    const api = tracesApi();
    if (!api) return;
    try {
      const s = await api.settings();
      setSettings(s);
      setCap(String(Math.round(s.capBytes / GB)));
      setReader(await api.readerToken());
      setReadError(null);
    } catch (e) {
      console.warn('[traces] reading the storage settings or the reader token failed:', e);
      setReadError(reasonOf(e));
    }
  }, []);
  useEffect(() => { void readAll(); }, [readAll]);

  const save = async (patch: { capBytes?: number; retentionDays?: number }) => {
    const api = tracesApi();
    if (!api) return;
    let r: Awaited<ReturnType<typeof api.setSettings>>;
    try {
      r = await api.setSettings(patch);
    } catch (e) {
      console.warn('[traces] saving the storage settings failed:', e);
      setSaveError(`not saved: ${reasonOf(e)}`);
      return;
    }
    if (r.ok) { setSettings(r.settings); setSaveError(null); void read(); } else setSaveError(r.error);
  };

  /** A token's refusal in words: main's own sentence once, or only that the call failed (the Audit's I-1 and I-2). */
  const tokenLine = (button: string, holds?: string) => {
    if (!tokenError) return '';
    if (!tokenError.answered) return `the call failed: ${tokenError.reason}. ${button} tries again.`;
    const said = holds && !/opens nothing/.test(tokenError.reason) ? ` ${holds}` : '';
    return `${tokenError.reason}.${said} ${button} tries again.`;
  };

  const capOk = /^\d+$/.test(cap) && Number(cap) >= 1;

  // A token main could not make or revoke (a refused unlink, a full disk) is said in its dialog, which stays: never an
  // unhandled rejection, never a dialog that waits without a word (the Audit's L1 on PR 599).
  const makeToken = async () => {
    const api = tracesApi();
    if (!api) return;
    let r: Awaited<ReturnType<typeof api.rotateReaderToken>>;
    try {
      r = await api.rotateReaderToken();
    } catch (e) {
      console.warn('[traces] making the reader token failed:', e);
      setTokenError({ reason: reasonOf(e), answered: false });
      return;
    }
    // Main drops the old token before it writes the new one: a refusal leaves no token at all, so the page reads again.
    if ('ok' in r) {
      setTokenError({ reason: reasonOf(r.error), answered: true });
      setReader(await api.readerToken().catch(() => null));
      return;
    }
    closeDialog();
    setCopied(false);
    setShown(r.token);
    setReader(await api.readerToken().catch(() => null));
  };

  const revoke = async () => {
    const api = tracesApi();
    if (!api) return;
    // Main refuses the token in memory at once, and answers { ok: false, error } when it cannot save that: the token
    // then opens nothing until Tars quits. A rejected call says only that it failed: nothing is known of the token.
    let r: Awaited<ReturnType<typeof api.revokeReaderToken>>;
    try {
      r = await api.revokeReaderToken();
    } catch (e) {
      console.warn('[traces] revoking the reader token failed:', e);
      setTokenError({ reason: reasonOf(e), answered: false });
      return;
    }
    if (!r.ok) {
      setTokenError({ reason: reasonOf(r.error), answered: true });
      setReader(await api.readerToken().catch(() => null));
      return;
    }
    closeDialog();
    setReader(await api.readerToken().catch(() => null));
  };

  const deleteAll = async () => {
    const api = tracesApi();
    if (!api) return;
    let r: Awaited<ReturnType<typeof api.remove>>;
    try {
      r = await api.remove({ filter: {} });
    } catch (e) {
      // Main's refusal (a full disk) reaches the window as a rejected call: said in the dialog, which stays, never an
      // unhandled rejection.
      console.warn('[traces] deleting every session failed:', e);
      setRemoveError(reasonOf(e));
      return;
    }
    setDialog(null);
    setRemoveError(null);
    setDone(`${r.deleted} session${r.deleted === 1 ? '' : 's'} deleted · ${sizeOf(r.bytesFreed)} freed`);
    void read();
  };

  if (error) return <Unread text="could not read the traces:" detail={error} onRetry={() => { void read(); }} />;

  return (
    <div className="flex flex-col gap-2.5 flex-1 min-h-0 overflow-y-auto">
      {done && <Notice tone="running" actions={<Button size="sm" variant="ghost" className="font-mono" onClick={() => setDone(null)}>close</Button>}>{done}</Notice>}
      <div className="grid grid-cols-2 gap-2.5 items-start">
        <Box name="Storage" caption="STORAGE">
          <div className="px-4 pb-3 space-y-2">
            <p className="font-serif text-[22px] leading-[1.15] text-foreground">
              {stats ? `${sizeOf(stats.bytes)} of ${sizeOf(stats.capBytes)}` : '-'}
            </p>
            <Meter share={stats ? stats.bytes / Math.max(1, stats.capBytes) : 0} tone={stats?.bodiesDropped ? 'waiting' : 'accent'} />
            <p className="font-mono text-[10.5px] text-muted-foreground">
              {stats ? `~/.tars/traces/traces.db · ${stats.sessions} sessions · ${stats.requests.toLocaleString('en-US')} requests${stats.oldest ? ` · the oldest from ${dayOf(stats.oldest)}` : ''}` : ''}
            </p>
            {stats?.bodiesDropped && <StateLine word={`at the cap: new requests keep their timings and tokens, not their messages`} tone="waiting" />}
          </div>
          <Row className="flex items-center gap-4 py-2.5">
            <div className="flex-1 min-w-0">
              <p className="text-[12.5px] text-foreground">Cap</p>
              <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">Past the cap, a sweep deletes the oldest sessions. Until it has, new requests keep their timings and tokens, not their messages.</p>
            </div>
            <div className="w-[80px] shrink-0 flex items-center gap-1.5">
              <Input aria-label="Cap, in GB" mono compact value={cap} error={!capOk}
                onChange={e => setCap(e.target.value)}
                onBlur={() => { if (capOk && settings && Number(cap) * GB !== settings.capBytes) void save({ capBytes: Number(cap) * GB }); }} />
              <span className="font-mono text-[10.5px] text-muted-foreground">GB</span>
            </div>
          </Row>
          <Row className="flex items-center gap-4 py-2.5">
            <div className="flex-1 min-w-0">
              <p className="text-[12.5px] text-foreground">Keep sessions for</p>
              <p className="mt-0.5 text-[11px] leading-tight text-muted-foreground">A session that ended longer ago than this is deleted; one still open never is.</p>
            </div>
            <Dropdown size="sm" mono="trigger" ariaLabel="Keep sessions for" className="w-[120px]"
              value={settings ? String(settings.retentionDays) : ''}
              options={[...new Set([...DAYS, settings ? String(settings.retentionDays) : '30'])].map(d => ({ value: d, label: `${d} days` }))}
              onChange={d => { void save({ retentionDays: Number(d) }); }} />
          </Row>
          {saveError && <Row><StateLine word={saveError} tone="error" /></Row>}
          {readError && <Row><div data-storage-read-error><StateLine wrap word={`not read: ${readError}. Open Storage again to read it again.`} tone="error" /></div></Row>}
          {stats?.byProject && stats.byProject.length > 0 && (
            <Row className="space-y-1.5 py-2.5">
              <PanelCaption>BY PROJECT</PanelCaption>
              {stats.byProject.map(p => (
                <div key={p.projectPath} className="flex items-center gap-3">
                  <span className="w-[90px] shrink-0 font-mono text-[11px] text-foreground truncate">{projectNameOf(p.projectPath)}</span>
                  <Meter share={p.bytes / Math.max(1, stats.bytes)} tone="muted" className="w-[220px]" />
                  <span className="font-mono text-[10.5px] text-muted-foreground">{`${sizeOf(p.bytes)} · ${p.sessions} session${p.sessions === 1 ? '' : 's'}`}</span>
                </div>
              ))}
            </Row>
          )}
          <Row className="flex justify-end py-2.5">
            <Button size="sm" variant="danger" className="font-mono" disabled={!stats || stats.sessions === 0} onClick={() => setDialog('delete-all')}>delete every session</Button>
          </Row>
        </Box>

        <div className="flex flex-col gap-2.5 min-w-0">
          <Box name="Reader access" caption="READER ACCESS">
            <div className="px-4 pb-3 space-y-2.5">
              <p className="text-[11.5px] leading-relaxed text-text-secondary">
                The reader token opens /api/traces/ and nothing else, read only: sessions, their requests and messages, never a key nor anything else Tars holds. No agent&apos;s token opens it. It is shown once, when it is made.
              </p>
              <div>
                <PanelCaption>ROUTE</PanelCaption>
                <p className="mt-0.5 font-mono text-[11.5px] text-foreground">{reader ? `GET ${reader.route} · 127.0.0.1, this computer only` : ''}</p>
              </div>
            </div>
            <Row className="flex items-center gap-3 py-2.5">
              {reader?.exists ? (
                <>
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <StateLine word="a reader token exists" tone="running" />
                    <p className="font-mono text-[10.5px] text-muted-foreground">
                      {`created ${dayClockOf(reader.createdAt ? Date.parse(reader.createdAt) : undefined)}${reader.lastUsedAt ? ` · last used ${dayClockOf(Date.parse(reader.lastUsedAt))}` : ' · never used'}`}
                    </p>
                  </div>
                  <Button size="sm" className="font-mono" onClick={() => setDialog('rotate')}>rotate</Button>
                  <Button size="sm" variant="danger" className="font-mono" onClick={() => setDialog('revoke')}>revoke</Button>
                </>
              ) : (
                <>
                  <StateLine word="no reader token: nothing reads the traces through the API" tone="idle" className="flex-1" />
                  <Button onClick={() => setDialog('create')}>Create a reader token</Button>
                </>
              )}
            </Row>
            <Row><p className="font-mono text-[10.5px] text-muted-foreground">Reaching it from another machine is a separate step, not in this version.</p></Row>
          </Box>

          <Box name="Export" caption="EXPORT">
            <div className="px-4 pb-3 space-y-2.5">
              <p className="text-[11.5px] leading-relaxed text-text-secondary">
                JSONL, one line per record: what the filters show, one session, or everything. Tars asks where to save it. An export holds the requests whole, the code your agents read and wrote included.
              </p>
              <Button size="sm" className="font-mono" onClick={() => setExporting(true)}>Export everything</Button>
            </div>
          </Box>
        </div>
      </div>

      {dialog === 'create' && (
        <DialogShell onClose={closeDialog} width={560} title="Create a reader token?"
          subtitle="It opens /api/traces/ and nothing else, read only: every recorded session, of every project. Revoke it to stop at once."
          footerRight={<><Button onClick={closeDialog}>Cancel</Button><Button variant="primary" onClick={() => { void makeToken(); }}>Create</Button></>}>
          {tokenError && <div data-token-refused={tokenError.answered ? 'answered' : 'call'}><StateLine wrap word={tokenLine('Create')} tone="error" /></div>}
        </DialogShell>
      )}
      {dialog === 'rotate' && (
        <DialogShell onClose={closeDialog} width={560} title="Rotate the reader token?"
          subtitle="The one the reader holds stops working at once. You will see the new one once, to give it to the reader."
          footerRight={<><Button onClick={closeDialog}>Cancel</Button><Button variant="primary" onClick={() => { void makeToken(); }}>Rotate</Button></>}>
          {tokenError && <div data-token-refused={tokenError.answered ? 'answered' : 'call'}><StateLine wrap word={tokenLine('Rotate', 'The old token opens nothing now.')} tone="error" /></div>}
        </DialogShell>
      )}
      {dialog === 'revoke' && (
        <DialogShell onClose={closeDialog} width={560} title="Revoke the reader token?"
          subtitle="/api/traces/ refuses every read from now on. Create another to give access again."
          footerRight={<><Button onClick={closeDialog}>Keep it</Button><Button variant="danger" onClick={() => { void revoke(); }}>Revoke</Button></>}>
          {tokenError && <div data-token-refused={tokenError.answered ? 'answered' : 'call'}><StateLine wrap word={tokenLine('Revoke', 'The token opens nothing until Tars quits.')} tone="error" /></div>}
        </DialogShell>
      )}
      {dialog === 'delete-all' && stats && (
        <DialogShell onClose={closeDialog} width={560} title={`Delete ${stats.sessions} sessions?`}
          subtitle={`Every recorded session, ${sizeOf(stats.bytes)}. The reader can no longer read them. ${BACK_OFFICE_COPY_MANY} This cannot be undone.`}
          footerRight={<><Button onClick={closeDialog}>Cancel</Button><Button variant="danger" onClick={() => { void deleteAll(); }}>{`Delete ${stats.sessions} sessions`}</Button></>}>
          {removeError && <div data-remove-refused><StateLine word={`not deleted: ${removeError}. Delete ${stats.sessions} sessions tries again.`} tone="error" /></div>}
        </DialogShell>
      )}
      {shown !== null && (
        <DialogShell
          // The token goes from the window's memory as the dialog closes, however it closes.
          onClose={() => { setShown(null); setCopyError(null); }}
          width={560}
          title="The reader token"
          footerRight={<>
            <Button variant="primary" onClick={() => {
              // The clipboard can refuse (no focus, no permission): said here, and the token stays selectable by hand.
              void navigator.clipboard.writeText(shown).then(() => { setCopied(true); setCopyError(null); }, (e: unknown) => {
                console.warn('[traces] copying the reader token failed:', e);
                setCopyError(reasonOf(e));
              });
            }}>{copied ? 'Copied' : 'Copy'}</Button>
            <Button onClick={() => { setShown(null); setCopyError(null); }}>Done</Button>
          </>}
        >
          <div className="space-y-2.5">
            <p className="text-xs text-status-waiting">Copy it now: the window will not show it again. Give it to the external reader as the Bearer of its reads.</p>
            <pre data-reader-token className="px-2.5 py-2 bg-term-bg border border-border font-mono text-[11.5px] text-foreground whitespace-pre-wrap break-all select-all">{shown}</pre>
            {copyError && <div data-token-copy-error><StateLine wrap word={`not copied: ${copyError}. Select the token above and copy it by hand.`} tone="error" /></div>}
            {reader?.createdAt && <p className="font-mono text-[10.5px] text-muted-foreground">{`created ${dayClockOf(Date.parse(reader.createdAt))}`}</p>}
          </div>
        </DialogShell>
      )}
      {exporting && <ExportDialog filter={{}} onClose={() => setExporting(false)} />}
    </div>
  );
}
