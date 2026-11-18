import { describe, it, expect } from 'vitest';
import { traceDecision, closedModel, defaultTracePairs, pairAllows, type TraceGateInput } from '../../electron/services/trace-gate';

/**
 * Who is traced (native traces). Traces are off by default and kept only for an
 * allowed pair: a harness on the owner's editable list, on a model of an approved endpoint the user marked as
 * allowing traces, with the project and the agent both opted in. One rule is hard, above the list: a Claude, GPT,
 * o-series or Gemini model is never traced, and the claude binary is never on the seeded list.
 *
 * How it fails, written before the code (19/11):
 * 1. An agent with no endpoint (its CLI's own provider, say Claude Code on Anthropic) is traced.
 * 2. A closed model is traced because the owner's list allows its harness with `*`: claude-*, gpt-*, o3, gemini-*,
 *    behind a vendor prefix (`openai/gpt-5`, `anthropic/claude-x`) too.
 * 3. An open model whose name only looks alike is refused: gemma, glm, qwen, mimo, "o" inside a word.
 * 4. The claude binary (provider claude, or any provider it runs, such as custom-openai) is on the seeded list.
 * 5. An endpoint whose allowTraces is false, or which is not approved, is traced.
 * 6. Only one of the two switches (project, agent) is enough.
 * 7. A harness not on the list is traced; a list entry whose glob does not match the model still allows it.
 * 8. A glob is read as a regular expression (a `.` or `+` in a model id matches anything else).
 * 9. The reason says nothing, so the window cannot say why a session was not traced.
 */

const base: TraceGateInput = {
  provider: 'qwen-code', model: 'open-coder-1-q8',
  endpoint: { allowTraces: true, approved: true },
  projectOptedIn: true, agentOptedIn: true, pairs: defaultTracePairs(),
};

describe('trace gate', () => {
  it('traces an open harness on an open model of an approved endpoint that allows traces, both switches on', () => {
    expect(traceDecision(base)).toEqual({ traced: true, reason: 'traced' });
  });

  it('1: no endpoint, no trace', () => {
    expect(traceDecision({ ...base, endpoint: undefined }).traced).toBe(false);
  });

  it('2: a closed model is never traced, whatever the list says', () => {
    const everything = [{ harness: '*', models: '*' }];
    for (const model of ['claude-sonnet-5', 'anthropic/claude-x', 'gpt-5.1', 'openai/gpt-oss-120b', 'o3', 'o4-mini', 'gemini-3-pro', 'google/gemini-2.5-flash']) {
      expect(closedModel(model), model).toBe(true);
      expect(traceDecision({ ...base, model, pairs: everything }).traced, model).toBe(false);
    }
  });

  it('3: open models with look-alike names are not refused', () => {
    for (const model of ['gemma-3-27b', 'open-coder-1', 'qwen3-coder-30b', 'mimo-7b', 'deepseek-coder', 'stand-in-coder', 'solo-7b']) {
      expect(closedModel(model), model).toBe(false);
    }
  });

  it('4: the seeded list holds the four open harnesses and never the claude binary', () => {
    const harnesses = defaultTracePairs().map(p => p.harness).sort();
    expect(harnesses).toEqual(['codex', 'opencode', 'pi', 'qwen-code']);
    for (const provider of ['claude', 'custom-openai', 'venice', 'gemini']) {
      expect(traceDecision({ ...base, provider }).traced, provider).toBe(false);
    }
  });

  it('5: an endpoint that does not allow traces, or is not approved, is not traced', () => {
    expect(traceDecision({ ...base, endpoint: { allowTraces: false, approved: true } }).traced).toBe(false);
    expect(traceDecision({ ...base, endpoint: { allowTraces: true, approved: false } }).traced).toBe(false);
  });

  it('6: both switches are needed', () => {
    expect(traceDecision({ ...base, projectOptedIn: false }).traced).toBe(false);
    expect(traceDecision({ ...base, agentOptedIn: false }).traced).toBe(false);
  });

  it('7: the list decides which harness and model pairs are allowed', () => {
    const pairs = [{ harness: 'codex', models: 'open-coder-*' }];
    expect(traceDecision({ ...base, provider: 'qwen-code', pairs }).traced).toBe(false);
    expect(traceDecision({ ...base, provider: 'codex', pairs }).traced).toBe(true);
    expect(traceDecision({ ...base, provider: 'codex', model: 'qwen3-coder-30b', pairs }).traced).toBe(false);
  });

  it('8: a glob is a glob: only * and ? are special', () => {
    expect(pairAllows({ harness: 'codex', models: 'open-coder-1*' }, 'codex', 'open-coder-1')).toBe(true);
    expect(pairAllows({ harness: 'codex', models: 'open-coder-1*' }, 'codex', 'open-coder-x')).toBe(false);
    expect(pairAllows({ harness: 'codex', models: 'a+b' }, 'codex', 'aab')).toBe(false);
    expect(pairAllows({ harness: 'codex', models: 'a+b' }, 'codex', 'a+b')).toBe(true);
  });

  it('9: every refusal says which condition refused it', () => {
    const reasons = [
      traceDecision({ ...base, endpoint: undefined }).reason,
      traceDecision({ ...base, model: 'gpt-5' }).reason,
      traceDecision({ ...base, endpoint: { allowTraces: false, approved: true } }).reason,
      traceDecision({ ...base, endpoint: { allowTraces: true, approved: false } }).reason,
      traceDecision({ ...base, projectOptedIn: false }).reason,
      traceDecision({ ...base, agentOptedIn: false }).reason,
      traceDecision({ ...base, provider: 'claude' }).reason,
    ];
    expect(new Set(reasons).size).toBe(reasons.length);
    for (const r of reasons) expect(r).not.toBe('traced');
  });
});
