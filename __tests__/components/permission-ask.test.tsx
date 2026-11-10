import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, deferred, elements, ofType, textOf, type Mount } from './hook-runtime';
import { useElectronAgents } from '../../src/hooks/useElectron';
import PermissionAskNotice from '../../src/components/PermissionAskNotice';
import { Button, Input } from '../../src/components/ui';
import type { AgentStatus, AgentTickItem } from '../../src/types/electron';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * A permission question Tars holds (#318), answered from the window: the
 * line under a panel's header and the top of the agent window's terminal
 * column (`PermissionAskNotice`), fed by useElectronAgents. Frame:
 * `Permission asked of Tars`. Written before the code. How it can fail:
 *
 * The list the page reads (useElectronAgents). Since #318's contract was
 * filled, every status event of a question carries it (`permissionAsk`, null
 * at its end) and so does the tick; these three moved to it, after the code:
 * 1. the event carries the question, and the page patched the status alone,
 *    so the question never showed, or read the whole fleet again for it;
 * 2. an event carrying null (an answer, ask in terminal, the ten minutes, a
 *    stop) leaves the question answered on screen, the agent still waiting;
 * 3. a tick carrying the question, its event missed, shows none.
 *
 * The line (PermissionAskNotice):
 * 4. allow, deny or ask in terminal sends another decision than its own, or
 *    for another agent;
 * 5. deny sends at once, with no step for a reason; Enter in that step sends
 *    anything but deny with what was typed; spaces go as a reason; Esc
 *    answers, or reaches the window behind (the agent window closes on Esc,
 *    a fullscreen panel leaves fullscreen) instead of going back;
 * 6. a second click while the first answer is on its way answers twice;
 * 7. Tars answers that it holds no question (`success: false`: the ten
 *    minutes ran out, the turn ended, another window answered), or the call
 *    fails, and the line goes on offering the answers as if one had landed;
 * 8. the next call's question (another askedAt) inherits the last one's
 *    state: the reason step still open, or too late for a question just
 *    asked;
 * 9. a reason longer than main keeps (200, permission-asks.ts) is cut by main
 *    without a word: the field takes no more;
 * 10. a call cut on a panel's line is allowed from there, read only in a
 *     title (the Audit's Low at this PR's gate): the line offers allow only
 *     once the whole call fits it; show all opens it whole in the panel, with
 *     the three answers. The window shows it whole and offers allow.
 * 11. why Claude Code asks is not shown where the call is read whole (the
 *     Audit's Low at the recheck of #318 and #320): the window, and a panel's
 *     call shown whole, show the reason and the rule that asked under the
 *     call, each only when it was given, and the call stays above them;
 *     neither shows as an empty row.
 *
 * Every question approved from the window (2.0.7, approve-everywhere; frame `Permission asked of Tars`, its rows
 * `approve a file, shown whole`, `a cut view, and while it is read`, `the question changed`). Written before the
 * code; cases 4 to 10 now expect the fingerprint every answer names, which main requires for an allow:
 * 12. an answer names no fingerprint, or another than the question's shown; a view that gives none (cut, or from an
 *     older main) is allowed on what it shows;
 * 13. a cut view is allowed from a panel's line that fits, or from the window before the whole question is read; once
 *     read, a field is still shown cut, or the allow names the view's fingerprint and not the whole question's;
 * 14. an allow main refused because the question changed in between (`another-question`) reads late, or hides the
 *     new question, or allows it by itself, or says it in other words than main's;
 * 15. ask in terminal stays a first answer: in the window it is not the ghost after deny;
 * 16. the window shows a value without its field's name, or a long one without its size above it;
 * 17. a refusal's code is not followed (#588 after its Audit): `read-first` not read again before allow, `withheld`
 *     still offered allow, `not-a-decision` not said, each in other words than main's sentence.
 */

type Tick = (items: AgentTickItem[]) => void;
type StatusEvent = (event: { agentId: string; status: string; timestamp: string; permissionAsk?: AgentStatus['permissionAsk'] | null }) => void;

const ASK = {
  tool: 'Bash', askedAt: '2026-10-05T12:02:00.000Z', until: '2026-10-05T12:12:00.000Z',
  subject: 'npm run build && npm test', fields: { command: 'npm run build && npm test' }, fingerprint: 'fp1',
};
const LONG = `rm -rf build && ${'npm run build && '.repeat(12)}npm test`;
/** Main's sentences for its refusals (electron/services/permission-asks.ts). */
const ANOTHER = 'The agent asked about another call meanwhile: read the new question before you answer it';
const READ_FIRST = 'An allow names the question it was given for: open the question whole, then allow it';
const WITHHELD = 'Tars could not receive this question whole, so it cannot be allowed here: refuse it, or answer it in the terminal';
const NOT_A_DECISION = 'An answer is allow, deny or ask';

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'a1', name: 'Frontend Engineer', status: 'running', projectPath: '/p', skills: [], output: [],
    lastActivity: '2026-10-05T12:00:00.000Z', currentTask: 'Build and test', provider: 'claude', cliRunning: true,
    ...over,
  } as AgentStatus;
}

