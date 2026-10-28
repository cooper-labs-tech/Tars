import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, settle, elements, ofType, textOf, type Mount } from './hook-runtime';
import OrchestratorModeToggle from '../../src/components/NewChatModal/OrchestratorModeToggle';
import { ReplaceOrchestratorDialog, replaceConsequence, type PendingReplace } from '../../src/components/NewChatModal/ReplaceOrchestratorDialog';
import { isSuperAgentCheck } from '../../src/app/agents/constants';
import { isSuperAgent } from '../../src/components/AgentWorld/AgentDialogTypes';
import { useSuperAgent } from '../../src/hooks/useSuperAgent';
import { Button, DialogShell } from '../../src/components/ui';
import type { AgentStatus } from '../../src/types/electron';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * The renderer half of the orchestrator role (#129), pinned at its QA gate.
 * Every sentence below is copied from the frames it implements, c4Yrd, EPCYJ
 * and l1kA0F in design/tars-redesign.pen, so a change of wording on either
 * side turns this red.
 */

// Since 2.0.5 (5c6aeb30b, frames redrawn in ea5158925): Tars's own Telegram bot is gone, Telegram goes through Hermes.
const RUNS = 'Runs the project: it delegates instead of editing files, and joins the global Chat room. If it is the fleet’s first orchestrator, it also answers Slack. A Telegram message reaches the orchestrator of the project it names, through Hermes.';
const ONE = 'A project has one, so switching this on takes the role from the current one.';
const RESTART = 'If it is running, saving restarts it once it is free.';
const KEEPS = 'Runs the project and joins the global Chat room. If it is the fleet’s first orchestrator, it also answers Slack. A Telegram message reaches the orchestrator of the project it names, through Hermes. This CLI keeps its editing tools: it is asked to delegate, not stopped.';
const NEXT = 'It takes the change at its next start.';

type El = { type: unknown; props: Record<string, unknown> };
const g = globalThis as unknown as { window?: unknown };
let page: Mount<unknown> | null = null;
afterEach(() => {
  page?.unmount();
  page = null;
  delete g.window;
});

describe('the Orchestrator row', () => {
  const asked: string[] = [];
  const row = async (props: { provider?: string; editing?: boolean; isOrchestrator?: boolean; onToggle?: (on: boolean) => void }) => {
    page?.unmount();
    asked.length = 0;
    g.window = {
      electronAPI: {
        provider: { orchestratorSupport: async () => ({ claude: true, codex: false }) },
        // The setup gate #129 removed: the row must ask the main process nothing.
        orchestrator: {
          getStatus: async () => { asked.push('getStatus'); return { configured: true }; },
          setup: async () => { asked.push('setup'); return { success: true }; },
        },
      },
    };
    page = mount(() => OrchestratorModeToggle({ isOrchestrator: false, onToggle: () => {}, ...props }));
    await settle();
    return (elements(page.result) as unknown as El[]).filter(el => el.type === 'p').map(el => textOf(el.props.children as never));
  };

  it("says what the role gives in the frames' words, for the claude binary and for a CLI that keeps its tools", async () => {
    expect(await row({ provider: 'claude' })).toEqual(['Orchestrator', `${RUNS} ${ONE}`]);
    expect(await row({ provider: 'claude', editing: true })).toEqual(['Orchestrator', `${RUNS} ${ONE} ${RESTART}`]);
    expect(await row({ provider: 'codex', editing: true })).toEqual(['Orchestrator', `${KEEPS} ${ONE} ${NEXT}`]);
  });

  it('switches on a click and asks the main process nothing, neither its status nor a setup', async () => {
    const onToggle = vi.fn();
    await row({ provider: 'claude', isOrchestrator: true, onToggle });
    const toggle = (elements(page!.result) as unknown as El[]).find(el => typeof el.props.onChange === 'function')!;
    (toggle.props.onChange as () => void)();
    expect(onToggle).toHaveBeenCalledWith(false);
    expect(asked).toEqual([]);
  });
});

describe('the question before the role changes hands', () => {
  const pending: PendingReplace = { kind: 'edit', holder: 'Tars-Orchestrator', newcomer: 'Tars-Lead', project: 'tars' };

  it("names the holder, the newcomer and the project in the frame's three texts", () => {
    expect(replaceConsequence(pending)).toBe(
      'If you save, Tars-Lead takes the role and Tars-Orchestrator becomes a worker. Each restarts once it is free, or takes the change at its next start.');
    expect(replaceConsequence({ ...pending, kind: 'create' })).toBe(
      'If you create Tars-Lead, it takes the role and Tars-Orchestrator becomes a worker. Tars-Orchestrator restarts once it is free, or takes the change at its next start.');
    expect(replaceConsequence({ ...pending, kind: 'team', newcomer: 'Orchestrator - tars' })).toBe(
      'If you deploy this team, Orchestrator - tars takes the role and Tars-Orchestrator becomes a worker. Tars-Orchestrator restarts once it is free, or takes the change at its next start.');
  });

  it('asks who holds the role; Replace answers once, and Cancel, the close button and Escape save nothing', () => {
    const onCancel = vi.fn();
    const onReplace = vi.fn();
    page = mount(() => ReplaceOrchestratorDialog({ pending, onCancel, onReplace }));
    const shell = ofType(page.result, DialogShell)[0] as unknown as El;
    expect(shell.props.title).toBe('Replace the orchestrator of tars?');
    const lines = (elements(shell.props.children) as unknown as El[]).filter(el => el.type === 'p').map(el => textOf(el.props.children as never));
    expect(lines).toEqual(['Tars-Orchestrator is the orchestrator of tars.', replaceConsequence(pending)]);
    const button = (word: string) => (elements(shell.props.footerRight) as unknown as El[])
      .find(el => el.type === Button && textOf(el.props.children as never) === word)!;

    (button('Cancel').props.onClick as () => void)();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onReplace).not.toHaveBeenCalled();
    // DialogShell closes on Escape and on its own close button through onClose.
    expect(shell.props.onClose).toBe(onCancel);

    (button('Replace').props.onClick as () => void)();
    expect(onReplace).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('the role decides, never the name', () => {
  const a = (name: string, role?: 'orchestrator' | 'worker') => ({ id: name, name, role }) as AgentStatus;

  it('in the Agents page sort, the agent dialog and the super agent hook', () => {
    for (const check of [isSuperAgentCheck, isSuperAgent]) {
      expect(check(a('Frontend Orchestrator', 'worker'))).toBe(false);
      expect(check(a('Super Agent'))).toBe(false);
      expect(check(a('Demo Chief', 'orchestrator'))).toBe(true);
    }
    page = mount(() => useSuperAgent({ agents: [a('Orchestrator Notes', 'worker'), a('Demo Chief', 'orchestrator')] }));
    expect((page.result as { superAgent: AgentStatus | null }).superAgent?.name).toBe('Demo Chief');
  });
});
