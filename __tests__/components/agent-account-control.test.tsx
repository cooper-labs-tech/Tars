import '../setup/home-guard';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, settle, ofType, textOf, elements, type Mount } from './hook-runtime';
import type { AgentStatus, ClaudeAccountState, ClaudeAccountsView } from '../../src/types/electron';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * The Claude account an agent runs on, and the menu that pins it to one: on
 * its card in Agents, its pane header on the Dashboard and its window. Frames:
 * `Agent · Claude account` and its light copy, in design/tars-redesign.pen.
 * On #263's contract: AgentStatus.claudeAccountId and claudeAccountPin, and
 * claudeAccounts.setAgentAccount. Written before the code, as the ways it can
 * fail:
 * 1. the control shows with the option off, with a single account, or on an
 *    agent that does not run Claude on a subscription;
 * 2. it names an account other than the one the agent runs on, or hides that
 *    it is pinned, or its title says something else than the frames;
 * 3. the menu picks the wrong entry as current, or a pick sends another agent,
 *    another account, or an account id for Automatic instead of null;
 * 4. one of the three places the frames draw it does not carry it, or carries
 *    it for another agent;
 * 5. the menu's panel loses what the frames draw around the rows: its
 *    caption, the rule under Automatic, the hint in its tone, the note at its
 *    foot, and a trigger that names the account rather than the pick.
 */

type El = { type: unknown; props: Record<string, unknown> };
const g = globalThis as unknown as { window?: unknown };
const NOW = new Date(2026, 8, 28, 14, 50, 0);
const at = (h: number, m: number) => Math.floor(new Date(2026, 8, 28, h, m).getTime() / 1000);

function acct(over: Partial<ClaudeAccountState> & { id: string; label: string }): ClaudeAccountState {
  return {
    configDir: over.id === 'default' ? null : `/Users/someone/.claude-accounts/${over.id}`,
    enabled: true, signedIn: true, email: null, subscriptionType: 'max',
    fiveHour: { usedPercentage: 12, resetsAt: at(19, 5) }, sevenDay: { usedPercentage: 20, resetsAt: at(23, 0) },
    updatedAt: null, blockedUntil: null, agentIds: [], error: null,
    ...over,
  };
}
function mkView(enabled: boolean, accounts: ClaudeAccountState[]): ClaudeAccountsView {
  return { settings: { enabled, accounts: accounts.map(a => ({ id: a.id, label: a.label, configDir: a.configDir, enabled: a.enabled })), fiveHourThreshold: 90, weeklyThreshold: 95 }, accounts };
}
const MAIN = acct({ id: 'default', label: 'Main', fiveHour: { usedPercentage: 93, resetsAt: at(16, 40) } });
const SECOND = acct({ id: 'acct-000002', label: 'Second' });
const THIRD = acct({ id: 'acct-000003', label: 'Third', signedIn: false });

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return { id: 'agent-1', name: 'Frontend Engineer', status: 'running', projectPath: '/tmp/p', provider: 'claude', output: [], lastActivity: '', skills: [], ...over } as unknown as AgentStatus;
}

function bridge(view: ClaudeAccountsView) {
  const calls: Array<[string, unknown]> = [];
  const api = {
    list: () => Promise.resolve({ success: true, ...view }),
    onChanged: () => () => {},
    setAgentAccount: (p: unknown) => { calls.push(['setAgentAccount', p]); return Promise.resolve({ success: true }); },
  };
  return { api, calls };
}

let mounted: Mount<unknown> | null = null;
let mods: {
  Control: typeof import('../../src/components/ClaudeAccounts/AgentAccountControl');
  ui: typeof import('../../src/components/ui');
};
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  mods = { Control: await import('../../src/components/ClaudeAccounts/AgentAccountControl'), ui: await import('../../src/components/ui') };
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  delete g.window;
  vi.useRealTimers();
});

async function control(view: ClaudeAccountsView, a: AgentStatus) {
  const b = bridge(view);
  g.window = { electronAPI: { claudeAccounts: b.api } };
  mounted = mount(() => mods.Control.AgentAccountControl({ agent: a }));
  await settle();
  const dropdown = () => (ofType(mounted!.result, mods.ui.Dropdown) as unknown as El[])[0];
  return { ...b, dropdown };
}

describe('where it shows (1)', () => {
  it('shows nothing with the option off, a single account, or an agent on another provider', async () => {
    for (const [view, a] of [
      [mkView(false, [MAIN, SECOND]), agent()],
      [mkView(true, [MAIN]), agent()],
      [mkView(true, [MAIN, SECOND]), agent({ provider: 'codex' })],
      [mkView(true, [MAIN, SECOND]), agent({ provider: 'openrouter' as AgentStatus['provider'] })],
    ] as const) {
      const c = await control(view, a);
      expect(c.dropdown()).toBeUndefined();
      expect(mounted!.result).toBeNull();
      mounted!.unmount();
      mounted = null;
    }
  });
});

describe('what it says (2)', () => {
  it('names the account the agent runs on, chosen by Tars', async () => {
    const c = await control(mkView(true, [MAIN, SECOND, THIRD]), agent());
    const d = c.dropdown();
    // The frame: the control in mono, the menu's rows in the ui face, the panel 280 wide.
    expect(d.props).toMatchObject({ value: 'auto', triggerLabel: 'Main', title: 'Runs on Main, chosen by Tars.', size: 'sm', quiet: true, align: 'right', mono: 'trigger', panelMinWidth: 280 });
    expect(d.props.ariaLabel).toBe('Claude account of Frontend Engineer');
  });

  it('names the account a pinned agent is held to, and says pinned', async () => {
    const c = await control(mkView(true, [MAIN, SECOND]), agent({ claudeAccountId: 'acct-000002', claudeAccountPin: 'acct-000002' }));
    expect(c.dropdown().props).toMatchObject({ value: 'acct-000002', triggerLabel: 'Second · pinned', title: 'Runs on Second, pinned by you. It stays there past its thresholds, and waits at its limit.' });
  });
});