function tickItem(a: AgentStatus, over: Partial<AgentTickItem> = {}): AgentTickItem {
  return {
    id: a.id, name: a.name ?? a.id, character: 'robot', status: a.status, displayStatus: 'working', statusLine: '',
    currentTask: a.currentTask ?? '', projectName: 'p', lastActivity: a.lastActivity, provider: 'claude',
    cliRunning: a.cliRunning, leftFullscreen: false, launching: false, ...over,
  } as AgentTickItem;
}

const g = globalThis as unknown as { window?: unknown };

describe('useElectronAgents reads what a waiting agent waits on', () => {
  let listed: AgentStatus[];
  let tick: Tick | undefined;
  let status: StatusEvent | undefined;
  let hook: Mount<ReturnType<typeof useElectronAgents>>;

  beforeEach(async () => {
    listed = [agent()];
    const noop = () => () => {};
    g.window = {
      electronAPI: {
        agent: {
          list: vi.fn(async () => listed),
          onOutput: noop, onError: noop, onComplete: noop,
          onStatus: (cb: StatusEvent) => { status = cb; return () => { status = undefined; }; },
          onTick: (cb: Tick) => { tick = cb; return () => { tick = undefined; }; },
        },
      },
    };
    hook = mount(() => useElectronAgents());
    await settle();
  });

  afterEach(() => {
    hook.unmount();
    delete g.window;
  });

  // The list read again stays the old one throughout: only the event or the
  // tick can carry the question here.
  it('a status event carrying the question sets it (1)', async () => {
    status!({ agentId: 'a1', status: 'waiting', timestamp: ASK.askedAt, permissionAsk: ASK });
    await settle();
    expect(hook.result.agents[0]).toMatchObject({ status: 'waiting', permissionAsk: ASK });
  });

  it('an event carrying null drops it, though the agent still waits (2)', async () => {
    status!({ agentId: 'a1', status: 'waiting', timestamp: ASK.askedAt, permissionAsk: ASK });
    await settle();
    status!({ agentId: 'a1', status: 'waiting', timestamp: ASK.askedAt, permissionAsk: null });
    await settle();
    expect(hook.result.agents[0].status).toBe('waiting');
    expect(hook.result.agents[0].permissionAsk).toBeUndefined();
  });

  it('a tick carrying the question sets it, and one without it drops it (3)', async () => {
    const [a] = hook.result.agents;
    tick!([tickItem(a, { status: 'waiting', permissionAsk: ASK })]);
    await settle();
    expect(hook.result.agents[0].permissionAsk).toEqual(ASK);
    tick!([tickItem(a, { status: 'waiting' })]);
    await settle();
    expect(hook.result.agents[0].permissionAsk).toBeUndefined();
  });
});

