'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AgentProvider, EndpointView, HarnessId, HarnessSupport, TraceOfferCode } from '@/types/electron';
import { Button, Dropdown, PanelCaption, SegmentedControl, StatusSquare } from '@/components/ui';
import type { SegmentedOption, StatusTone } from '@/components/ui';
import { lastPathPart } from '@/lib/display-path';
import { PROVIDER_REGISTRY } from '@/lib/providers';
import { clockOf, healthOf } from '@/lib/traces-format';
import { Toggle } from '@/components/Settings/Toggle';

/** The four open harnesses Tars runs on an inference endpoint (PLAN.md § 4). */
export const ENDPOINT_HARNESSES: HarnessId[] = ['codex', 'pi', 'qwen-code', 'opencode'];
export const runsOnEndpoints = (p: AgentProvider): p is HarnessId => (ENDPOINT_HARNESSES as string[]).includes(p);

type RunsOn = 'own' | 'endpoint';
const RUNS_ON: readonly SegmentedOption<RunsOn>[] = [
  { value: 'own', label: 'its own account' },
  { value: 'endpoint', label: 'an endpoint' },
];

const labelOf = (p: AgentProvider) => PROVIDER_REGISTRY.find(r => r.id === p)?.label ?? p;

/** Main's gate says why with a stable code (TraceOfferCode); the window words it as the frames do. */
type OfferReason = 'own-account' | 'closed-model' | 'not-on-list' | 'endpoint-not-approved' | 'endpoint-disallows' | 'project-off' | 'other';
const GATE_CODES: Partial<Record<TraceOfferCode, OfferReason>> = {
  'no-endpoint': 'own-account',
  'endpoint-not-approved': 'endpoint-not-approved',
  'endpoint-disallows': 'endpoint-disallows',
  'project-off': 'project-off',
  'closed-model': 'closed-model',
  'not-on-list': 'not-on-list',
};

/** What a closed model's id names, for the sentence that says it is not recorded (a default of Settings). */
function closedFamily(model: string): string {
  if (/claude/i.test(model)) return 'Claude';
  if (/gpt/i.test(model)) return 'GPT';
  if (/gemini/i.test(model)) return 'Gemini';
  return 'an o-series model';
}

/** The harness's measured support, as one line under the endpoint and model. */
function harnessLine(provider: AgentProvider, support?: HarnessSupport): { text: string; tone: StatusTone | 'muted'; refused: boolean } {
  const label = labelOf(provider);
  if (!support || support.toolCalls === 'unmeasured') {
    return { text: `${label} was not measured on this computer: it may work, Tars does not say it does.`, tone: 'waiting', refused: false };
  }
  if (support.toolCalls === 'failed') {
    return { text: `${label}'s tool calls failed against an endpoint here${support.note ? ` (${support.note})` : ''}. Pick another harness for an endpoint model.`, tone: 'error', refused: true };
  }
  const path = support.api === 'responses' ? '/v1/responses' : '/v1/chat/completions';
  return { text: `${label}${support.measuredOn ? ` ${support.measuredOn}` : ''} reaches it through Tars, on ${path}; its tool calls were measured working. The key stays in Tars.`, tone: 'muted', refused: false };
}

export interface EndpointChoice {
  endpointId: string | null;
  traces: boolean;
}

/**
 * RUNS ON and Record traces, in New agent and Edit agent (frames `Overlay · New agent · on an endpoint`,
 * `Overlay · Edit agent · on an endpoint`, and their states). An open harness runs on its own account or on an
 * approved endpoint's model; Record traces is offered only when main's trace gate says so (traces.offer), and its
 * line says why not otherwise, with where to change it. `blocked` tells the dialog a create or a save would be
 * refused: an endpoint not approved, a model it does not serve, a harness whose tool calls failed.
 */
