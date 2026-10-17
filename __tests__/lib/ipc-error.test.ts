import { describe, it, expect } from 'vitest';
import { ipcReason } from '../../src/lib/ipc-error';

/**
 * The reason a call to the main process failed, as a dialog shows it: New
 * agent and New team (the Audit's Low on #417, the DB's find on #417: New
 * agent said nothing, New team said it behind Electron's own words). Written
 * before the code. How it can fail:
 * 1. Electron's words stay in front: "Error invoking remote method
 *    'agent:create': Error: " before git's reason;
 * 2. too much is taken: a reason of its own that starts with "Error:" or
 *    "error:" (git writes "error: ..."), or names a remote method itself, loses
 *    its first words;
 * 3. what was thrown is not an Error: a string, nothing, an object, which reads
 *    "[object Object]" or "undefined";
 * 4. an empty reason, or one of spaces, leaves an empty line or "Not created: ."
 *    rather than the fallback;
 * 5. a reason that breaks the line or turns it around (a line break from git, a
 *    U+202E in a branch or folder name) breaks the dialog's line.
 */

const WRAPPED = "Error invoking remote method 'agent:create': Error: The worktree could not be made: 'main' is already checked out at '/Users/me/projects/tars'";

describe("Electron's words (1, 2)", () => {
  it('takes them off, the Error: after them included', () => {
    expect(ipcReason(new Error(WRAPPED), 'it failed')).toBe("The worktree could not be made: 'main' is already checked out at '/Users/me/projects/tars'");
  });

  it('takes them off whatever the channel, and without an Error: after them', () => {
    expect(ipcReason(new Error("Error invoking remote method 'agent:update': Secondary project path does not exist"), 'x')).toBe('Secondary project path does not exist');
    expect(ipcReason(new Error("Error invoking remote method 'hermes:kanban:board': Error: connect ECONNREFUSED 127.0.0.1:9119"), 'x')).toBe('connect ECONNREFUSED 127.0.0.1:9119');
  });

  it('leaves a reason of its own whole', () => {
    expect(ipcReason(new Error("error: pathspec 'x' did not match"), 'x')).toBe("error: pathspec 'x' did not match");
    expect(ipcReason(new Error('Error: the bridge broke'), 'x')).toBe('Error: the bridge broke');
    expect(ipcReason(new Error("Error invoking remote method 'a': Error: Error invoking remote method 'b' named in the reason"), 'x'))
      .toBe("Error invoking remote method 'b' named in the reason");
  });
});

describe('what was thrown (3)', () => {
  it('reads a string as its reason', () => {
    expect(ipcReason(WRAPPED, 'x')).toBe("The worktree could not be made: 'main' is already checked out at '/Users/me/projects/tars'");
  });

  it('gives the fallback for anything else', () => {
    for (const thrown of [undefined, null, 42, {}, { message: 7 }]) expect(ipcReason(thrown, 'it could not be created')).toBe('it could not be created');
  });

  it('reads an object with a message as an Error', () => {
    expect(ipcReason({ message: WRAPPED }, 'x')).toBe("The worktree could not be made: 'main' is already checked out at '/Users/me/projects/tars'");
  });
});

describe('an empty reason (4)', () => {
  it('gives the fallback', () => {
    for (const message of ['', '   ', "Error invoking remote method 'agent:create': Error: ", "Error invoking remote method 'agent:create':  "]) {
      expect(ipcReason(new Error(message), 'it could not be created')).toBe('it could not be created');
    }
  });
});

describe('one line, the right way round (5)', () => {
  it('flattens what breaks or turns the line', () => {
    expect(ipcReason(new Error(`${WRAPPED}\nhint: use --force`), 'x')).toBe("The worktree could not be made: 'main' is already checked out at '/Users/me/projects/tars' hint: use --force");
    expect(ipcReason(new Error("Error invoking remote method 'agent:create': Error: at '/p/a\u202Eb'"), 'x')).toBe("at '/p/a b'");
  });
});
