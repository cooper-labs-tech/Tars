import { describe, it, expect, beforeEach } from 'vitest';
import { readProgramStatus, forgetProgramStatus } from '../../../../electron/services/program-status';
import { PROGRAM_STATUS_QUERY_REPLY } from '../../../../electron/services/program-status/protocol';
import type { AgentStatus } from '../../../../electron/types';

/**
 * What Tars does with OSC 7501 in an agent's terminal, in the main process (services/program-status/index.ts).
 * Measured on 22/10: claude 2.1.308 sends `OSC 7501 ; ?` then a DA1 query at start, and reports
 * (`state=idle:app=claude-code`) only once the probe is answered; codex 0.163 reports without asking.
 * Precedence: the hooks win, OSC 7501 fills the gaps (the brief of 22/10).
 *
 * How it fails, written before the code:
 * 1. The probe goes unanswered, is answered with other bytes than the reply, or is answered twice; or a probe split
 *    across two chunks is missed.
 * 2. A report from a terminal that is no longer the agent's (an old ptyId after a restart) moves the agent, or is
 *    kept as its record: the session-ownership rule.
 * 3. A report overrules the status of an agent whose CLI Tars follows otherwise (claude's hooks, codex's log).
 * 4. An agent on a CLI Tars cannot follow (grok, amp, opencode) does not follow the reports: working is running,
 *    blocked is waiting (reason permission, so nothing is typed into it), idle and done are idle, error is error.
 * 5. A blocked report's kind and message are not kept for the window, on any CLI.
 * 6. A report addressed to a sub-record (an id) moves the agent: only the root record is the agent's.
 * 7. A clear, a new shell prompt (OSC 133 A) or a full reset leaves the record behind.
 * 8. A report wakes a stopped or an asleep agent, or a stray one undoes an error the hooks reported.
 * 9. A terminal's half-read frame outlives the terminal (forgetProgramStatus).
 */

const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const osc = (body: string) => `\x1b]7501;${body}\x07`;

function agent(provider: string, status: AgentStatus['status'] = 'idle'): AgentStatus {
  return { id: `a-${provider}`, name: provider, status, provider, ptyId: 'pty-1', projectPath: '/p', skills: [], output: [], lastActivity: '' } as unknown as AgentStatus;
}

function terminal() {
  const written: string[] = [];
  return { written, write: (d: string) => { written.push(d); } };
}

beforeEach(() => {
  for (const id of ['pty-1', 'pty-2', 'pty-old']) forgetProgramStatus(id);
});

describe('the probe', () => {
  it('1. answers OSC 7501 ; ? once, with the states and kinds Tars reads, split across chunks too', () => {
    const t = terminal();
    readProgramStatus(agent('claude'), 'pty-1', t, 'banner\x1b]7501;?\x1b\\\x1b[c');
    expect(t.written).toEqual([PROGRAM_STATUS_QUERY_REPLY]);
    readProgramStatus(agent('claude'), 'pty-1', t, 'more output, no probe');
    expect(t.written).toHaveLength(1);
    readProgramStatus(agent('claude'), 'pty-1', t, 'x\x1b]75');
    readProgramStatus(agent('claude'), 'pty-1', t, '01;?\x07');
    expect(t.written).toEqual([PROGRAM_STATUS_QUERY_REPLY, PROGRAM_STATUS_QUERY_REPLY]);
  });

  it('1. answers a terminal whose agent is gone too: it asked, and the CLI waits on it', () => {
    const t = terminal();
    readProgramStatus(undefined, 'pty-2', t, osc('?'));
    expect(t.written).toEqual([PROGRAM_STATUS_QUERY_REPLY]);
  });
});

