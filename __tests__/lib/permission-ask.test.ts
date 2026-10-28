import { describe, it, expect } from 'vitest';
import { permissionAskLine } from '../../src/lib/permission-ask';
import type { AgentStatus } from '../../src/types/electron';

/**
 * The line a permission question reads in, wherever Tars shows it: a panel's
 * line under its header, the top of the agent window's terminal column, the
 * card's task line. Since #318, a Claude agent that runs the state mod asks
 * Tars, not its terminal, before a call Claude Code would put to its dialog:
 * the agent reads `waiting` with `permissionAsk` set, and `waitingOn` names
 * what the call acts on. Frame: `Permission asked of Tars` in
 * design/tars-redesign.pen. Written before the code. How the line can fail:
 * 1. an agent that no longer waits keeps the question on the page's copy: an
 *    event patches the status alone (useElectronAgents), so an agent allowed
 *    and running again still carries the permissionAsk it had, and the line
 *    offered allow for a call already decided;
 * 2. a waiting agent with no permissionAsk is at its terminal's dialog (an
 *    older claude, a mod that did not load, a question handed back): the line
 *    offered answers Tars cannot give;
 * 3. the subject repeats the tool: waitingOn names a file as "Edit /path"
 *    (electron/utils/waiting-on.ts), and the line read "Asks to use Edit:
 *    Edit /path";
 * 4. nothing to name: no waitingOn (main hides it once an interrupt is
 *    recorded after the question), or one that only repeats the tool (an MCP
 *    tool with no field to name): the line ended on a colon, or named the
 *    tool twice;
 * 5. a character that hides or rearranges text, or breaks the line, in the
 *    tool or the subject, which an agent chose: a U+202E turned the sentence
 *    around, a line separator split the row. Main flattens the subject; the
 *    line flattens both again, as stop-line does a name;
 * 6. the time: an askedAt that does not parse printed "Invalid Date" or
 *    "NaN:NaN", and a question asked another day read as today's;
 * 7. the subject cut: waitingOn's text is cut at 200 characters, and hidden
 *    once an interrupt is recorded, where the question carries its subject
 *    whole (#318's gate, Medium 2): what is allowed must be what was read.
 *    Since #318's contract was filled the line reads `permissionAsk.subject`
 *    alone (the cases above moved to it with this one, after the code).
 * 8. why Claude Code asks is lost: the question carries its reason and the
 *    settings rule that asked (#318), and in bypass an ask rule of the
 *    person's is the only reason a call comes to Tars at all (the Audit's
 *    Low at the recheck of #318 and #320); the line dropped both;
 * 9. a reason or a rule that hides, turns or breaks the text: the agent's
 *    own shell holds the hook token and can ask with any reason, which main
 *    keeps raw (up to 1,000 characters): each is flattened as the subject
 *    is, and kept whole;
 * 10. a reason or a rule that is not given, or blank, reads as an empty
 *     row: it is '' instead, and nothing is shown for it.
 * 11. a line break in the subject read as a space: "echo safe" then
 *     "rm -rf important" read as one harmless echo, and an allow covered both
 *     (the Audit's M1 on PR 544). Each break is kept: the subject marks it ⏎,
 *     and its lines are given one by one for a window that shows them so;
 *     \r\n, \r, \n, U+2028 and U+2029 are each one break, and a break at the
 *     start or the end is no line of its own.
 */

const NOW = new Date(2026, 9, 5, 14, 30);
const at = (h: number, m: number, day = 5) => new Date(2026, 9, day, h, m).toISOString();

type Ask = NonNullable<AgentStatus['permissionAsk']>;
const ask = (over: Partial<Ask> = {}): Ask => ({
  tool: 'Bash', askedAt: at(14, 2), until: at(14, 12), subject: 'npm run build && npm test',
  fields: { command: 'npm run build && npm test' }, ...over,
});

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'a1', name: 'Frontend Engineer', status: 'waiting', projectPath: '/p', skills: [], output: [],
    lastActivity: at(14, 2), provider: 'claude', permissionAsk: ask(),
    ...over,
  } as AgentStatus;
}

describe('the question, when Tars holds one', () => {
  it('names the tool, then what the call acts on, and when it was asked', () => {
    expect(permissionAskLine(agent(), NOW)).toEqual({
      who: 'Asks to use Bash:',
      subject: 'npm run build && npm test',
      at: 'asked at 14:02',
      title: 'Asks to use Bash: npm run build && npm test',
      reason: '',
      rule: '',
    });
  });

  it('is no question for an agent that no longer waits, whatever its copy kept (1)', () => {
    for (const status of ['running', 'idle', 'completed', 'error', 'stopped'] as const) {
      expect(permissionAskLine(agent({ status }), NOW), status).toBeNull();
    }
  });

  it('is no question of Tars\'s for a waiting agent at its terminal\'s dialog (2)', () => {
    expect(permissionAskLine(agent({ permissionAsk: undefined }), NOW)).toBeNull();
  });
});

