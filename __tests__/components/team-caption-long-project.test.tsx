import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TeamSection } from '../../src/components/Chat/ChatSidebar';
import type { RoomAgent } from '../../src/hooks/useRoomAgents';

/**
 * The team's caption with a long project name (the Audit's Low at #210's gate:
 * "TEAM · <PROJECT>" ran under its + button). The frame is `Chat · A · Team
 * rows · states` > `state HEADER` in design/chat-redesign-a.pen: a long project
 * name is cut with an ellipsis, and the count and + stay where a short name has
 * them. The suite has no layout engine, so this pins the flex contract that
 * decides it (the in-app proof measures it). How it fails:
 * 1. the caption cannot shrink below its text (a flex item that does not wrap
 *    keeps its whole width), so a long name runs past its box, under the count
 *    and the + button;
 * 2. it shrinks but is not clipped, and paints over what follows, or is
 *    clipped with no ellipsis, so a cut name reads as a whole one;
 * 3. the count gives way before the caption;
 * 4. the + button shrinks, or the group that holds the caption cannot shrink,
 *    so the head is pushed past the column's edge.
 */

const LONG = 'acme-capital-markets-dashboard-and-reports';
const noop = () => {};

function agent(id: string): RoomAgent {
  return {
    id,
    name: `Agent ${id}`,
    status: 'running',
    projectPath: `/tmp/${LONG}`,
    skills: [],
    output: [],
    lastActivity: new Date(0).toISOString(),
    hasEndOfTurn: true,
    stopped: false,
  } as unknown as RoomAgent;
}

/** The team's head for this project, as markup. */
function head(project = LONG): string {
  const markup = renderToStaticMarkup(
    <TeamSection
      project={project}
      agents={[agent('a1'), agent('a2'), agent('a3')]}
      pending={{}}
      lastSpoke={{}}
      candidates={[]}
      onAction={noop}
      onAdd={noop}
      onNewAgent={noop}
    />,
  );
  // The head is the first 32 px line of the section.
  const end = markup.indexOf('Add an agent to this room');
  expect(end).toBeGreaterThan(0);
  return markup.slice(0, markup.indexOf('</button>', end) + '</button>'.length);
}

/** The classes of the element that holds exactly this text. */
function classesOf(markup: string, text: string): string[] {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new RegExp(`<([a-z]+) class="([^"]*)">${escaped}</\\1>`).exec(markup);
  expect(found, `an element holding ${text}`).not.toBeNull();
  return found![2].split(/\s+/);
}

/** The classes of the element that opens right before this text's element. */
function classesOfParent(markup: string, text: string): string[] {
  // Up to and including the `>` that closes the text's own opening tag.
  const at = markup.indexOf(`>${text}<`) + 1;
  const opens = [...markup.slice(0, at).matchAll(/<([a-z]+) class="([^"]*)">/g)];
  return opens[opens.length - 2][2].split(/\s+/);
}

describe('the team caption with a long project name', () => {
  it('can shrink, and cuts the name with an ellipsis instead of running on (1, 2)', () => {
    const caption = classesOf(head(), `TEAM · ${LONG.toUpperCase()}`);
    expect(caption).toEqual(expect.arrayContaining(['min-w-0', 'truncate']));
  });

  it('keeps the count whole (3)', () => {
    expect(classesOf(head(), '3')).toContain('shrink-0');
  });

  it('keeps the + at its size, and lets the caption group shrink (4)', () => {
    const markup = head();
    const button = /<button[^>]*aria-label="Add an agent to this room"[^>]*class="([^"]*)"/.exec(markup);
    expect(button).not.toBeNull();
    expect(button![1].split(/\s+/)).toEqual(expect.arrayContaining(['w-[26px]', 'h-[26px]', 'shrink-0']));
    expect(classesOfParent(markup, `TEAM · ${LONG.toUpperCase()}`)).toContain('min-w-0');
  });

  it('draws a short name the same way, so nothing moves between the two', () => {
    const short = head('tars');
    expect(classesOf(short, 'TEAM · TARS')).toEqual(classesOf(head(), `TEAM · ${LONG.toUpperCase()}`));
  });
});
