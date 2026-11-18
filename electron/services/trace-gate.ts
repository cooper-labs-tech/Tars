/**
 * Who is traced (native traces).
 *
 * A session of an agent is kept as a trace only when all of these hold:
 * - the agent runs on an inference endpoint, which is approved, and which the user marked as allowing traces;
 * - the project and the agent are both opted in (both off by default);
 * - the harness and model pair is on the owner's list (`AppSettings.traces.pairs`). The list ships empty: what is
 *   traced is the owner's data, never a default of Tars's (Tars is a general app, the owner's decision of 19/11);
 * - with `excludeClosedModels` on, its default, the model is not a closed one (Claude, GPT, o-series, Gemini). The
 *   owner can turn it off in Settings, warned that the providers' terms may forbid training on their outputs.
 */

export interface TracePair {
  /** A provider id of Tars (`codex`, `qwen-code`...), or `*`. */
  harness: string;
  /** A glob over the model id: `*` any run of characters, `?` one; nothing else is special. */
  models: string;
  note?: string;
}

export interface TraceGateInput {
  provider: string | undefined;
  model: string | undefined;
  /** The agent's endpoint, when it runs on one. */
  endpoint?: { allowTraces: boolean; approved: boolean };
  projectOptedIn: boolean;
  agentOptedIn: boolean;
  pairs: TracePair[];
  /** Leave closed models out (the default). */
  excludeClosedModels: boolean;
}

export type TraceDecision = { traced: boolean; reason: string };

/** The owner's list as it ships: empty. Nothing is traced until the owner names a pair. */
export function defaultTracePairs(): TracePair[] {
  return [];
}

/** Said beside the closed-model setting in the window. */
export const CLOSED_MODELS_WARNING = 'Claude, GPT, o-series and Gemini models are left out of traces by default: their providers\' terms may forbid training on their outputs. Turn this off only if the terms of the models you trace allow it.';

/**
 * A closed model, read from each segment of its id (`openai/gpt-5` is two): a segment that starts with claude, gpt,
 * gemini, or o and a digit, followed by nothing, a digit or a separator. So gemma, glm or "solo" are not.
 */
export function closedModel(model: string | undefined): boolean {
  if (!model) return false;
  return model.split(/[/:]/).some(segment => /^(claude|gpt|gemini|o\d)(?=$|[-._\d])/i.test(segment));
}

function globToRegExp(glob: string): RegExp {
  const body = glob.split('').map(c => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[\\^$.|+()[\]{}]/g, '\\$&'))).join('');
  return new RegExp(`^${body}$`, 'i');
}

/** Whether one entry of the list allows this harness on this model. */
export function pairAllows(pair: TracePair, harness: string, model: string): boolean {
  if (!pair || typeof pair.harness !== 'string' || typeof pair.models !== 'string') return false;
  return (pair.harness === '*' || pair.harness === harness) && globToRegExp(pair.models).test(model);
}

/** Whether this session is traced, and the condition that decided it. */
export function traceDecision(input: TraceGateInput): TraceDecision {
  if (!input.endpoint) return { traced: false, reason: 'not on an inference endpoint' };
  if (!input.endpoint.approved) return { traced: false, reason: 'the endpoint is not approved' };
  if (!input.endpoint.allowTraces) return { traced: false, reason: 'the endpoint does not allow traces' };
  if (!input.projectOptedIn) return { traced: false, reason: 'the project is not opted in' };
  if (!input.agentOptedIn) return { traced: false, reason: 'the agent is not opted in' };
  const model = input.model ?? '';
  if (input.excludeClosedModels !== false && closedModel(model)) return { traced: false, reason: 'closed models are left out of traces (Settings)' };
  const harness = input.provider ?? '';
  if (!(input.pairs ?? []).some(p => pairAllows(p, harness, model))) {
    return { traced: false, reason: 'this harness and model pair is not on the list' };
  }
  return { traced: true, reason: 'traced' };
}
