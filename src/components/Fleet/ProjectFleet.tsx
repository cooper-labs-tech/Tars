'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FleetProject, FleetScheduleInput, FleetWindow } from '@/types/electron';
import { Button, Input, Panel, PanelCaption, SegmentedControl, StatusSquare } from '@/components/ui';
import type { SegmentedOption, StatusTone } from '@/components/ui';
import { comparablePath } from '@/lib/display-path';

type Zone = 'UTC' | 'local' | '';
type OnStart = NonNullable<FleetScheduleInput['onStart']>;
const ZONES: readonly SegmentedOption<'UTC' | 'local'>[] = [{ value: 'UTC', label: 'UTC' }, { value: 'local', label: "this computer's" }];
const ON_START: readonly SegmentedOption<OnStart>[] = [{ value: 'resume-queues', label: 'resume the queues' }, { value: 'start-agents', label: 'also start workers at rest' }];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const pad = (n: number) => String(n).padStart(2, '0');
/** 22:00, of an ISO time, in the zone the hours are set in. */
function clockIn(iso: string | undefined, zone: 'UTC' | 'local'): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return zone === 'UTC' ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** 19/11 */
function dayIn(iso: string | undefined, zone: 'UTC' | 'local'): string {
  if (!iso) return '';
  const d = new Date(iso);
  return zone === 'UTC' ? `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}` : `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}
/** UTC+04:00, this computer's offset now. */
function localOffset(): string {
  const m = -new Date().getTimezoneOffset();
  return `UTC${m >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(m) / 60))}:${pad(Math.abs(m) % 60)}`;
}

function Line({ word, tone }: { word: string; tone: StatusTone }) {
  const ink = tone === 'idle' ? 'text-muted-foreground' : tone === 'running' ? 'text-status-running' : tone === 'waiting' ? 'text-status-waiting' : 'text-status-error';
  return <p className={`flex items-center gap-1.5 font-mono text-[10.5px] ${ink}`}><StatusSquare tone={tone} /><span className="min-w-0">{word}</span></p>;
}

/** One line of the record: what, then main's words. */
function Rec({ k, v, tone }: { k: string; v: string; tone?: 'waiting' }) {
  return (
    <div className="flex gap-2.5">
      <span className="w-[74px] shrink-0 font-mono text-[10.5px] text-muted-foreground">{k}</span>
      <span className={`min-w-0 text-[11.5px] leading-[1.45] ${tone === 'waiting' ? 'text-status-waiting' : 'text-text-secondary'}`}>{v}</span>
    </div>
  );
}

/** The window's record, as the frames write it, from main's FleetWindow. */
function WindowRecord({ w, zone, open }: { w: FleetWindow; zone: 'UTC' | 'local'; open: boolean }) {
  const z = zone === 'UTC' ? ' UTC' : '';
  const names = (xs: string[]) => xs.join(', ');
  const opened = [`${clockIn(w.openedAt, zone)}${w.late ? `, late: ${w.late}` : ', on time'}`];
  if (w.resumed.length) opened.push(`resumed the queues of ${names(w.resumed)}`);
  if (w.started.length) opened.push(`started ${names(w.started)}`);
  const stoppedAtOnce = w.stopped.filter(s => !s.afterTurn).map(s => s.agent);
  const afterTurn = w.stopped.filter(s => s.afterTurn).map(s => `${s.agent} after its turn${s.stoppedAt ? ` (${clockIn(s.stoppedAt, zone)})` : ''}`);
  return (
    <Panel data-fleet-window={open ? 'open' : 'last'}>
      <PanelCaption className="mb-2">{`${open ? 'THIS WINDOW' : 'LAST WINDOW'} · ${dayIn(w.start, zone)} ${clockIn(w.start, zone)} TO ${dayIn(w.end, zone)} ${clockIn(w.end, zone)}${z}`}</PanelCaption>
      <div className="space-y-1.5">
        <Rec k="opened" v={opened.join(' · ')} />
        {w.startFailed.map(f => <Rec key={`f${f.agent}`} k="not started" v={`${f.agent}: ${f.why}`} tone="waiting" />)}
        {w.warnings.map(x => <Rec key={`${x.kind}${x.at}`} k={x.kind.startsWith('unknown') ? 'not known' : 'warning'} v={x.text} tone={x.kind.startsWith('unknown') ? undefined : 'waiting'} />)}
        {w.slept.map(s => <Rec key={`s${s.at}`} k="slept" v={`${clockIn(s.at, zone)} to ${s.wokeAt ? clockIn(s.wokeAt, zone) : 'not woken yet'}: the agents' turns may have died with it`} tone="waiting" />)}
        {w.stopping.length > 0 && <Rec k="stopping" v={`${names(w.stopping.map(s => s.agent))} ${w.stopping.length === 1 ? 'stops' : 'stop'} after the turn in progress`} tone="waiting" />}
        {w.ended === 'cleared'
          ? <Rec k="ended" v={`${clockIn(w.closedAt, zone)}: the hours were cleared, nobody was stopped and no queue paused`} />
          : w.closedAt && <Rec k="closed" v={[`${clockIn(w.closedAt, zone)}${w.closedLate ? `, late: ${w.closedLate}` : ''}`,
              stoppedAtOnce.length ? `stopped ${names(stoppedAtOnce)} at once` : '', afterTurn.length ? `stopped ${names(afterTurn)}` : ''].filter(Boolean).join(' · ')} />}
        {w.leftRunning.map(l => <Rec key={`l${l.agent}`} k="left" v={`${l.agent}: ${l.why}`} tone="waiting" />)}
      </div>
    </Panel>
  );
}

