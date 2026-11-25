import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RetuneLine } from '../../src/components/Retune/RetuneParts';
import { clockOfIso } from '../../src/hooks/useRetunes';
import type { AgentStatus } from '../../src/types/electron';

/**
 * The time on an agent's card head after a retune (frame `Agents · retuned by an agent`, the card). Asked by the
 * Audit's Info on #604 at 22e602fca: no case pinned it, and a revert of ee02f55df stayed green, as every plain retune
 * of QA's step was applied while its agent was idle, in the minute it was asked. Written failures first, and shown
 * red on that revert. How the head can fail:
 * 1. a retune asked at 14:02 that waited for the agent's turn and held at 14:05 reads "retuned by ... at 14:02": the
 *    time it was asked, not the time it held (ee02f55df, the Audit's I-1 on #604);
 * 2. a held retune whose record has no effectiveAt (an older record) reads no time at all, instead of its asking's;
 * 3. one still queued reads the time it holds instead of the time it was asked (it has held nothing yet);
 * 4. an undo that held reads the time it was asked, where the undo's head already said when it held.
 * The times are the window's own clock (clockOfIso), so the cases hold in any time zone.
 */

const BY = { kind: 'agent' as const, id: 'w-one', name: 'Worker One', projectPath: '/tmp/project-a' };
const ASKED = new Date(2026, 10, 24, 14, 2).toISOString();
const HELD = new Date(2026, 10, 24, 14, 5).toISOString();

function agent(lastRetune: AgentStatus['lastRetune']): AgentStatus {
  return {
    id: 'b-coder', name: 'B Coder', status: 'idle', projectPath: '/tmp/project-b', skills: [], output: [],
    lastActivity: new Date(0).toISOString(), provider: 'claude', permissionMode: 'normal', effort: 'medium', lastRetune,
  } as AgentStatus;
}

/** The card head's own words: the first line of the retune block, before the line of what changed. */
function head(a: AgentStatus): string {
  const html = renderToStaticMarkup(<RetuneLine agent={a} />);
  const text = html.replace(/<[^>]+>/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);
  return text[0] ?? '';
}

describe("a retune's time on the card head", () => {
  it('1. a retune that waited for the turn and held later reads the time it held', () => {
    const a = agent({ changeId: 'chg-1', by: BY, fields: ['effort'], state: 'applied', askedAt: ASKED, effectiveAt: HELD });
    expect(head(a)).toBe(`retuned by Worker One (project-a) at ${clockOfIso(HELD)}`);
    expect(clockOfIso(HELD)).not.toBe(clockOfIso(ASKED));
  });

  it('2. a held retune with no effectiveAt on its record reads the time it was asked', () => {
    const a = agent({ changeId: 'chg-2', by: BY, fields: ['effort'], state: 'applied', askedAt: ASKED });
    expect(head(a)).toBe(`retuned by Worker One (project-a) at ${clockOfIso(ASKED)}`);
  });

  it('3. a retune still queued reads the time it was asked', () => {
    const a = agent({ changeId: 'chg-3', by: BY, fields: ['effort'], state: 'queued', askedAt: ASKED });
    expect(head(a)).toBe(`retune asked by Worker One (project-a) at ${clockOfIso(ASKED)}`);
  });

  it('4. an undo that held reads the time it held', () => {
    const a = agent({ changeId: 'chg-4', by: BY, fields: ['effort'], state: 'applied', askedAt: ASKED, effectiveAt: HELD, revertOf: 'chg-1' });
    expect(head(a)).toBe(`undone by Worker One (project-a) at ${clockOfIso(HELD)}`);
  });
});