export function EndpointFields({ provider, model, onModelChange, projectPath, choice, onChoiceChange, onBlocked, endpoints, harnesses }: {
  provider: AgentProvider;
  model: string;
  onModelChange: (m: string) => void;
  projectPath: string;
  choice: EndpointChoice;
  onChoiceChange: (c: EndpointChoice) => void;
  onBlocked: (why: string | null) => void;
  endpoints: EndpointView[] | null;
  harnesses: HarnessSupport[];
}) {
  const router = useRouter();
  const open = runsOnEndpoints(provider);
  const runsOn: RunsOn = open && choice.endpointId ? 'endpoint' : 'own';
  const endpoint = endpoints?.find(e => e.id === choice.endpointId);
  const support = harnesses.find(h => h.harness === provider);
  const line = harnessLine(provider, support);
  const [offer, setOffer] = useState<{ offered: boolean; reason: OfferReason; said: string } | null>(null);

  // Main's own gate, asked again whenever the pair changes: the window copies none of its rules.
  useEffect(() => {
    let cancelled = false;
    const api = window.electronAPI?.traces;
    if (!api || !projectPath) { setOffer(null); return; }
    void api.offer({ provider, model, endpointId: runsOn === 'endpoint' && choice.endpointId ? choice.endpointId : undefined, projectPath })
      .then(r => {
        if (cancelled) return;
        // offered counts only the agent's own switch: a project not opted in is still a reason, as the frame draws it
        // (not offered: <project> does not record traces, open Projects), since nothing would be recorded.
        if (r.offered && !r.projectOptedIn) setOffer({ offered: false, reason: 'project-off', said: r.reason });
        else setOffer({ offered: r.offered, reason: GATE_CODES[r.code] ?? 'other', said: r.reason });
      })
      .catch(() => { if (!cancelled) setOffer(null); });
    return () => { cancelled = true; };
  }, [provider, model, runsOn, choice.endpointId, projectPath]);

  // Not offered means not recorded: the switch never stays on behind a reason.
  useEffect(() => {
    if (offer && !offer.offered && choice.traces) onChoiceChange({ ...choice, traces: false });
  }, [offer, choice, onChoiceChange]);

  const served = !!endpoint && endpoint.models.includes(model);
  const blocked = runsOn !== 'endpoint' ? null
    : !endpoint ? 'pick an endpoint'
      : !endpoint.approved ? `${endpoint.name} waits for your approval`
        : !served ? `${model} is not among ${endpoint.name}'s models`
          : line.refused ? line.text : null;
  useEffect(() => { onBlocked(blocked); }, [blocked, onBlocked]);

  const project = lastPathPart(projectPath) || 'this project';
  const reason = useMemo(() => {
    if (!offer) return null;
    if (offer.offered) return { word: `allowed: the endpoint allows traces, and ${project} records them`, tone: 'running' as StatusTone };
    switch (offer.reason) {
      // Only a session that goes through an endpoint is recorded: an agent on its own account never is, whatever its model.
      case 'own-account': return { word: 'not offered: only an agent on an inference endpoint is recorded', tone: 'idle' as StatusTone };
      case 'closed-model': return { word: `not offered: ${model} names ${closedFamily(model)}, and closed models are not recorded`, tone: 'idle' as StatusTone, go: '/settings?section=inference-endpoints', goLabel: 'open Settings' };
      case 'not-on-list': return { word: `not offered: ${labelOf(provider)} on ${model} is not among the pairs that may be traced`, tone: 'idle' as StatusTone, go: '/traces?view=pairs', goLabel: 'open Traces' };
      case 'endpoint-not-approved': return { word: `not offered: ${endpoint?.name ?? 'the endpoint'} waits for your approval`, tone: 'waiting' as StatusTone, go: '/settings?section=inference-endpoints', goLabel: 'open Settings' };
      case 'endpoint-disallows': return { word: `not offered: ${endpoint?.name ?? 'the endpoint'} does not allow traces`, tone: 'waiting' as StatusTone, go: '/settings?section=inference-endpoints', goLabel: 'open Settings' };
      case 'project-off': return { word: `not offered: ${project} does not record traces`, tone: 'waiting' as StatusTone, go: '/projects', goLabel: 'open Projects' };
      default: return { word: `not offered: ${offer.said}`, tone: 'idle' as StatusTone };
    }
  }, [offer, provider, model, project, endpoint]);

  const endpointOptions = (endpoints ?? []).map(e => ({
    value: e.id,
    label: e.name,
    hint: e.approved ? healthOf(e.health).word.split(' · ')[0] : 'not approved',
  }));
  const modelOptions = (endpoint?.models ?? []).map(m => ({ value: m, label: m }));
  if (endpoint && model && !served) modelOptions.unshift({ value: model, label: model });

  const off = !offer?.offered;
  const go = reason && 'go' in reason ? reason : null;

  return (
    <div className="space-y-4">
      {open && (
        <div className="space-y-2" data-runs-on={runsOn}>
          <div className="flex items-center gap-2.5">
            <PanelCaption>Runs on</PanelCaption>
            <span className="flex-1" />
            <SegmentedControl
              ariaLabel="Runs on"
              options={RUNS_ON}
              value={runsOn}
              onChange={v => {
                if (v === 'own') { onChoiceChange({ endpointId: null, traces: false }); return; }
                const first = (endpoints ?? []).find(e => e.approved) ?? endpoints?.[0];
                if (!first) { router.push('/settings?section=inference-endpoints'); return; }
                onChoiceChange({ ...choice, endpointId: first.id });
                if (!first.models.includes(model) && first.models[0]) onModelChange(first.models[0]);
              }}
            />
          </div>
          {runsOn === 'endpoint' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="min-w-0">
                  <PanelCaption className="mb-1.5">Endpoint</PanelCaption>
                  <Dropdown ariaLabel="Endpoint" value={choice.endpointId ?? ''} options={endpointOptions}
                    onChange={id => {
                      onChoiceChange({ ...choice, endpointId: id });
                      const next = endpoints?.find(e => e.id === id);
                      if (next && !next.models.includes(model) && next.models[0]) onModelChange(next.models[0]);
                    }} />
                </div>
                <div className="min-w-0">
                  <PanelCaption className="mb-1.5">Model</PanelCaption>
                  <Dropdown mono ariaLabel="Endpoint model" value={model}
                    searchable={modelOptions.length > 12} searchPlaceholder={`filter the ${modelOptions.length} models`}
                    options={modelOptions.map(o => ({ ...o, hint: o.value === model && !served ? 'not served' : undefined }))}
                    onChange={onModelChange} />
                </div>
              </div>
              <p className={`font-mono text-[10.5px] leading-snug ${
                blocked && blocked !== line.text ? 'text-status-error' : line.tone === 'error' ? 'text-status-error' : line.tone === 'waiting' ? 'text-status-waiting' : 'text-muted-foreground'}`}>
                {!endpoint ? 'Pick one of the endpoints of Settings, Inference endpoints.'
                  : !endpoint.approved ? `${endpoint.name} waits for your approval, in Settings, Inference endpoints: no agent can use it until then.`
                    : !served ? `${model} is no longer among the endpoint's models: pick another before it starts.`
                      : endpoint.modelsError ? `${endpoint.name}'s models were not read${endpoint.modelsReadAt ? `; the list of ${clockOf(endpoint.modelsReadAt)} is kept` : ''}. ${line.text}`
                        : line.text}
              </p>
            </>
          )}
        </div>
      )}

      <div data-record-traces={offer?.offered ? 'offered' : 'not-offered'} className="flex items-center gap-3 px-3 py-2.5 border border-border">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className={`text-[12.5px] ${off ? 'text-muted-foreground' : 'text-foreground'}`}>Record traces</p>
          <p className="text-[11px] leading-snug text-muted-foreground">
            Its sessions are kept in Traces, inside Tars, as long as Traces keeps them. An external reader reads them with the reader token.
          </p>
          {reason && (
            <span className={`flex items-center gap-1.5 font-mono text-[10.5px] ${reason.tone === 'running' ? 'text-status-running' : reason.tone === 'waiting' ? 'text-status-waiting' : 'text-muted-foreground'}`}>
              <StatusSquare tone={reason.tone} />
              <span>{reason.word}</span>
            </span>
          )}
        </div>
        {go && go.go && <Button size="sm" variant="ghost" className="font-mono" onClick={() => router.push(go.go!)}>{go.goLabel}</Button>}
        <Toggle label="Record traces" enabled={choice.traces && !off} disabled={off} onChange={() => onChoiceChange({ ...choice, traces: !choice.traces })} />
      </div>
    </div>
  );
}
