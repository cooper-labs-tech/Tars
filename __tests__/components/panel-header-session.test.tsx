import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Maximize2, Minimize2 } from 'lucide-react';
import { mount, ofType, textOf, elements, type Mount } from './hook-runtime';
import TerminalPanelHeader from '../../src/components/TerminalsView/components/TerminalPanelHeader';
import LeftFullscreenNotice from '../../src/components/TerminalsView/components/LeftFullscreenNotice';
import { SegmentedControl } from '../../src/components/ui';
import type { AgentStatus } from '../../src/types/electron';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * An agent's panel header on the Dashboard, after JeanBrasse's requests of 01/10 and
 * 13/10. Frames: `Panel header · fullscreen` (and its light copy), and `Left
 * fullscreen · notice`, in design/tars-redesign.pen. Written before the code,
 * as the ways it can fail:
 * 1. the header still offers the history view: a view switch, or any control
 *    or word that says history;
 * 2. the panel's view is still named: live, or session, the one view a panel
 *    has, which named nothing to choose and took room in the header (JeanBrasse,
 *    13/10: "il ne sert plus à rien puisqu'on ne choisit plus une autre vue");
 * 3. fullscreen is not a button of its own in the header, outside the menu,
 *    26 px square;
 * 4. the button does the wrong thing for the state: onFullscreen while the
 *    panel fills the window, or onExitFullscreen at rest; or its name and its
 *    arrows (maximize-2 at rest, minimize-2 in fullscreen) do not follow;
 * 5. the menu still offers fullscreen, or loses clear, or offers to hide the
 *    panel while it fills the window;
 * 6. the left fullscreen notice still offers to read the history, or loses
 *    restart.
 */

type El = { type: unknown; props: Record<string, unknown> };
const g = globalThis as unknown as { window?: unknown };

function agent(over: Partial<AgentStatus> = {}): AgentStatus {
  return {
    id: 'a1', name: 'Planner', status: 'running', projectPath: '/tmp/project', skills: [], output: [],
    lastActivity: '2026-10-01T08:00:00.000Z', currentTask: 'Plan the lot', provider: 'claude', model: 'opus-5', cliRunning: true,
    ...over,
  } as AgentStatus;
}

let onFullscreen: ReturnType<typeof vi.fn>;
let onExitFullscreen: ReturnType<typeof vi.fn>;
let header: Mount<unknown> | undefined;

function render(isFullscreen: boolean) {
  header = mount(() => TerminalPanelHeader({
    agent: agent(),
    isFullscreen,
    isBroadcasting: false,
    tabType: 'project',
    onStart: vi.fn(),
    onStop: vi.fn(),
    onFullscreen,
    onExitFullscreen,
    onClear: vi.fn(),
    onRemove: vi.fn(),
    onContextMenu: vi.fn(),
  } as Parameters<typeof TerminalPanelHeader>[0]));
  return header;
}
const buttons = (h: Mount<unknown>) => ofType(h.result, 'button') as unknown as El[];
const named = (h: Mount<unknown>, name: string) => buttons(h).find(b => b.props['aria-label'] === name);
const texts = (h: Mount<unknown>) => elements(h.result).map(e => textOf(e.props.children as never).trim()).filter(Boolean);
/** The values a choice offers through its props (a SegmentedControl's options are not children). */
const offered = (h: Mount<unknown>) => elements(h.result).flatMap(e => (Array.isArray(e.props.options) ? (e.props.options as Array<{ value: unknown }>).map(o => String(o.value)) : []));
function openMenu(h: Mount<unknown>) {
  (named(h, 'Panel actions')!.props.onClick as () => void)();
  h.rerender();
  return buttons(h).filter(b => !b.props['aria-label']).map(b => textOf(b.props.children as never).trim());
}

beforeEach(() => {
  onFullscreen = vi.fn();
  onExitFullscreen = vi.fn();
  g.window = new EventTarget();
});

afterEach(() => {
  header?.unmount();
  header = undefined;
  delete g.window;
});

describe("an agent's panel header", () => {
  it('offers no history view, and no switch between views (1)', () => {
    const h = render(false);
    expect(texts(h).some(t => /^history$/i.test(t))).toBe(false);
    expect(offered(h)).not.toContain('history');
    expect(elements(h.result).some(e => e.type === SegmentedControl || e.props.role === 'radiogroup' || e.props.role === 'radio')).toBe(false);
  });

  it('names no view, neither session nor live, at rest or in fullscreen (2)', () => {
    for (const isFullscreen of [false, true]) {
      const h = render(isFullscreen);
      expect(texts(h)).not.toContain('session');
      expect(texts(h)).not.toContain('live');
      expect(offered(h)).not.toContain('session');
      expect(offered(h)).not.toContain('live');
      expect(elements(h.result).some(e => /\bsession\b/i.test(String(e.props.title ?? '')))).toBe(false);
      h.unmount();
      header = undefined;
    }
  });

  it('has a 26 px fullscreen button of its own, with the arrows out, that fills the window (3, 4)', () => {
    const h = render(false);
    const b = named(h, 'Fullscreen');
    expect(b, 'a button named Fullscreen in the header').toBeDefined();
    expect(String(b!.props.className)).toMatch(/\bh-\[26px\]/);
    expect(String(b!.props.className)).toMatch(/\bw-\[26px\]/);
    expect(ofType(b as never, Maximize2)).toHaveLength(1);
    expect(ofType(b as never, Minimize2)).toHaveLength(0);
    (b!.props.onClick as () => void)();
    expect(onFullscreen).toHaveBeenCalledTimes(1);
    expect(onExitFullscreen).not.toHaveBeenCalled();
  });

  it('turns its arrows inward in fullscreen, and takes the panel back (4)', () => {
    const h = render(true);
    expect(named(h, 'Fullscreen')).toBeUndefined();
    const b = named(h, 'Exit fullscreen');
    expect(b, 'a button named Exit fullscreen in the header').toBeDefined();
    expect(ofType(b as never, Minimize2)).toHaveLength(1);
    expect(ofType(b as never, Maximize2)).toHaveLength(0);
    (b!.props.onClick as () => void)();
    expect(onExitFullscreen).toHaveBeenCalledTimes(1);
    expect(onFullscreen).not.toHaveBeenCalled();
  });

  it('keeps clear and hide from this board in its menu, and no fullscreen (5)', () => {
    const items = openMenu(render(false));
    expect(items).toContain('clear');
    expect(items).toContain('hide from this board');
    expect(items.some(t => /fullscreen/i.test(t))).toBe(false);
  });

  it('keeps clear alone in its menu while the panel fills the window (5)', () => {
    const items = openMenu(render(true));
    expect(items).toContain('clear');
    expect(items).not.toContain('hide from this board');
    expect(items.some(t => /fullscreen/i.test(t))).toBe(false);
  });
});

describe('the left fullscreen notice (6)', () => {
  it('offers restart, and no longer the history', () => {
    const onRestart = vi.fn();
    // Handed an onHistory as the panel used to, it still offers no history.
    const tree = LeftFullscreenNotice({ onHistory: vi.fn(), onRestart } as Parameters<typeof LeftFullscreenNotice>[0]);
    const labels = elements(tree).filter(e => typeof e.props.onClick === 'function').map(e => textOf(e.props.children as never).trim());
    expect(labels).toEqual(['restart']);
    const restart = elements(tree).find(e => textOf(e.props.children as never).trim() === 'restart' && typeof e.props.onClick === 'function');
    (restart!.props.onClick as () => void)();
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});
