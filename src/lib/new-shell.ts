/**
 * The shell (plan 2.0.0), the only one since 2.1.0. Frames: `Shell · chats · empty`, `· project page`,
 * `· More open`, `· Settings card` (tars-redesign.pen) and `Chat · chats ·
 * Tars, all projects` (chat-redesign-a.pen).
 */

/** The sidebar's entries that open a page in the main column. */
export type ShellPlace = 'tars' | 'chat' | 'projects' | 'dashboard' | 'kanban' | 'schedules';

/** Each entry and the path it owns, along with what is under it. */
const OWNERS: Array<[ShellPlace, string]> = [
  ['tars', '/chat'],
  ['chat', '/chats'],
  ['projects', '/projects'],
  // A project's page, under Projects (`Shell · chats · project page, from the records`).
  ['projects', '/project'],
  ['kanban', '/kanban'],
  ['schedules', '/crons'],
];

/**
 * Which entry reads as the page on screen.
 *
 * Today's room is /chat and the chats page /chats, one letter apart, so an
 * entry owns its path and what is under it, never a path that only starts like
 * it. The Dashboard is /, a prefix of every path: it owns / alone. A query, a
 * hash, a trailing slash and the packaged app's index.html are not part of the
 * page. The pages of More, and anything else, light no main entry.
 */
export function shellPlaceFor(raw: string): ShellPlace | null {
  const path = raw
    .replace(/[?#].*$/, '')
    .replace(/\/index\.html$/i, '/')
    .replace(/\/+$/, '') || '/';
  if (path === '/') return 'dashboard';
  for (const [place, owner] of OWNERS) {
    if (path === owner || path.startsWith(`${owner}/`)) return place;
  }
  return null;
}