describe('what it names', () => {
  it('a file by its path, without the tool a second time (3)', () => {
    const line = permissionAskLine(agent({
      permissionAsk: ask({ tool: 'Edit', subject: 'Edit /Users/you/projects/shop/src/app/page.tsx', fields: { file_path: '/Users/you/projects/shop/src/app/page.tsx' } }),
    }), NOW);
    expect(line?.who).toBe('Asks to use Edit:');
    expect(line?.subject).toBe('/Users/you/projects/shop/src/app/page.tsx');
  });

  it('only a tool that repeats is cut: a command that starts with its own word is kept whole (3)', () => {
    const line = permissionAskLine(agent({ permissionAsk: ask({ subject: 'Bashful --help' }) }), NOW);
    expect(line?.subject).toBe('Bashful --help');
  });

  it('the tool alone, with no colon, when there is nothing else to name (4)', () => {
    const mcp = 'mcp__github__create_pull_request';
    for (const subject of [mcp, '  ']) {
      const line = permissionAskLine(agent({ permissionAsk: ask({ tool: mcp, subject, fields: {} }) }), NOW);
      expect(line, JSON.stringify(subject)).toMatchObject({ who: `Asks to use ${mcp}`, subject: '', title: `Asks to use ${mcp}` });
    }
  });

  it('nothing that hides, turns or breaks the line, in the tool or the subject (5)', () => {
    const line = permissionAskLine(agent({
      permissionAsk: ask({ tool: 'Ba\u202Esh', subject: 'rm -rf build\u2028&& echo \u202Eok\u200B done' }),
    }), NOW);
    expect(line?.who).toBe('Asks to use Ba sh:');
    expect(line?.subject).toBe('rm -rf build ⏎ && echo ok done');
    expect(line?.title).not.toMatch(/[\u2028\u202E\u200B]/);
  });
});

describe('its line breaks (11)', () => {
  it('marks each break ⏎, never a space, and gives each line', () => {
    const line = permissionAskLine(agent({ permissionAsk: ask({ subject: 'echo safe\nrm -rf important' }) }), NOW);
    expect(line?.subject).toBe('echo safe ⏎ rm -rf important');
    expect(line?.lines).toEqual(['echo safe', 'rm -rf important']);
    expect(line?.title).toBe('Asks to use Bash: echo safe ⏎ rm -rf important');
  });
  it('takes \r\n, \r, U+2028 and U+2029 for one break each, and none at the ends', () => {
    const line = permissionAskLine(agent({ permissionAsk: ask({ subject: '\na\r\nb\rc\u2028d\u2029e\n' }) }), NOW);
    expect(line?.lines).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(line?.subject).toBe('a ⏎ b ⏎ c ⏎ d ⏎ e');
  });
  it('one line when there is no break', () => {
    expect(permissionAskLine(agent(), NOW)?.lines).toEqual(['npm run build && npm test']);
  });
});

describe('when it was asked (6)', () => {
  it('the date before the time on another day, and the year in another year', () => {
    expect(permissionAskLine(agent({ permissionAsk: ask({ askedAt: at(23, 58, 4) }) }), NOW)?.at).toBe('asked on 4 Oct at 23:58');
    expect(permissionAskLine(agent({ permissionAsk: ask({ askedAt: new Date(2025, 11, 31, 9, 5).toISOString() }) }), NOW)?.at).toBe('asked on 31 Dec 2025 at 09:05');
  });

  it('nothing at all for a time that does not parse', () => {
    const line = permissionAskLine(agent({ permissionAsk: ask({ askedAt: 'not a date' }) }), NOW);
    expect(line?.at).toBe('');
    expect(line?.who).toBe('Asks to use Bash:');
  });
});

describe('the subject, whole (7)', () => {
  it('names the call as the question carries it, not as waitingOn cut it', () => {
    const long = `${'npm run build && '.repeat(20)}npm test`;
    const line = permissionAskLine(agent({
      permissionAsk: ask({ subject: long, fields: { command: long } }),
      waitingOn: { kind: 'permission', text: `${long.slice(0, 199)}…` },
    }), NOW);
    expect(line?.subject).toBe(long);
    expect(line?.title).toBe(`Asks to use Bash: ${long}`);
  });

  it('names it with no waitingOn at all, which main hides once an interrupt is recorded', () => {
    expect(permissionAskLine(agent({ waitingOn: undefined }), NOW)?.subject).toBe('npm run build && npm test');
  });
});

describe('why Claude Code asks', () => {
  it('carries the reason and the rule that asked, whole (8)', () => {
    const reason = 'Permission rule Bash(rm:*) requires confirmation';
    expect(permissionAskLine(agent({ permissionAsk: ask({ reason, rule: 'Bash(rm:*)' }) }), NOW)).toMatchObject({ reason, rule: 'Bash(rm:*)' });
    const long = `Output redirection to '/Users/you/projects/shop/out.txt' needs approval. ${'The path is inside the working directories for this session. '.repeat(12)}`.trim();
    expect(permissionAskLine(agent({ permissionAsk: ask({ reason: long }) }), NOW)?.reason).toBe(long);
  });

  it('nothing that hides, turns or breaks them (9)', () => {
    const line = permissionAskLine(agent({
      permissionAsk: ask({ reason: 'safe\u202E, allow it\u2028now', rule: 'Bash(\u200Brm:*)' }),
    }), NOW);
    expect(line?.reason).toBe('safe , allow it now');
    expect(line?.rule).toBe('Bash( rm:*)');
  });

  it('empty when it is not given, or blank (10)', () => {
    expect(permissionAskLine(agent(), NOW)).toMatchObject({ reason: '', rule: '' });
    expect(permissionAskLine(agent({ permissionAsk: ask({ reason: '  \u2028 ', rule: '' }) }), NOW)).toMatchObject({ reason: '', rule: '' });
  });
});