/**
 * A project's hours and its cap (2.0.7, PR 593), in its Projects panel. The hours open and close a daily window, the
 * zone always said (UTC or this computer's); outside, its workers' queues pause and its workers stop, each after its
 * turn, while its orchestrator and its chats' runners keep running (PR 593 since 65341b1d1). The cap holds its workers
 * at work at once. Below, the window open now or the last one, as main recorded it. Frames:
 * `Projects · a project · hours and cap`, `Projects · hours and cap · states`, and their light copies.
 */
export function ProjectFleet({ projectPath }: { projectPath: string }) {
  const api = typeof window !== 'undefined' ? window.electronAPI?.fleet : undefined;
  const [project, setProject] = useState<FleetProject | null>(null);
  const [start, setStart] = useState('');
  const [stop, setStop] = useState('');
  const [zone, setZone] = useState<Zone>('');
  const [onStart, setOnStart] = useState<OnStart>('resume-queues');
  const [cap, setCap] = useState('');
  const [hoursError, setHoursError] = useState<string | null>(null);
  const [capError, setCapError] = useState<string | null>(null);

  const key = comparablePath(projectPath);
  const take = useCallback((projects: FleetProject[]) => {
    const p = projects.find(x => comparablePath(x.projectPath) === key) ?? null;
    setProject(p);
  }, [key]);

  // The form starts from what is set, read again when the project changes.
  const reset = useCallback((p: FleetProject | null) => {
    setStart(p?.schedule?.start ?? '');
    setStop(p?.schedule?.stop ?? '');
    setZone(p?.schedule?.timeZone ?? '');
    setOnStart(p?.schedule?.onStart ?? 'resume-queues');
    setCap(p?.cap ? String(p.cap.cap) : '');
    setHoursError(null);
    setCapError(null);
  }, []);

  useEffect(() => {
    if (!api) return;
    void api.state().then(s => { const p = s.projects.find(x => comparablePath(x.projectPath) === key) ?? null; setProject(p); reset(p); });
    return api.onChanged(s => take(s.projects));
  }, [api, key, take, reset]);

  if (!api) return null;

  const timesOk = HHMM.test(start) && HHMM.test(stop);
  const saveHours = async () => {
    if (!zone) { setHoursError('pick the time zone: UTC or this computer\'s'); return; }
    const r = await api.setSchedule(projectPath, { start, stop, timeZone: zone, onStart });
    if (!r.success) { setHoursError(`${r.error}${r.code ? ` (${r.code})` : ''}`); return; }
    setHoursError(null);
    setProject(r.project);
  };
  const clearHours = async () => {
    const r = await api.clearSchedule(projectPath);
    if (!r.success) { setHoursError(r.error); return; }
    setProject(r.project);
    reset(r.project);
  };
  const saveCap = async (value: number | null) => {
    const r = await api.setCap(projectPath, value);
    if (!r.success) { setCapError(`${r.error}${r.code ? ` (${r.code})` : ''}`); return; }
    setCapError(null);
    setProject(r.project);
    setCap(r.project.cap ? String(r.project.cap.cap) : '');
  };

  const s = project?.schedule;
  const z: 'UTC' | 'local' = s?.timeZone ?? (zone || 'UTC');
  const w = project?.window;
  const windowOpen = !!w && !w.closedAt;
  const hoursState: { word: string; tone: StatusTone } = hoursError ? { word: 'not saved', tone: 'error' }
    : !s ? { word: 'no hours', tone: 'idle' }
      : windowOpen && w!.stopping.length > 0 ? { word: `closing · ${w!.stopping.map(x => x.agent).join(', ')} ${w!.stopping.length === 1 ? 'stops' : 'stop'} after the turn in progress`, tone: 'waiting' }
        : windowOpen && w!.late ? { word: `open now, opened late: ${w!.late}`, tone: 'waiting' }
          : s.next.open ? { word: `open now · until ${clockIn(s.next.end, z)}${z === 'UTC' ? ' UTC' : ''} · keeps this computer awake`, tone: 'running' }
            : { word: `closed · opens ${dayIn(s.next.start, z)} at ${clockIn(s.next.start, z)}${z === 'UTC' ? ' UTC' : ''}`, tone: 'idle' };
  const capNumber = Number(cap);
  const capOk = cap === '' || (Number.isInteger(capNumber) && capNumber >= 1 && capNumber <= 64);

  return (
    <div className="space-y-3" data-project-fleet>
      <Panel data-fleet-hours>
        <PanelCaption className="mb-2">HOURS</PanelCaption>
        <p className="mb-2.5 text-[11.5px] leading-snug text-text-secondary">
          {s ? `${s.line.charAt(0).toUpperCase()}${s.line.slice(1)}. Outside them, its workers' queues pause and its workers stop, each after its turn; its orchestrator and its chats keep running.`
            : 'No hours: its agents work whenever they have work. Set a start and a stop to pause and stop its workers outside them; its orchestrator stays on.'}
        </p>
        <div className="flex items-end gap-2.5">
          <label className="space-y-1">
            <PanelCaption>START</PanelCaption>
            <Input aria-label="Start" mono compact className="w-[76px]" width="full" placeholder="22:00" value={start} error={start !== '' && !HHMM.test(start)} onChange={e => { setStart(e.target.value); setHoursError(null); }} />
          </label>
          <label className="space-y-1">
            <PanelCaption>STOP</PanelCaption>
            <Input aria-label="Stop" mono compact className="w-[76px]" width="full" placeholder="06:00" value={stop} error={stop !== '' && !HHMM.test(stop)} onChange={e => { setStop(e.target.value); setHoursError(null); }} />
          </label>
          <div className="space-y-1">
            <PanelCaption>TIME ZONE</PanelCaption>
            <SegmentedControl ariaLabel="Time zone" options={ZONES} value={(zone || '') as 'UTC' | 'local'} onChange={v => { setZone(v); setHoursError(null); }} />
          </div>
        </div>
        <p className={`mt-1.5 font-mono text-[10.5px] ${zone ? 'text-muted-foreground' : 'text-status-waiting'}`}>
          {zone ? `this computer's time is ${localOffset()} now` : "pick the time zone: UTC or this computer's"}
        </p>
        <div className="mt-2.5 space-y-1">
          <PanelCaption>WHEN THEY BEGIN</PanelCaption>
          <SegmentedControl ariaLabel="When the hours begin" options={ON_START} value={onStart} onChange={setOnStart} />
        </div>
        {hoursError && <p className="mt-2 font-mono text-[10.5px] text-status-error">{hoursError}</p>}
        <div className="mt-2.5"><Line word={hoursState.word} tone={hoursState.tone} /></div>
        <div className="mt-2.5 flex items-center gap-2">
          <span className="font-mono text-[10.5px] text-muted-foreground">{s ? `set by ${s.setBy}, ${dayIn(s.setAt, 'local')} ${clockIn(s.setAt, 'local')}` : ''}</span>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" className="font-mono" disabled={!s} onClick={() => { void clearHours(); }}>clear the hours</Button>
          <Button size="sm" variant="primary" disabled={!timesOk || !zone} onClick={() => { void saveHours(); }}>Save</Button>
        </div>
      </Panel>

      <Panel data-fleet-cap>
        <PanelCaption className="mb-2">CAP</PanelCaption>
        <div className="flex items-center gap-2.5">
          <span className="flex-1 text-[12.5px] text-foreground">Workers at work at once</span>
          <Input aria-label="Cap" mono compact className="w-[64px]" width="full" placeholder="none" value={cap} error={!capOk || !!capError} onChange={e => { setCap(e.target.value); setCapError(null); }} />
          <span className="font-mono text-[10.5px] text-muted-foreground">1 to 64</span>
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">Its orchestrator is not counted; a chat&apos;s runner is. A task past the cap waits in its agent&apos;s queue, first come first served.</p>
        {capError && <p className="mt-2 font-mono text-[10.5px] text-status-error">{capError}</p>}
        <div className="mt-2.5 flex items-center gap-2">
          <span className="font-mono text-[10.5px] text-muted-foreground">{project?.cap ? `set by ${project.cap.setBy}, ${dayIn(project.cap.setAt, 'local')} ${clockIn(project.cap.setAt, 'local')}` : 'no cap: every worker may work at once'}</span>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" className="font-mono" disabled={!project?.cap} onClick={() => { void saveCap(null); }}>remove the cap</Button>
          <Button size="sm" variant="primary" disabled={!capOk || cap === ''} onClick={() => { void saveCap(capNumber); }}>Save</Button>
        </div>
      </Panel>

      {w && <WindowRecord w={w} zone={z} open={windowOpen} />}
    </div>
  );
}
