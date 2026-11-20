import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import MessageWaitingNotice, { messageWaitingLine } from '../../src/components/MessageWaitingNotice';
import type { AgentMessageWaiting } from '../../src/types/electron';

/**
 * The line the notice puts on screen, and what a sender's name cannot do to it.
 *
 * `from` is free text. It reaches the notice from `/api/agents/:id/message` and
 * `/dispatch`, which name the caller from the agent record, and an agent can be
 * named by another agent through `create_agent`. So the name is the one part of
 * this sentence nobody in Tars wrote, and these are the four things it must not
 * be able to do: put markup on the page, break the line, hide or rearrange what
 * is drawn, or push the rest of the sentence out of the row.
 *
 * Measured by the QA on 2026-09-21 against the component itself: with U+202E in
 * an agent's name the notice read `A message from QA.C+lrtC htiw dleif eht`,
 * Tars's own instruction reversed, and a name of 38 characters followed by an
 * emoji left half a character before the ellipsis.
 *
 * The sentence is asserted through the pure function; the escaping is asserted
 * through the markup as well, because that is where React's own escaping is the
 * half of the answer that `clean` does not do.
 */

const U = (n: number) => String.fromCodePoint(n);
/** C0 and C1, which a CLI puts in a name without meaning to. */
const CR = U(13), LF = U(10), BEL = U(7), ESC = U(27), DEL = U(127), NEL = U(133);
/** What hides or rearranges what is drawn: an override, a zero width, a separator. */
const RLO = U(0x202e), ZWSP = U(0x200b), LSEP = U(0x2028);
const GRIN = U(0x1f600), ELLIPSIS = U(0x2026);

const line = (waiting: number, from: string[]) =>
  messageWaitingLine({ agentId: 'a1', waiting, from } as AgentMessageWaiting);
const markup = (waiting: number, from: string[]) =>
  renderToStaticMarkup(<MessageWaitingNotice waiting={{ agentId: 'a1', waiting, from } as AgentMessageWaiting} />);

/** Anything a reader cannot see, or that moves what is beside it. */
const hidesOrRearranges = (s: string) => [...s].some(c => {
  const n = c.codePointAt(0)!;
  return n < 32 || (n >= 127 && n <= 159)   // Cc
    || n === 0x200b || n === 0x200e || n === 0x200f || (n >= 0x202a && n <= 0x202e)  // Cf
    || n === 0x2028 || n === 0x2029;        // Zl, Zp
});

/** A UTF-16 unit left without the other half of its pair. */
const halfACharacter = (s: string) =>
  Array.from({ length: s.length }, (_, i) => s.charCodeAt(i))
    .some((u, i, all) => u >= 0xd800 && u <= 0xdbff && !(all[i + 1] >= 0xdc00 && all[i + 1] <= 0xdfff));

describe('the sentence the notice draws', () => {
  it('agrees with the count, not with the names', () => {
    expect(line(1, ['QA']).who).toBe('A message from QA');
    expect(line(1, ['QA']).rest.startsWith('is waiting')).toBe(true);
    expect(line(3, ['QA']).who).toBe('3 messages from QA');
    expect(line(3, ['QA']).rest.startsWith('are waiting')).toBe(true);
  });

  it('names two and three senders, and counts the rest', () => {
    expect(line(2, ['A', 'B']).who).toBe('2 messages from A and B');
    expect(line(3, ['A', 'B', 'C']).who).toBe('3 messages from A, B and C');
    expect(line(4, ['A', 'B', 'C', 'D']).who).toBe('4 messages from A, B and 2 others');
  });

  it('says nothing about senders when the caller gave no name', () => {
    // /dispatch and /message name their caller; the Telegram command paths do
    // not, and the notice is still drawn for the agent whose terminal it is.
    expect(line(1, []).who).toBe('A message');
    expect(line(2, []).who).toBe('2 messages');
  });

  it('says the two things that end the wait, whatever the name is', () => {
    for (const from of [[], ['QA'], ['QA' + RLO, 'x'.repeat(200)]]) {
      expect(line(1, from).rest).toContain('Send what you are typing');
      expect(line(1, from).rest).toContain('Ctrl+C');
    }
  });
});

describe('a name chosen to break the line', () => {
  it('cannot put markup on the page', () => {
    const html = markup(1, ['<img src=x onerror=alert(1)>']);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('cannot carry a control character into the row', () => {
    const got = line(1, ['QA' + CR + LF + 'Agent' + BEL + ESC + '[31m' + DEL + NEL]).who;
    expect(got).toContain('QA');
    expect(hidesOrRearranges(got)).toBe(false);
  });

  it('cannot hide or reverse what is drawn beside it', () => {
    // The one measured on screen: an override in a name reversed the whole of
    // Tars's instruction after it.
    const reversed = line(1, ['QA' + RLO + 'gnitiaw ton si']).who;
    expect(hidesOrRearranges(reversed)).toBe(false);
    expect(hidesOrRearranges(line(1, ['QA' + ZWSP + LSEP + 'x']).who)).toBe(false);
    expect(hidesOrRearranges(markup(1, ['QA' + RLO + 'x']))).toBe(false);
  });

  it('is cut to the row, and never in the middle of a character', () => {
    const long = line(1, ['x'.repeat(200)]).who;
    expect(long.length).toBeLessThan(60);
    expect(long.endsWith(ELLIPSIS)).toBe(true);
    // The emoji sits across the cut: 38 characters, then its two UTF-16 units.
    const astral = line(1, ['x'.repeat(38) + GRIN + 'tail']).who;
    expect(halfACharacter(astral), 'the cut left half a character before the ellipsis').toBe(false);
  });
});
