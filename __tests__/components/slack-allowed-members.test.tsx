import { describe, it, expect, vi, afterEach } from 'vitest';
import { mount, elements, ofType, textOf, type Mount } from './hook-runtime';
import { SlackSection } from '../../src/components/Settings/SlackSection';
import { Button, Input } from '../../src/components/ui';
import type { AppSettings } from '../../src/components/Settings/types';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  ...(await import('./hook-runtime')).hooks,
}));

/**
 * Who the Slack bot answers, as Settings adds and removes them (#150). Written
 * by the QA after the Audit's Low on #150: its renderer logic had no test of
 * its own (#131's rule).
 *
 * `isAllowedSlackUser` (electron/services/slack-bot.ts) matches a member ID
 * exactly, so what this list keeps is what the bot answers. How it can fail:
 * 1. a pasted lowercase ID is kept as typed, and matches nobody;
 * 2. an Enterprise Grid ID (W...) is refused;
 * 3. something that is not a member ID is saved, and the list looks filled
 *    while the bot answers nobody new;
 * 4. an ID already on the list is added twice;
 * 5. the spaces of a paste are kept;
 * 6. removing one ID removes another, or all.
 */

type El = { type: unknown; props: Record<string, unknown> };
let page: Mount<unknown> | null = null;
afterEach(() => { page?.unmount(); page = null; });

function slack(allowed: string[]) {
  const saved: Array<Partial<AppSettings>> = [];
  const appSettings = {
    slackEnabled: true, slackBotToken: '', slackAppToken: '', slackAllowedUserIds: allowed,
  } as unknown as AppSettings;
  page = mount(() => SlackSection({ appSettings, onSaveAppSettings: u => { saved.push(u); }, onUpdateLocalSettings: () => {} }));
  const field = () => ofType(page!.result, Input).find(el => el.props['aria-label'] === 'Slack member ID') as unknown as El;
  const button = (label: string) => (ofType(page!.result, Button) as unknown as El[]).filter(el => textOf(el.props.children as never) === label);
  const type = (text: string) => (field().props.onChange as (e: unknown) => void)({ target: { value: text } });
  const add = () => (button('add')[0].props.onClick as () => void)();
  const enter = () => (field().props.onKeyDown as (e: unknown) => void)({ key: 'Enter' });
  /** What the "Allowed members" row says under its label: the rule, or why the last ID was refused. */
  const said = () => {
    const row = (elements(page!.result) as unknown as El[]).find(el => el.props.label === 'Allowed members')!;
    return textOf(row.props.description as never);
  };
  return { saved, field, button, type, add, enter, said };
}

describe('the Slack members the bot answers', () => {
  it('keeps a pasted lowercase ID in capitals, which is how the bot compares it', () => {
    const s = slack([]);
    s.type('u0abc12de');
    s.add();
    expect(s.saved).toEqual([{ slackAllowedUserIds: ['U0ABC12DE'] }]);
    expect(s.field().props.value, 'the field was not cleared').toBe('');
  });

  it('takes an Enterprise Grid ID, spaces of the paste trimmed, and adds it after those already there', () => {
    const s = slack(['U0FIRST']);
    s.type('  W0GRID42 ');
    s.enter();
    expect(s.saved).toEqual([{ slackAllowedUserIds: ['U0FIRST', 'W0GRID42'] }]);
  });

  it.each([
    ['a name', 'demo'],
    ['a channel ID', 'C0ABC123'],
    ['a bot ID', 'B0ABC123'],
    ['a letter and one character', 'U1'],
    ['a dash inside', 'U0AB-C1'],
    ['an email address', 'demo@example.com'],
  ])('refuses %s, saves nothing, and says why', (_what, text) => {
    const s = slack(['U0FIRST']);
    s.type(text);
    s.add();
    expect(s.saved).toEqual([]);
    expect(s.said()).toBe(`${text} is not a member ID: they start with U or W, then capitals and digits.`);
  });

  it('refuses an ID already on the list, however it is typed', () => {
    const s = slack(['U0ABC12DE']);
    s.type('u0abc12de');
    s.add();
    expect(s.saved).toEqual([]);
    expect(s.said()).toBe('U0ABC12DE is on the list already.');
  });

  it('forgets the refusal as soon as the ID is typed again', () => {
    const s = slack([]);
    s.type('demo');
    s.add();
    expect(s.said()).toContain('is not a member ID');
    s.type('U0');
    expect(s.said()).toBe('Slack member IDs, U… or W…. An empty list answers nobody; a refused sender is told their ID.');
  });

  it('removes the one ID whose row is clicked', () => {
    const s = slack(['U0FIRST', 'U0SECOND', 'W0THIRD']);
    const removes = s.button('remove');
    expect(removes).toHaveLength(3);
    (removes[1].props.onClick as () => void)();
    expect(s.saved).toEqual([{ slackAllowedUserIds: ['U0FIRST', 'W0THIRD'] }]);
  });
});