describe('the line answers the question Tars holds', () => {
  let answer: ReturnType<typeof vi.fn>;
  let reply: ReturnType<typeof deferred<{ success: boolean }>>;

  beforeEach(() => {
    reply = deferred<{ success: boolean }>();
    answer = vi.fn(() => reply.promise);
    g.window = { electronAPI: { agent: { answerPermission: answer } } };
  });
  afterEach(() => { delete g.window; });

  const asking = (over: Partial<AgentStatus> = {}) => agent({ status: 'waiting', permissionAsk: ASK, ...over });
  /** The panel's line measured, as its browser would: the call fits it, or is cut. */
  const measure = (view: Mount<unknown>, fits: boolean) => {
    const subject = elements(view.result).find(e => 'data-subject' in (e.props ?? {}));
    expect(subject, 'the line names the call in an element of its own').toBeDefined();
    (subject!.props.ref as (el: unknown) => void)({ scrollWidth: fits ? 100 : 400, clientWidth: 200 });
  };
  const buttons = (tree: unknown) => ofType(tree, Button).map(b => ({ text: textOf(b.props.children as never), props: b.props as { onClick?: () => void; disabled?: boolean } }));
  const button = (tree: unknown, text: string) => {
    const found = buttons(tree).find(b => b.text === text);
    expect(found, `a button "${text}"`).toBeDefined();
    return found!;
  };
  const field = (tree: unknown) => ofType(tree, Input)[0]?.props as undefined | {
    value: string; maxLength?: number;
    onChange: (e: { target: { value: string } }) => void;
    onKeyDown: (e: { key: string; preventDefault: () => void; stopPropagation: () => void }) => void;
  };
  const key = (k: string) => ({ key: k, preventDefault: vi.fn(), stopPropagation: vi.fn() });

  for (const layout of ['panel', 'window'] as const) {
    describe(`in the ${layout}`, () => {
      /** Opened on a call the panel's line holds whole, measured as its browser would. */
      const open = (agentOf: () => AgentStatus) => {
        const view = mount(() => PermissionAskNotice({ agent: agentOf(), layout }));
        if (layout === 'panel') measure(view, true);
        return view;
      };
      const fit = (view: Mount<unknown>) => { if (layout === 'panel') measure(view, true); };

      it('shows nothing for an agent with no question of Tars\'s', () => {
        expect(mount(() => PermissionAskNotice({ agent: agent({ status: 'waiting', waitingOn: { kind: 'permission', text: 'npm test' } }), layout })).result).toBeNull();
        expect(mount(() => PermissionAskNotice({ agent: agent({ permissionAsk: ASK }), layout })).result).toBeNull();
      });

      it('names the call, and each answer sends its own decision for this agent (4)', async () => {
        const view = open(() => asking());
        expect(textOf(view.result as never)).toContain('npm run build && npm test');
        expect(buttons(view.result).map(b => b.text)).toEqual(['allow', 'deny', 'ask in terminal']);
        button(view.result, 'allow').props.onClick!();
        expect(answer).toHaveBeenCalledWith('a1', 'allow', undefined, 'fp1');

        const other = open(() => asking({ id: 'a2' }));
        button(other.result, 'ask in terminal').props.onClick!();
        expect(answer).toHaveBeenLastCalledWith('a2', 'ask', undefined, 'fp1');
      });

      it('deny asks for a reason first: Enter sends it, spaces are none, Esc goes back without answering (5)', () => {
        let a = asking();
        const view = open(() => a);
        button(view.result, 'deny').props.onClick!();
        expect(answer).not.toHaveBeenCalled();
        expect(buttons(view.result).map(b => b.text)).toEqual(['deny', 'back']);

        const esc = key('Escape');
        field(view.result)!.onKeyDown(esc);
        expect(esc.stopPropagation, 'Esc stays in the line').toHaveBeenCalled();
        expect(answer).not.toHaveBeenCalled();
        expect(buttons(view.result).map(b => b.text)).toEqual(['allow', 'deny', 'ask in terminal']);

        button(view.result, 'deny').props.onClick!();
        field(view.result)!.onChange({ target: { value: '   ' } });
        button(view.result, 'deny').props.onClick!();
        expect(answer).toHaveBeenLastCalledWith('a1', 'deny', undefined, 'fp1');

        a = asking({ permissionAsk: { ...ASK, askedAt: '2026-10-05T12:04:00.000Z' } });
        view.rerender();
        button(view.result, 'deny').props.onClick!();
        field(view.result)!.onChange({ target: { value: '  use the cached build  ' } });
        field(view.result)!.onKeyDown(key('Enter'));
        expect(answer).toHaveBeenLastCalledWith('a1', 'deny', 'use the cached build', 'fp1');
      });

      it('the field takes no more than main keeps (9)', () => {
        const view = open(() => asking());
        button(view.result, 'deny').props.onClick!();
        expect(field(view.result)!.maxLength).toBe(200);
      });

      it('answers once: the three are off while the answer is on its way, and stay off once it landed (6)', async () => {
        const view = open(() => asking());
        button(view.result, 'allow').props.onClick!();
        expect(buttons(view.result).every(b => b.props.disabled)).toBe(true);
        button(view.result, 'ask in terminal').props.onClick!();
        expect(answer).toHaveBeenCalledTimes(1);
        reply.resolve({ success: true });
        await settle();
        expect(buttons(view.result).every(b => b.props.disabled)).toBe(true);
      });

      it('says so when Tars no longer holds the question, or the call fails, and offers nothing (7)', async () => {
        const view = open(() => asking());
        button(view.result, 'allow').props.onClick!();
        reply.resolve({ success: false });
        await settle();
        expect(textOf(view.result as never)).toContain('Tars no longer holds this question');
        expect(buttons(view.result)).toHaveLength(0);

        reply = deferred<{ success: boolean }>();
        const failing = open(() => asking({ id: 'a2' }));
        button(failing.result, 'allow').props.onClick!();
        reply.reject(new Error('No handler registered'));
        await settle();
        expect(textOf(failing.result as never)).toContain('Tars no longer holds this question');
      });

      it('the next call\'s question starts afresh (8)', async () => {
        let a = asking();
        const view = open(() => a);
        button(view.result, 'allow').props.onClick!();
        reply.resolve({ success: false });
        await settle();
        a = asking({ permissionAsk: { ...ASK, askedAt: '2026-10-05T12:05:00.000Z', subject: 'npm run lint', fields: { command: 'npm run lint' } } });
        view.rerender();
        fit(view);
        expect(textOf(view.result as never)).toContain('npm run lint');
        expect(buttons(view.result).map(b => [b.text, !!b.props.disabled])).toEqual([['allow', false], ['deny', false], ['ask in terminal', false]]);

        button(view.result, 'deny').props.onClick!();
        a = asking({ permissionAsk: { ...ASK, askedAt: '2026-10-05T12:06:00.000Z' } });
        view.rerender();
        fit(view);
        expect(buttons(view.result).map(b => b.text)).toEqual(['allow', 'deny', 'ask in terminal']);
      });
    });
  }

  describe('a call too long for a panel\'s line (10)', () => {
    const long = () => asking({ permissionAsk: { ...ASK, subject: LONG, fields: { command: LONG } } });

    it('the line offers show all, not allow, until it is known to hold the call whole', () => {
      const view = mount(() => PermissionAskNotice({ agent: long(), layout: 'panel' }));
      expect(buttons(view.result).map(b => b.text)).toEqual(['show all', 'deny', 'ask in terminal']);
      measure(view, false);
      expect(buttons(view.result).map(b => b.text)).toEqual(['show all', 'deny', 'ask in terminal']);
      measure(view, true);
      expect(buttons(view.result).map(b => b.text)).toEqual(['allow', 'deny', 'ask in terminal']);
    });

    it('show all opens the call whole in the panel, with allow, which allows it', () => {
      const view = mount(() => PermissionAskNotice({ agent: long(), layout: 'panel' }));
      measure(view, false);
      button(view.result, 'show all').props.onClick!();
      expect(textOf(view.result as never)).toContain(LONG);
      expect(buttons(view.result).map(b => b.text)).toEqual(['allow', 'deny', 'ask in terminal']);
      button(view.result, 'allow').props.onClick!();
      expect(answer).toHaveBeenCalledWith('a1', 'allow', undefined, 'fp1');
    });

    it('the window shows it whole, and offers allow', () => {
      const view = mount(() => PermissionAskNotice({ agent: long(), layout: 'window' }));
      expect(textOf(view.result as never)).toContain(LONG);
      expect(buttons(view.result).map(b => b.text)).toEqual(['allow', 'deny', 'ask in terminal']);
    });
  });

  describe('why Claude Code asks, under the call (11)', () => {
    const REASON = 'Permission rule Bash(rm:*) requires confirmation';
    const terms = (tree: unknown) => ofType(tree, 'dt').map(d => textOf(d.props.children as never));
    const said = (tree: unknown) => ofType(tree, 'dd').map(d => textOf(d.props.children as never));

    it('the window shows the reason and the rule that asked, each only when given', () => {
      const both = mount(() => PermissionAskNotice({ agent: asking({ permissionAsk: { ...ASK, reason: REASON, rule: 'Bash(rm:*)' } }), layout: 'window' }));
      expect(terms(both.result)).toEqual(['why', 'rule']);
      expect(said(both.result)).toEqual([REASON, 'Bash(rm:*)']);
      const text = textOf(both.result as never);
      expect(text.indexOf(ASK.subject), 'the call first').toBeGreaterThan(-1);
      expect(text.indexOf(ASK.subject)).toBeLessThan(text.indexOf(REASON));

      const reasonOnly = mount(() => PermissionAskNotice({ agent: asking({ permissionAsk: { ...ASK, reason: REASON } }), layout: 'window' }));
      expect(terms(reasonOnly.result)).toEqual(['why']);
      const ruleOnly = mount(() => PermissionAskNotice({ agent: asking({ permissionAsk: { ...ASK, reason: '  ', rule: 'Bash(rm:*)' } }), layout: 'window' }));
      expect(terms(ruleOnly.result)).toEqual(['rule']);
      const none = mount(() => PermissionAskNotice({ agent: asking(), layout: 'window' }));
      expect(ofType(none.result, 'dl')).toHaveLength(0);
    });

    it('a panel shows them with the call it opened whole', () => {
      const view = mount(() => PermissionAskNotice({
        agent: asking({ permissionAsk: { ...ASK, subject: LONG, fields: { command: LONG }, reason: REASON, rule: 'Bash(rm:*)' } }),
        layout: 'panel',
      }));
      measure(view, false);
      button(view.result, 'show all').props.onClick!();
      expect(terms(view.result)).toEqual(['why', 'rule']);
      expect(said(view.result)).toEqual([REASON, 'Bash(rm:*)']);
    });
  });

  describe('every question approved from the window', () => {
    const WHOLE_CONTENT = Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join('\n');
    const CUT = {
      ...ASK, tool: 'Write', subject: 'Write /p/src/a.ts', fingerprint: undefined,
      fields: { file_path: '/p/src/a.ts', content: WHOLE_CONTENT.slice(0, 2000) },
      cut: [{ field: 'content', length: WHOLE_CONTENT.length }],
    };
    const WHOLE = {
      tool: 'Write', askedAt: ASK.askedAt, until: ASK.until, subject: 'Write /p/src/a.ts',
      fields: { file_path: '/p/src/a.ts', content: WHOLE_CONTENT }, jsonFields: [], fingerprint: 'fpW',
    };
    let question: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      question = vi.fn(async () => ({ success: true, question: WHOLE }));
      g.window = { electronAPI: { agent: { answerPermission: answer, permissionQuestion: question } } };
    });

    it('a view with no fingerprint is never allowed on what it shows (12)', () => {
      const view = mount(() => PermissionAskNotice({ agent: asking({ permissionAsk: { ...ASK, fingerprint: undefined } }), layout: 'panel' }));
      measure(view, true);
      expect(buttons(view.result).map(b => b.text)).toEqual(['show all', 'deny', 'ask in terminal']);
    });

    it('a cut view: show all in a panel even when it fits; the window allows once the whole question is read, naming its fingerprint (13)', async () => {
      const panel = mount(() => PermissionAskNotice({ agent: asking({ permissionAsk: CUT }), layout: 'panel' }));
      measure(panel, true);
      expect(buttons(panel.result).map(b => b.text)).toEqual(['show all', 'deny', 'ask in terminal']);

      const view = mount(() => PermissionAskNotice({ agent: asking({ permissionAsk: CUT }), layout: 'window' }));
      expect(buttons(view.result).map(b => b.text)).toEqual(['deny', 'ask in terminal']);
      expect(textOf(view.result as never)).toContain('reading the whole question');
      await settle();
      view.rerender();
      expect(question).toHaveBeenCalledWith('a1');
      expect(textOf(view.result as never)).toContain('const line399 = 399;');
      expect(buttons(view.result).map(b => b.text)).toEqual(['allow', 'deny', 'ask in terminal']);
      button(view.result, 'allow').props.onClick!();
      expect(answer).toHaveBeenCalledWith('a1', 'allow', undefined, 'fpW');
    });

    it('an allow refused because the question changed: said, the new one shown, nothing allowed by itself (14)', async () => {
      const view = mount(() => PermissionAskNotice({ agent: asking(), layout: 'window' }));
      question.mockImplementation(async () => ({ success: true, question: { ...WHOLE, tool: 'Bash', subject: 'npm publish', fields: { command: 'npm publish' }, fingerprint: 'fp2' } }));
      button(view.result, 'allow').props.onClick!();
      (reply.resolve as (v: unknown) => void)({ success: false, code: 'another-question', error: ANOTHER });
      await settle();
      view.rerender();
      const text = textOf(view.result as never);
      expect(text).toContain(ANOTHER);
      expect(text).toContain('npm publish');
      expect(buttons(view.result).map(b => [b.text, !!b.props.disabled])).toEqual([['allow', false], ['deny', false], ['ask in terminal', false]]);
      expect(answer).toHaveBeenCalledTimes(1);
      reply = deferred<{ success: boolean }>();
      button(view.result, 'allow').props.onClick!();
      expect(answer).toHaveBeenLastCalledWith('a1', 'allow', undefined, 'fp2');
    });

    it('read-first: said, the question read whole again, allow once it is shown (17)', async () => {
      const view = mount(() => PermissionAskNotice({ agent: asking(), layout: 'window' }));
      button(view.result, 'allow').props.onClick!();
      (reply.resolve as (v: unknown) => void)({ success: false, code: 'read-first', error: READ_FIRST });
      await settle();
      view.rerender();
      await settle();
      view.rerender();
      expect(textOf(view.result as never)).toContain(READ_FIRST);
      expect(question).toHaveBeenCalledWith('a1');
      expect(textOf(view.result as never)).toContain('const line399 = 399;');
      expect(buttons(view.result).map(b => [b.text, !!b.props.disabled])).toEqual([['allow', false], ['deny', false], ['ask in terminal', false]]);
      expect(answer).toHaveBeenCalledTimes(1);
    });

    it('withheld: said, allow gone, deny and ask in terminal kept; not-a-decision: said in the error tone, the answers kept (17)', async () => {
      const view = mount(() => PermissionAskNotice({ agent: asking(), layout: 'window' }));
      button(view.result, 'allow').props.onClick!();
      (reply.resolve as (v: unknown) => void)({ success: false, code: 'withheld', error: WITHHELD });
      await settle();
      view.rerender();
      expect(textOf(view.result as never)).toContain(WITHHELD);
      expect(buttons(view.result).map(b => b.text)).toEqual(['deny', 'ask in terminal']);

      reply = deferred<{ success: boolean }>();
      const odd = mount(() => PermissionAskNotice({ agent: asking({ id: 'a2' }), layout: 'window' }));
      button(odd.result, 'deny').props.onClick!();
      button(odd.result, 'deny').props.onClick!();
      (reply.resolve as (v: unknown) => void)({ success: false, code: 'not-a-decision', error: NOT_A_DECISION });
      await settle();
      odd.rerender();
      expect(textOf(odd.result as never)).toContain(NOT_A_DECISION);
      expect(buttons(odd.result).map(b => b.text)).toEqual(['allow', 'deny', 'ask in terminal']);
    });

    it('in the window, ask in terminal is the ghost after deny (15)', () => {
      const view = mount(() => PermissionAskNotice({ agent: asking(), layout: 'window' }));
      const all = buttons(view.result);
      expect(all.map(b => b.text)).toEqual(['allow', 'deny', 'ask in terminal']);
      expect((all[2].props as { variant?: string }).variant).toBe('ghost');
      expect((all[0].props as { variant?: string }).variant).not.toBe('ghost');
    });

    it('each field by its name, a long one with its size above it (16)', async () => {
      const view = mount(() => PermissionAskNotice({ agent: asking({ permissionAsk: CUT }), layout: 'window' }));
      await settle();
      view.rerender();
      const text = textOf(view.result as never);
      expect(text.indexOf('file_path')).toBeGreaterThan(-1);
      expect(text.indexOf('file_path')).toBeLessThan(text.indexOf('content'));
      expect(text).toContain(`${WHOLE_CONTENT.length.toLocaleString('en-US')} characters, 400 lines`);
    });
  });
});