describe('the menu (3, 5)', () => {
  it('lists Automatic then the accounts, with their use in its tone, and none that cannot take the agent', async () => {
    const c = await control(mkView(true, [MAIN, SECOND, THIRD]), agent());
    const options = c.dropdown().props.options as Array<Record<string, unknown>>;
    expect(options.map(o => [o.value, o.label, o.hint])).toEqual([
      ['auto', 'Automatic', 'now on Main'],
      ['default', 'Main', '5 h 93% · week 20%'],
      ['acct-000002', 'Second', '5 h 12% · week 20%'],
      ['acct-000003', 'Third', 'not signed in'],
    ]);
    expect(options[1]).toMatchObject({ hintClassName: 'text-status-waiting', dividerBefore: true });
    expect(options[3].disabled).toBe(true);
    expect(c.dropdown().props.caption).toBe('Run this agent on');
    expect(c.dropdown().props.footer).toBe('Automatic lets Tars choose the account and move the agent. Pinned, it stays on that account past its thresholds, and waits at its limit.');
  });

  it('pins this agent to the account picked, and sends null for Automatic', async () => {
    const c = await control(mkView(true, [MAIN, SECOND]), agent({ claudeAccountPin: 'acct-000002' }));
    const pick = c.dropdown().props.onChange as (v: string) => void;
    pick('default');
    pick('auto');
    await settle();
    expect(c.calls).toEqual([
      ['setAgentAccount', { agentId: 'agent-1', accountId: 'default' }],
      ['setAgentAccount', { agentId: 'agent-1', accountId: null }],
    ]);
  });
});

describe('the three places (4)', () => {
  it('sits on the agent card, the pane header and the agent window, each for its own agent', async () => {
    const a = agent({ id: 'agent-7' });
    const { AgentManagementCard } = await import('../../src/components/AgentList/AgentManagementCard');
    const TerminalPanelHeader = (await import('../../src/components/TerminalsView/components/TerminalPanelHeader')).default;
    const { AgentDialogHeader } = await import('../../src/components/AgentWorld/AgentDialogHeader');
    const noop = () => {};
    const found = (tree: unknown) => (ofType(tree, mods.Control.AgentAccountControl) as unknown as El[]).map(e => (e.props.agent as AgentStatus).id);

    mounted = mount(() => AgentManagementCard({ agent: a, onClick: noop, onEdit: noop, onStart: noop, onStop: noop, onDelete: noop }));
    expect(found(mounted.result)).toEqual(['agent-7']);
    mounted.unmount();

    g.window = { electronAPI: {} };
    mounted = mount(() => TerminalPanelHeader({ agent: a, view: 'live', onViewChange: noop, isFullscreen: false, isBroadcasting: false, tabType: 'project', onStart: noop, onStop: noop, onFullscreen: noop, onExitFullscreen: noop, onClear: noop, onRemove: noop, onContextMenu: noop }));
    expect(found(mounted.result)).toEqual(['agent-7']);
    mounted.unmount();

    const inner = (AgentDialogHeader as unknown as { type: (p: unknown) => unknown }).type;
    mounted = mount(() => inner({ agent: a, isSuperAgentMode: false, onClose: noop }));
    expect(found(mounted.result)).toEqual(['agent-7']);
  });
});

describe('the panel (5)', () => {
  it('draws the caption, the rule, the hint in its tone and the foot note, under a trigger that names the account', async () => {
    const picked: string[] = [];
    // An open panel listens for a press outside it on the window.
    g.window = { addEventListener: () => {}, removeEventListener: () => {} };
    mounted = mount(() => mods.ui.Dropdown({
      value: 'auto', size: 'sm', quiet: true, mono: 'trigger', panelMinWidth: 280, triggerLabel: 'Main', caption: 'Run this agent on',
      footer: 'A note at the foot.',
      options: [
        { value: 'auto', label: 'Automatic', hint: 'now on Main' },
        { value: 'default', label: 'Main', hint: '5 h 93% · week 20%', hintClassName: 'text-status-waiting', dividerBefore: true },
      ],
      onChange: (v: string) => picked.push(v),
    }));
    const trigger = () => elements(mounted!.result).find(e => e.type === 'button' && e.props['aria-haspopup'] === 'listbox')!;
    expect(textOf(trigger() as never)).toBe('Main');
    (trigger().props.onClick as (e: { currentTarget: { focus: () => void } }) => void)({ currentTarget: { focus: () => {} } });
    const text = textOf(mounted.result as never);
    expect(text).toContain('Run this agent on');
    expect(text).toContain('A note at the foot.');
    const hint = elements(mounted.result).find(e => e.props.children === '5 h 93% · week 20%')!;
    expect(String(hint.props.className)).toContain('text-status-waiting');
    const all = elements(mounted.result);
    const mainRow = all.findIndex(e => e.props.role === 'option' && e.props['data-value'] === 'default');
    const rule = all.findIndex(e => e.props.role === 'separator');
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(mainRow);
    // Mono on the trigger alone, and the panel at least as wide as drawn.
    expect(String(trigger().props.className)).toContain('font-mono');
    const label = all.find(e => e.props.children === 'Automatic')!;
    expect(String(label.props.className)).not.toContain('font-mono');
    const panel = all.find(e => (e.props.style as { minWidth?: number } | undefined)?.minWidth !== undefined)!;
    expect((panel.props.style as { minWidth: number }).minWidth).toBe(280);
  });
});
