import { describe, expect, it } from 'vitest';
import { outlivedCount, outlivedNote, outlivedNotice, processName } from '@/components/Resources/outlived';

/**
 * What outlived an agent's session, on Resources · agents and projects (frame `· agents and projects · states`, its
 * pane `what outlived a session · alert`): the agent's row says how many, a notice under the fleet says what and since
 * when, and "show them" lists each with its pid and its masked command, or its container.
 *
 * How it can fail, written before the code:
 * 1. nothing outlived (null, and always on Windows) and a note or a notice still shows;
 * 2. the count leaves out the containers, or the processes;
 * 3. a process is named by anything but its masked command's own words: "next dev" for next's binary run by node,
 *    "node" for a script node runs, never a word past the program and its subcommand (a flag, a secret);
 * 4. a container is not named as the data names it, `<name> (<id>)`, or its id is put in the sentence;
 * 5. the time the session ended is not the window's clock, or a missing time reads as a time;
 * 6. one thing reads as many ("1 of what it started run on", "ends them").
 */

const at = new Date(2026, 9, 28, 12, 10).getTime();
const three = {
  since: at,
  processes: [
    { pid: 48211, command: 'node /Users/x/harbor/node_modules/.bin/next dev --port 3100' },
    { pid: 48230, command: 'node scripts/seed.mjs --password [redacted]' },
  ],
  containers: ['postgres (3f2a9c1b07e4)'],
};

describe('what outlived a session', () => {
  it('says nothing when nothing outlived (1)', () => {
    expect(outlivedCount(null)).toBe(0);
    expect(outlivedNote(null)).toBeNull();
    expect(outlivedNotice('Data Engineer', null)).toBeNull();
    expect(outlivedNotice('Data Engineer', { since: at, processes: [], containers: [] })).toBeNull();
  });

  it('counts the processes and the containers (2)', () => {
    expect(outlivedCount(three)).toBe(3);
    expect(outlivedNote(three)).toBe('3 outlived its session');
  });

  it('names a process by its program and subcommand only (3)', () => {
    expect(processName('node /Users/x/harbor/node_modules/.bin/next dev --port 3100')).toBe('next dev');
    expect(processName('node scripts/seed.mjs --password [redacted]')).toBe('node');
    expect(processName('/usr/local/bin/python3 -m http.server 8000')).toBe('python3');
    expect(processName('npm run e2e -- --token [redacted]')).toBe('npm run');
    expect(processName('/opt/homebrew/bin/redis-server *:6379')).toBe('redis-server');
  });

  it('says the notice as drawn, the containers by name (4, 5)', () => {
    expect(outlivedNotice('Data Engineer', three)).toBe(
      "Data Engineer's session ended at 12:10 and 3 of what it started run on: next dev, node, the container postgres. Tars ends them on a stop of the agent; it does not end them by itself.",
    );
    expect(outlivedNotice('Data Engineer', { ...three, since: null })).toMatch(/^Data Engineer's session ended and 3 of what/);
    expect(outlivedNotice('Data Engineer', three)).not.toContain('3f2a9c1b07e4');
  });

  it('says one as one (6)', () => {
    const one = { since: at, processes: [three.processes[0]], containers: [] };
    expect(outlivedNote(one)).toBe('1 outlived its session');
    expect(outlivedNotice('Data Engineer', one)).toBe(
      "Data Engineer's session ended at 12:10 and 1 of what it started runs on: next dev. Tars ends it on a stop of the agent; it does not end it by itself.",
    );
  });
});
