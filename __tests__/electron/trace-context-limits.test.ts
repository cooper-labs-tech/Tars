import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppSettings } from '../../electron/types';
import { saveEndpoint, endpointViews, type EndpointActor } from '../../electron/services/inference-endpoints';
import { endpointLaunchFor, piModelsWithEndpoint } from '../../electron/services/endpoint-harness';
import { writeQwenAgentSettings } from '../../electron/services/qwen-code';

/**
 * An inference endpoint's real limits, given to the harness at launch (trace feature C2): its context window and its
 * output cap, two optional fields the owner sets in the window, passed through each harness's own knob. Measured on
 * 27/11 (reports of trace-c2, fenced real binaries): codex 0.163 takes `-c model_context_window` and
 * `-c model_max_output_tokens`, and for a model it does not know assumes 258,400 tokens; Qwen Code 0.25.2 takes
 * `model.generationConfig.contextWindowSize` and `samplingParams.max_tokens` in its settings file, and assumes 200,000.
 * Pi's models.json (`contextWindow`, `maxTokens`) and opencode's model `limit` (`context`, `output`) are from the docs.
 * Both measured harnesses compact on their own: `autoCompaction` is `on` for them, null where not measured.
 *
 * How it fails, written before the code (27/11):
 * L1. The limits are not kept with the endpoint, or not shown in its view.
 * L2. A window or a cap a harness cannot take is saved: under 1,024 or over 10,000,000 tokens, not a whole number, a cap
 *     of 0 or over the window. Clearing one (null) does not clear it.
 * L3. An agent sets them: only the owner does, in the window.
 * L4. A save of another field loses them.
 * L5. Codex is not given them (`-c model_context_window`, `-c model_max_output_tokens`), or is given them when the
 *     endpoint has none; what it was given is not said (`given`).
 * L6. Qwen Code's settings file does not hold them, or holds them when there are none.
 * L7. Pi's models.json does not give the launching model its limits, or gives them to another endpoint's model.
 * L8. A harness with no knob for what the endpoint gives (opencode takes a window only with a cap) is said to have been
 *     given it, or is given half.
 * L9. A value bigger than the harness allows (a settings file edited by hand: a window of 20,000,000, a cap over the
 *     window) is passed on: it is not, and `given` says null.
 */

const NOW = '2026-11-27T12:00:00.000Z';
const OWNER: EndpointActor = { window: true };
const AGENT: EndpointActor = { agentId: 'agent-remote', agentName: 'Remote-Tuner' };
const base = (): AppSettings => ({ inferenceEndpoints: [] } as unknown as AppSettings);
const PROXY = 'http://127.0.0.1:31417/v1';
/** What the window's form showed when it opened: a save of an endpoint that exists names it (the stale-form guard). */
const shownOf = (e: { baseUrl: string; extraHeaders?: Record<string, string> }) => ({ baseUrl: e.baseUrl, extraHeaders: e.extraHeaders ?? {} });

function added(over: Record<string, unknown> = {}) {
  const r = saveEndpoint(base(), { name: 'Remote host', baseUrl: 'http://192.168.50.10:9000/v1', allowTraces: false, ...over }, OWNER, NOW);
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe('an endpoint\'s limits', () => {
  it('L1: kept with the endpoint, and shown', () => {
    const r = added({ contextWindow: 65_536, maxOutputTokens: 16_384 });
    expect(r.endpoint).toMatchObject({ contextWindow: 65_536, maxOutputTokens: 16_384 });
    expect(endpointViews(r.settings, [])[0]).toMatchObject({ contextWindow: 65_536, maxOutputTokens: 16_384 });
    // None set: none shown, none made up.
    const none = added();
    expect(none.endpoint.contextWindow).toBeUndefined();
    expect(endpointViews(none.settings, [])[0].contextWindow).toBeUndefined();
  });

  it('L2: a window or a cap a harness cannot take is refused, and null clears', () => {
    for (const bad of [{ contextWindow: 1000 }, { contextWindow: 10_000_001 }, { contextWindow: 65_536.5 }, { contextWindow: '65536' },
      { maxOutputTokens: 0 }, { contextWindow: 8192, maxOutputTokens: 8193 }, { maxOutputTokens: -1 }]) {
      const r = saveEndpoint(base(), { name: 'x', baseUrl: 'http://192.168.50.10:9000/v1', allowTraces: false, ...bad } as never, OWNER, NOW);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/context window|output cap/);
    }
    const r = added({ contextWindow: 65_536, maxOutputTokens: 16_384 });
    const cleared = saveEndpoint(r.settings, { id: r.endpoint.id, contextWindow: null, maxOutputTokens: null, shown: shownOf(r.endpoint) } as never, OWNER, NOW);
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.endpoint.contextWindow).toBeUndefined();
      expect(cleared.endpoint.maxOutputTokens).toBeUndefined();
    }
  });

  it('L3: only the owner sets them', () => {
    const r = added();
    const byAgent = saveEndpoint(r.settings, { id: r.endpoint.id, contextWindow: 65_536 } as never, AGENT, NOW);
    expect(byAgent.ok).toBe(false);
  });

  it('L4: a save of another field keeps them', () => {
    const r = added({ contextWindow: 65_536, maxOutputTokens: 16_384 });
    const renamed = saveEndpoint(r.settings, { id: r.endpoint.id, name: 'Renamed', shown: shownOf(r.endpoint) }, OWNER, NOW);
    expect(renamed.ok && renamed.endpoint).toMatchObject({ name: 'Renamed', contextWindow: 65_536, maxOutputTokens: 16_384 });
  });
});

