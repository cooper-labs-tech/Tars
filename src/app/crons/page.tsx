'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import {
  Button, DialogShell, FieldError, Input, Label, LoadingState, PageHeader, StatusSquare, Textarea,
} from '@/components/ui';
// Hermes sends `schedule` as an object, not a string. Putting it straight into
// JSX threw React error #31 and killed the whole document - see schedule-text.ts.
import { formatSchedule, scheduleExpression, type CronSchedule } from './schedule-text';
import { ipcReason } from '@/lib/ipc-error';

/** A Hermes call that threw: the gateway never answered (`Shell · Schedules · Hermes did not answer`). */
const unreached = (thrown: unknown) => `Tars could not reach Hermes (${ipcReason(thrown, 'no reason given')}).`;

// Row actions are words, not glyphs (R7): 26px bordered lowercase-mono
// buttons, 8px apart, in the same order on every row.
const ROW_ACTION = 'font-mono lowercase';

/**
 * Hermes schedules. Tars does not own a scheduler: the jobs, their timers and
 * their runs live in the gateway, and this page drives them over its API.
 */

interface CronJob {
  id: string;
  name?: string;
  title?: string;
  schedule?: string | CronSchedule;
  schedule_display?: string;
  schedule_human?: string;
  enabled?: boolean;
  paused?: boolean;
  state?: string;
  status?: string;
  next_run?: string;
  next_run_at?: string;
  last_run?: string;
  last_run_at?: string;
  last_status?: string;
  command?: string;
  prompt?: string;
  profile?: string;
  profile_name?: string;
}

/**
 * Hermes is another system, and its date fields are whatever that system
 * happens to send: an ISO string, a unix timestamp in seconds, a null. Feeding
 * an unexpected one straight to `new Date(...).toLocaleString()` renders
 * "Invalid Date" at best; the point here is that one odd row must not be able
 * to take the page down with it.
 */
function formatNext(next: unknown): string {
  if (next === null || next === undefined || next === '') return '';
  try {
    const value = typeof next === 'number' && next < 1e12 ? next * 1000 : next as string | number;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return ` · next ${date.toLocaleString()}`;
  } catch {
    return '';
  }
}

function asJobs(payload: unknown): CronJob[] {
  if (Array.isArray(payload)) return payload as CronJob[];
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    for (const key of ['jobs', 'items', 'results']) {
      if (Array.isArray(obj[key])) return obj[key] as CronJob[];
    }
  }
  return [];
}

/** What the edit dialog holds while it is open. */
interface EditDraft {
  job: CronJob;
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
}

function draftFor(job: CronJob): EditDraft {
  return {
    job,
    name: job.name || job.title || '',
    schedule: scheduleExpression(job),
    // `prompt` only: `command` is a defensive alias this page renders, but it
    // is not a field Hermes stores, so an edit must never write into it.
    prompt: job.prompt || '',
    // A row reads as paused from three different fields; the editable flag is
    // the one Hermes actually stores.
    enabled: job.enabled !== false,
  };
}

