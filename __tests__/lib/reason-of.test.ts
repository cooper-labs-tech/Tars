import { describe, it, expect } from 'vitest';
import { reasonOf } from '../../src/lib/traces-format';

/**
 * reasonOf (src/lib/traces-format.ts): the reason the traces window shows for a call that failed, main's own sentence
 * without what Electron, Node or the system wrap around it, ending with no stop of its own, as the window ends it with
 * one (QA's re-check of #599: "404 not_found.. Nothing was forgotten", and the channel's name shown to the user).
 *
 * QA's, on the Audit's Info at d63a98e19: nothing tested its last-period strip or its (?!ERROR:) guard. The code is the
 * Frontend's and came first, so the Frontend could not write this after it (Rule 3). The ways it can fail, written here
 * before these tests, and each shown on a one-line mutant of reasonOf (QA's hold599e):
 * 1. Electron's wrapping is kept: "Error invoking remote method '<channel>': Error: <sentence>" shows the channel.
 * 2. A chain of error names is kept: "Error: TypeError: <sentence>".
 * 3. A system error keeps its code and its call: "ENOSPC: no space left on device, write" for "no space left on device".
 * 4. A sentence that begins with ERROR: (a back-office's own words) is taken for a system code: its "ERROR:" and all
 *    after its first comma go (the (?!ERROR:) guard).
 * 5. The sentence keeps its last stop, or the spaces after it, so the window's own stop makes "..".
 * 6. A stop inside the sentence goes too (a version, an address, a second sentence).
 * 7. A value that is not an Error (a string a handler answered) is not read the same.
 */

describe('reasonOf: main\'s sentence, as the window shows it', () => {
  it('1. Electron\'s wrapping goes, the channel\'s name with it', () => {
    expect(reasonOf(new Error("Error invoking remote method 'traces:remove': Error: the store is locked"))).toBe('the store is locked');
  });

  it('2. a chain of error names goes', () => {
    expect(reasonOf(new Error('Error: TypeError: the list is not an array'))).toBe('the list is not an array');
  });

  it('3. a system error keeps its words, not its code or its call', () => {
    expect(reasonOf(new Error('ENOSPC: no space left on device, write'))).toBe('no space left on device');
    expect(reasonOf(new Error("Error invoking remote method 'traces:setSettings': Error: EACCES: permission denied, open '/x/y'"))).toBe('permission denied');
  });

  it('4. a sentence that begins with ERROR: is a sentence, not a system code', () => {
    expect(reasonOf(new Error('ERROR: the quota is reached, try again tomorrow'))).toBe('ERROR: the quota is reached, try again tomorrow');
  });

  it('5. its last stops and spaces go, so the window\'s own stop is the only one', () => {
    expect(reasonOf(new Error('404 not_found.'))).toBe('404 not_found');
    expect(reasonOf(new Error('the upload was refused.. \n'))).toBe('the upload was refused');
  });

  it('6. a stop inside the sentence stays', () => {
    expect(reasonOf(new Error('gemini 0.70.0 refused it. Try again.'))).toBe('gemini 0.70.0 refused it. Try again');
  });

  it('7. a string is read as an Error\'s message is', () => {
    expect(reasonOf('Error: the address is not a URL.')).toBe('the address is not a URL');
  });
});
