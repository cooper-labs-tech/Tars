import type { ChatView } from '@/types/electron';

/**
 * Where each chat of the new shell's list goes, from the chats' records
 * (chat:list, #361). Frames: `Shell · chats · list, a chat open` and `Chats ·
 * the list from the records · notes`.
 *
 * Settled and Snoozed take a chat first, a snooze only until its time; then
 * Pinned; then Working, a chat whose runner is in a turn; the rest is Active.
 * In each, the most recently active first, and the same moment in project
 * then number order, so a listing never reshuffles. A section with no chat is
 * not given.
 */

export type ChatSectionName = 'Pinned' | 'Active' | 'Working' | 'Snoozed' | 'Settled';

export interface ChatSection {
  name: ChatSectionName;
  chats: ChatView[];
}

const ORDER: ChatSectionName[] = ['Pinned', 'Active', 'Working', 'Snoozed', 'Settled'];

function isSnoozed(chat: ChatView, now: number): boolean {
  if (!chat.snoozedUntil) return false;
  const until = Date.parse(chat.snoozedUntil);
  return Number.isFinite(until) && until > now;
}

export function sectionOf(chat: ChatView, now: number): ChatSectionName {
  if (chat.settledAt) return 'Settled';
  if (isSnoozed(chat, now)) return 'Snoozed';
  if (chat.pinned) return 'Pinned';
  if (chat.runner?.status === 'running') return 'Working';
  return 'Active';
}

const activity = (chat: ChatView) => {
  const at = Date.parse(chat.lastActivityAt);
  return Number.isFinite(at) ? at : 0;
};

const newestFirst = (a: ChatView, b: ChatView) =>
  activity(b) - activity(a) || a.projectPath.localeCompare(b.projectPath) || a.number - b.number;

export function chatSections(chats: ChatView[], { now, project }: { now: number; project?: string | null }): ChatSection[] {
  const kept = project ? chats.filter(chat => chat.projectPath === project) : chats;
  return ORDER
    .map(name => ({ name, chats: kept.filter(chat => sectionOf(chat, now) === name).sort(newestFirst) }))
    .filter(section => section.chats.length > 0);
}

/**
 * The chat the chats page opens: the one `?chat=` names, else the first of the
 * list (Main first, as it is pinned). The page opens it and the sidebar marks
 * its row current, from this one answer.
 */
export function chatShown(chats: ChatView[], asked: string | null, now: number): ChatView | undefined {
  return (asked ? chats.find(chat => chat.id === asked) : undefined)
    || chatSections(chats, { now }).flatMap(section => section.chats)[0];
}

export type ChatStateWord = 'working' | 'waiting' | 'error';

/** What a chat's row says of its runner: working, waiting on you, or in error; nothing otherwise. */
export function chatStateWord(chat: ChatView): ChatStateWord | null {
  switch (chat.runner?.status) {
    case 'running': return 'working';
    case 'waiting': return 'waiting';
    case 'error': return 'error';
    default: return null;
  }
}