export default function CronsPage() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await window.electronAPI?.hermes?.crons();
      if (!r) { setError('Electron API unavailable'); return; }
      if (!r.success) {
        setError(r.error || 'Could not read Hermes schedules');
        setNeedsSignIn(!!r.needsSignIn);
        return;
      }
      setNeedsSignIn(false);
      setJobs(asJobs(r.jobs));
    } catch (err) {
      // The call itself failed: the request to the gateway never got an answer
      // (refused, timed out). Said in words, never Electron's own preface.
      setError(`Could not read the schedules: ${unreached(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Poll only while the window is visible: Hermes has no cron websocket.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') load(); };
    const id = setInterval(tick, 15000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', tick); };
  }, [load]);

  async function act(job: CronJob, action: 'pause' | 'resume' | 'trigger') {
    setBusyId(job.id);
    try {
      await window.electronAPI?.hermes?.cronAction({ action, jobId: job.id, profile: job.profile });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Save an edit. Only the fields the user actually changed go up: Hermes
   * leaves out-of-band keys alone, and re-sending an untouched expression
   * would put it back through the parser for nothing.
   */
  async function save() {
    if (!draft) return;
    const original = draftFor(draft.job);
    const updates: Record<string, unknown> = {};
    if (draft.name !== original.name) updates.name = draft.name;
    if (draft.schedule.trim() !== original.schedule) updates.schedule = draft.schedule.trim();
    if (draft.prompt !== original.prompt) updates.prompt = draft.prompt;
    if (draft.enabled !== original.enabled) updates.enabled = draft.enabled;

    if (Object.keys(updates).length === 0) { setDraft(null); return; }
    if (typeof updates.schedule === 'string' && updates.schedule === '') {
      setSaveError('A schedule cannot be empty.');
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const r = await window.electronAPI?.hermes?.cronUpdate({
        jobId: draft.job.id, updates, profile: draft.job.profile,
      });
      if (!r?.success) {
        // The gateway rejects a bad expression with its own list of the forms
        // it accepts. Show that, keep the dialog open with the text in it.
        setSaveError(r?.error || 'Hermes refused the change');
        return;
      }
      setDraft(null);
      await load();
    } catch (err) {
      setSaveError(`Could not save the change: ${unreached(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function remove(job: CronJob) {
    if (!confirm(`Delete the schedule "${job.name || job.title || job.id}" in Hermes?`)) return;
    setBusyId(job.id);
    try {
      await window.electronAPI?.hermes?.cronDelete({ jobId: job.id, profile: job.profile });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="h-[calc(100vh-7rem)] lg:h-[calc(100vh-44px)] flex flex-col">
      <PageHeader
        title="Schedules"
        subtitle="Recurring jobs running in your Hermes gateway."
        actions={<Button size="md" onClick={load}>Refresh</Button>}
      />

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && jobs.length === 0 && (
          <LoadingState
            loading
            what="Still reading the Hermes gateway…"
            detail="waiting on /api/cron/jobs"
          />
        )}

        {error && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-6">
            <AlertCircle className="w-6 h-6 text-warning" />
            <p className="text-sm text-foreground max-w-md">{error}</p>
            <div className="flex items-center gap-2">
              <Link
                href="/settings?section=hermes"
                className="inline-flex items-center justify-center h-8 px-3 text-sm font-medium border border-primary bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {needsSignIn ? 'Sign in to Hermes' : 'Open Hermes settings'}
              </Link>
              <Button size="md" onClick={load}>Retry</Button>
            </div>
          </div>
        )}

        {!error && !loading && jobs.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
            <p className="text-sm text-muted-foreground">No schedule in this gateway yet.</p>
            <p className="text-xs text-muted-foreground">Create one in Hermes and it shows up here.</p>
          </div>
        )}

        <div className="space-y-2">
          {jobs.map(job => {
            // Hermes reports the live state in `state` ('scheduled' | 'paused');
            // `paused`/`status` never existed on its payload.
            const paused = job.paused === true || job.enabled === false
              || job.state === 'paused' || job.status === 'paused';
            const next = job.next_run_at || job.next_run;
            return (
              <div key={job.id} className="border border-border bg-card px-4 py-3 flex items-start gap-4">
                <StatusSquare tone={paused ? 'idle' : 'running'} className="mt-1" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground">{job.name || job.title || job.id}</span>
                    {job.profile_name && (
                      <span className="text-[10px] font-mono px-1 bg-secondary text-muted-foreground">{job.profile_name}</span>
                    )}
                    {paused && <span className="text-[10px] font-mono text-muted-foreground">paused</span>}
                  </div>
                  <p className="font-mono text-[11px] text-muted-foreground mt-0.5 truncate">
                    {formatSchedule(job)}
                    {formatNext(next)}
                    {job.last_status ? ` · last ${String(job.last_status)}` : ''}
                  </p>
                  {(job.prompt || job.command) && (
                    <p className="text-xs text-muted-foreground mt-1 truncate">{job.prompt || job.command}</p>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    size="sm"
                    className={ROW_ACTION}
                    onClick={() => act(job, 'trigger')}
                    disabled={busyId === job.id}
                  >
                    run now
                  </Button>
                  <Button
                    size="sm"
                    className={ROW_ACTION}
                    onClick={() => act(job, paused ? 'resume' : 'pause')}
                    disabled={busyId === job.id}
                  >
                    {paused ? 'resume' : 'pause'}
                  </Button>
                  {/* The missing control: the gateway has taken PUT
                      /api/cron/jobs/{id} all along, the page just never
                      offered a way to reach it. */}
                  <Button
                    size="sm"
                    className={ROW_ACTION}
                    onClick={() => { setSaveError(null); setDraft(draftFor(job)); }}
                    disabled={busyId === job.id}
                  >
                    edit
                  </Button>
                  <Button
                    size="sm"
                    className={ROW_ACTION}
                    onClick={() => remove(job)}
                    disabled={busyId === job.id}
                  >
                    delete
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {draft && (
        <DialogShell
          open
          onClose={() => { if (!saving) setDraft(null); }}
          title="Edit schedule"
          subtitle={`Saved straight into Hermes${draft.job.profile_name ? `, profile ${draft.job.profile_name}` : ''}.`}
          footerRight={
            <>
              <Button size="md" onClick={() => setDraft(null)} disabled={saving}>Cancel</Button>
              <Button size="md" variant="primary" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <div>
              <Label>Name</Label>
              <Input
                value={draft.name}
                onChange={e => setDraft({ ...draft, name: e.target.value })}
                placeholder={draft.job.id}
              />
            </div>

            <div>
              <Label>Schedule</Label>
              <Input
                mono
                value={draft.schedule}
                error={!!saveError && /schedule/i.test(saveError)}
                onChange={e => setDraft({ ...draft, schedule: e.target.value })}
                placeholder="0 9 * * *"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                A cron expression (0 9 * * *), an interval (every 30m), a delay (2h), or a timestamp.
              </p>
            </div>

            <div>
              <Label>Prompt</Label>
              <Textarea
                rows={6}
                value={draft.prompt}
                onChange={e => setDraft({ ...draft, prompt: e.target.value })}
                placeholder="What Hermes should run"
              />
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="accent-primary"
                checked={draft.enabled}
                onChange={e => setDraft({ ...draft, enabled: e.target.checked })}
              />
              <span className="text-xs text-foreground">Enabled</span>
            </label>

            {/* Not a field: the gateway takes `profile` in the body and
                ignores it, so a job cannot move profiles from here. */}
            <p className="text-[11px] text-muted-foreground">
              Profile {draft.job.profile_name || draft.job.profile || 'default'} and job id {draft.job.id} are fixed. Move a job between profiles in Hermes.
            </p>

            {/* Hermes' rejection for a bad expression is a multi-line list of
                the forms it accepts, so the newlines have to survive. */}
            {saveError && <FieldError><span className="whitespace-pre-line">{saveError}</span></FieldError>}
          </div>
        </DialogShell>
      )}
    </div>
  );
}
