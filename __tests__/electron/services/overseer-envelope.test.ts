import '../../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { parseEnvelope } from '../../../electron/services/overseer';

/**
 * Reading what the overseer said.
 *
 * The reply is asked for as one JSON object carrying `say` and an optional
 * action. When the model does something else, the old code handed the raw
 * string through as the message, so the chat showed
 * `"action": {"kind": "message_agent", "agent_id": "57f0c6ff-...", "text"` as
 * if that were the answer. Every path here has to end in something readable.
 */

describe('a well formed reply', () => {
  it('reads say and the action', () => {
    const out = parseEnvelope(JSON.stringify({
      say: 'Frontend is stuck on you.',
      action: { kind: 'message_agent', agent_id: 'a-1', text: 'go ahead' },
    }));
    expect(out.say).toBe('Frontend is stuck on you.');
    expect(out.action).toEqual({ agentId: 'a-1', text: 'go ahead' });
  });

  it('reads one wrapped in a code fence', () => {
    const out = parseEnvelope('```json\n{"say":"All quiet.","action":null}\n```');
    expect(out.say).toBe('All quiet.');
    expect(out.action).toBeNull();
  });

  it('drops an action that is not a message_agent', () => {
    const out = parseEnvelope(JSON.stringify({ say: 'hi', action: { kind: 'delete_everything' } }));
    expect(out.say).toBe('hi');
    expect(out.action).toBeNull();
  });

  it('drops an action missing its target', () => {
    const out = parseEnvelope(JSON.stringify({ say: 'hi', action: { kind: 'message_agent', text: 'go' } }));
    expect(out.action).toBeNull();
  });
});

describe('a reply that will not parse', () => {
  it('reads the envelope out of surrounding prose', () => {
    const out = parseEnvelope('Here is what I found:\n{"say":"Two agents are idle.","action":null}\nHope that helps.');
    expect(out.say).toBe('Two agents are idle.');
  });

  it('salvages say from a reply cut off mid-object', () => {
    // The reported case, truncated exactly as it arrived.
    const out = parseEnvelope(
      '{"say": "Backend is waiting on your review.", "action": {"kind": "message_agent", '
      + '"agent_id": "57f0c6ff-a228-4afa-8d19-1cec6791a58a", "text" ',
    );
    expect(out.say).toBe('Backend is waiting on your review.');
    expect(out.action).toBeNull();
    expect(out.say).not.toContain('agent_id');
    expect(out.say).not.toContain('{');
  });

  it('never shows envelope keys when it cannot read anything', () => {
    const out = parseEnvelope('{"action": {"kind": "message_agent", "agent_id": "57f0c6ff", "text" ');
    expect(out.say).not.toContain('agent_id');
    expect(out.say).not.toContain('message_agent');
    expect(out.say).toContain('could not read');
  });

  it('keeps escaped characters readable when salvaging', () => {
    const out = parseEnvelope('{"say": "line one\\nline \\"two\\"", "action": {');
    expect(out.say).toBe('line one\nline "two"');
  });
});

describe('a plain prose reply', () => {
  it('is passed through as the message', () => {
    const out = parseEnvelope('Nothing has changed since the last check.');
    expect(out.say).toBe('Nothing has changed since the last check.');
    expect(out.action).toBeNull();
  });

  it('does not mistake a sentence with braces for an envelope', () => {
    const out = parseEnvelope('The config has { "retries": 3 } in it, which is fine.');
    expect(out.say).toContain('which is fine');
  });

  it('handles an empty reply without throwing', () => {
    expect(() => parseEnvelope('')).not.toThrow();
  });
});
