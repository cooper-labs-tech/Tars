import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { shellPlaceFor } from '../../src/lib/new-shell';

/**
 * Which entry of the new shell's sidebar reads as the current one, for the
 * page shown (src/lib/new-shell.ts). Frames: `Shell · chats · project page`,
 * `Shell · chats · empty`, `Chat · chats · Tars, all projects`. Written before
 * the code. How it can fail:
 * 1. today's room, /chat, lights Chat, whose page is /chats: the two paths
 *    differ by one letter, and "Tars, all projects" is the entry that opens it;
 * 2. the chats page, /chats or a path under it, lights nothing, or lights the
 *    room's entry;
 * 3. a path as the packaged app serves it, with a trailing slash, a query or
 *    a hash (/chat/, /crons?x=1), loses its entry;
 * 4. the Dashboard, at /, lights for every page, every path starting with "/";
 * 5. Schedules, whose page is /crons, lights nothing;
 * 6. a page of More reached by its address (/usage, /settings), or a path no
 *    entry owns, lights a main entry;
 * 7. a path that only starts like an entry's (/chatter, /projectsX) lights it;
 * 8. a project's page, /project (the chat list's PR), lights nothing, where
 *    the frame keeps Projects lit under it. Added before that code.
 */

describe('shellPlaceFor', () => {
  it('gives today\'s room to Tars, all projects, never to Chat (1)', () => {
    expect(shellPlaceFor('/chat')).toBe('tars');
  });

  it('gives the chats page and what is under it to Chat (2)', () => {
    expect(shellPlaceFor('/chats')).toBe('chat');
    expect(shellPlaceFor('/chats/42')).toBe('chat');
  });

  it('reads a path with a trailing slash, a query or a hash as its page (3)', () => {
    expect(shellPlaceFor('/chat/')).toBe('tars');
    expect(shellPlaceFor('/chats/')).toBe('chat');
    expect(shellPlaceFor('/crons?x=1')).toBe('schedules');
    expect(shellPlaceFor('/projects#top')).toBe('projects');
    expect(shellPlaceFor('/?tab=1')).toBe('dashboard');
  });

  it('lights the Dashboard for / alone (4)', () => {
    expect(shellPlaceFor('/')).toBe('dashboard');
    expect(shellPlaceFor('')).toBe('dashboard');
    expect(shellPlaceFor('/kanban')).toBe('kanban');
    expect(shellPlaceFor('/projects')).toBe('projects');
  });

  it('gives /crons to Schedules (5)', () => {
    expect(shellPlaceFor('/crons')).toBe('schedules');
  });

  it('lights no main entry for a page of More or a path no entry owns (6)', () => {
    for (const path of ['/usage', '/settings', '/agents', '/skills', '/whats-new', '/nowhere']) {
      expect(shellPlaceFor(path)).toBeNull();
    }
  });

  it('gives a project\'s page, /project, to Projects as well (8, added with the chat list)', () => {
    expect(shellPlaceFor('/project')).toBe('projects');
    expect(shellPlaceFor('/project?path=%2Fp%2Ftars')).toBe('projects');
    expect(shellPlaceFor('/project/')).toBe('projects');
  });

  it('does not light an entry for a path that only starts like it (7)', () => {
    expect(shellPlaceFor('/chatter')).toBeNull();
    expect(shellPlaceFor('/projectsX')).toBeNull();
    expect(shellPlaceFor('/kanbanboard')).toBeNull();
  });
});