describe('what each harness is given', () => {
  it('L5: codex gets its two knobs, and says what it was given', () => {
    const l = endpointLaunchFor('codex', { proxyBase: PROXY, model: 'open-coder', contextWindow: 65_536, maxOutputTokens: 16_384 })!;
    expect(l.args.join(' ')).toContain('-c model_context_window=65536');
    expect(l.args.join(' ')).toContain('-c model_max_output_tokens=16384');
    expect(l.given).toEqual({ contextWindow: 65_536, outputCap: 16_384, autoCompaction: 'on' });
    const none = endpointLaunchFor('codex', { proxyBase: PROXY, model: 'open-coder' })!;
    expect(none.args.join(' ')).not.toMatch(/model_context_window|model_max_output_tokens/);
    expect(none.given).toEqual({ contextWindow: null, outputCap: null, autoCompaction: 'on' });
  });

  it('L6: Qwen Code gets them in its settings file, and only when there are some', () => {
    const l = endpointLaunchFor('qwen-code', { proxyBase: PROXY, model: 'open-coder', contextWindow: 65_536, maxOutputTokens: 16_384 })!;
    expect(l.given).toEqual({ contextWindow: 65_536, outputCap: 16_384, autoCompaction: 'on' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-limits-'));
    try {
      const system = path.join(dir, 'none.json');
      const withLimits = JSON.parse(fs.readFileSync(writeQwenAgentSettings('a1', { generation: l.given, systemFile: system }, dir), 'utf8'));
      expect(withLimits.model.generationConfig).toEqual({ contextWindowSize: 65_536, samplingParams: { max_tokens: 16_384 } });
      const plain = JSON.parse(fs.readFileSync(writeQwenAgentSettings('a2', { effort: 'high', systemFile: system }, dir), 'utf8'));
      expect(plain.model).toEqual({ reasoningEffort: 'high' });
      const both = JSON.parse(fs.readFileSync(writeQwenAgentSettings('a3', { effort: 'high', generation: { contextWindow: 65_536, outputCap: null, autoCompaction: 'on' }, systemFile: system }, dir), 'utf8'));
      expect(both.model).toEqual({ reasoningEffort: 'high', generationConfig: { contextWindowSize: 65_536 } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('L7: pi\'s models.json gives the launching model its limits, and no other', () => {
    const file = piModelsWithEndpoint({}, PROXY, ['open-coder', 'other-model'], { model: 'open-coder', contextWindow: 65_536, outputCap: 16_384 });
    const models = (file.providers as Record<string, { models: Array<Record<string, unknown>> }>)['tars-endpoint'].models;
    expect(models.find(m => m.id === 'open-coder')).toEqual({ id: 'open-coder', contextWindow: 65_536, maxTokens: 16_384 });
    expect(models.find(m => m.id === 'other-model')).toEqual({ id: 'other-model' });
    const l = endpointLaunchFor('pi', { proxyBase: PROXY, model: 'open-coder', contextWindow: 65_536, maxOutputTokens: 16_384 })!;
    expect(l.given).toEqual({ contextWindow: 65_536, outputCap: 16_384, autoCompaction: null });
  });

  it('L8: a harness with no knob for what the endpoint gives says null, and is given nothing', () => {
    const both = endpointLaunchFor('opencode', { proxyBase: PROXY, model: 'open-coder', contextWindow: 65_536, maxOutputTokens: 16_384 })!;
    const config = JSON.parse(both.env.OPENCODE_CONFIG_CONTENT);
    expect(config.provider['tars-endpoint'].models['open-coder'].limit).toEqual({ context: 65_536, output: 16_384 });
    expect(both.given).toEqual({ contextWindow: 65_536, outputCap: 16_384, autoCompaction: null });
    const half = endpointLaunchFor('opencode', { proxyBase: PROXY, model: 'open-coder', contextWindow: 65_536 })!;
    expect(JSON.parse(half.env.OPENCODE_CONFIG_CONTENT).provider['tars-endpoint'].models['open-coder'].limit).toBeUndefined();
    expect(half.given).toEqual({ contextWindow: null, outputCap: null, autoCompaction: null });
  });

  it('L9: a value bigger than the harness allows is not passed on', () => {
    const big = endpointLaunchFor('codex', { proxyBase: PROXY, model: 'open-coder', contextWindow: 20_000_000, maxOutputTokens: 16_384 })!;
    expect(big.args.join(' ')).not.toContain('model_context_window');
    expect(big.args.join(' ')).toContain('model_max_output_tokens=16384');
    expect(big.given).toMatchObject({ contextWindow: null, outputCap: 16_384 });
    const over = endpointLaunchFor('qwen-code', { proxyBase: PROXY, model: 'open-coder', contextWindow: 8192, maxOutputTokens: 9000 })!;
    expect(over.given).toMatchObject({ contextWindow: 8192, outputCap: null });
  });
});