describe('reports, by who follows the CLI', () => {
  it('4. drives a grok agent: working, blocked with its kind and message, idle, done, error', () => {
    const a = agent('grok');
    const t = terminal();
    expect(readProgramStatus(a, 'pty-1', t, osc('state=working:app=grok'))).toBe(true);
    expect(a.status).toBe('running');
    expect(readProgramStatus(a, 'pty-1', t, osc(`state=blocked:kind=question:msg=${b64('Which branch?')}`))).toBe(true);
    expect(a.status).toBe('waiting');
    expect(a.waitingReason).toBe('permission');
    expect(a.programStatus).toMatchObject({ state: 'blocked', kind: 'question', msg: 'Which branch?' });
    expect(readProgramStatus(a, 'pty-1', t, osc('state=done'))).toBe(true);
    expect(a.status).toBe('idle');
    expect(a.waitingReason).toBeUndefined();
    readProgramStatus(a, 'pty-1', t, osc('state=working'));
    expect(readProgramStatus(a, 'pty-1', t, osc(`state=error:msg=${b64('quota exceeded')}`))).toBe(true);
    expect(a.status).toBe('error');
    expect(a.error).toContain('quota exceeded');
    readProgramStatus(a, 'pty-1', t, osc('state=working'));
    expect(readProgramStatus(a, 'pty-1', t, osc('state=idle'))).toBe(true);
    expect(a.status).toBe('idle');
  });

  it('4. drives amp and opencode the same way', () => {
    for (const p of ['amp', 'opencode']) {
      const a = agent(p);
      readProgramStatus(a, 'pty-1', terminal(), osc('state=working'));
      expect(a.status, p).toBe('running');
      forgetProgramStatus('pty-1');
    }
  });

  it('3 and 5. never moves a claude or a codex agent, and keeps the blocked reason for the window', () => {
    for (const p of ['claude', 'codex']) {
      const a = agent(p, 'running');
      expect(readProgramStatus(a, 'pty-1', terminal(), osc(`state=blocked:kind=auth:msg=${b64('Sign in to continue')}`)), p).toBe(false);
      expect(a.status, p).toBe('running');
      expect(a.waitingReason, p).toBeUndefined();
      expect(a.programStatus, p).toMatchObject({ state: 'blocked', kind: 'auth', msg: 'Sign in to continue' });
      expect(readProgramStatus(a, 'pty-1', terminal(), osc('state=idle')), p).toBe(false);
      expect(a.status, p).toBe('running');
      forgetProgramStatus('pty-1');
    }
  });
});

describe('what a report may not do', () => {
  it('2. a report from a terminal that is not the agent\'s moves nothing and is not kept', () => {
    const a = agent('grok');
    readProgramStatus(a, 'pty-old', terminal(), osc('state=working'));
    expect(a.status).toBe('idle');
    expect(a.programStatus).toBeUndefined();
  });

  it('6. a report addressed to a sub-record is not the agent\'s', () => {
    const a = agent('grok');
    expect(readProgramStatus(a, 'pty-1', terminal(), osc('state=working:id=build/test'))).toBe(false);
    expect(a.status).toBe('idle');
    expect(a.programStatus).toBeUndefined();
  });

  it('8. never wakes a stopped or an asleep agent', () => {
    for (const s of ['stopped', 'asleep'] as const) {
      const a = agent('grok', s);
      expect(readProgramStatus(a, 'pty-1', terminal(), osc('state=working'))).toBe(false);
      expect(a.status).toBe(s);
      forgetProgramStatus('pty-1');
    }
  });

  it('7. a clear, a new shell prompt or a full reset ends the record', () => {
    for (const end of [osc('state=clear'), '\x1b]133;A\x07', '\x1bc']) {
      const a = agent('claude', 'running');
      readProgramStatus(a, 'pty-1', terminal(), osc('state=blocked:kind=permission'));
      expect(a.programStatus).toBeDefined();
      readProgramStatus(a, 'pty-1', terminal(), end);
      expect(a.programStatus, JSON.stringify(end)).toBeUndefined();
      forgetProgramStatus('pty-1');
    }
  });

  it('9. a terminal forgotten drops its half-read frame', () => {
    const a = agent('grok');
    readProgramStatus(a, 'pty-1', terminal(), '\x1b]7501;state=work');
    forgetProgramStatus('pty-1');
    readProgramStatus(a, 'pty-1', terminal(), 'ing\x07');
    expect(a.status).toBe('idle');
  });
});
