import { describe, it, expect } from 'vitest';
import { describeHermesFailure } from '@/components/KanbanBoard/hermes-error';

/**
 * Kanban is the Hermes board and has no local board to fall back to, so a dead
 * gateway has to explain itself. These lock in the two things that were wrong
 * before: the Electron IPC wrapper leaking on screen, and the gateway address
 * never being named.
 */

const IPC = "Error invoking remote method 'hermes:kanban:board': Error: ";

describe('describeHermesFailure', () => {
  it('names the gateway and the cause when nothing is listening', () => {
    const r = describeHermesFailure(`${IPC}connect ECONNREFUSED 127.0.0.1:9119`, 'http://127.0.0.1:9119');
    expect(r.message).toContain('http://127.0.0.1:9119');
    expect(r.message).toMatch(/not answering/i);
    expect(r.message).not.toContain('invoking remote method');
  });

  it('strips the Electron IPC wrapper off the detail line', () => {
    const r = describeHermesFailure(`${IPC}connect ECONNREFUSED 127.0.0.1:9119`, 'http://127.0.0.1:9119');
    expect(r.detail).toBe('connect ECONNREFUSED 127.0.0.1:9119');
  });

  it('separates a timeout from a refusal', () => {
    const r = describeHermesFailure(`${IPC}timeout`, 'http://100.64.0.1:9119');
    expect(r.message).toMatch(/did not answer in time/i);
    expect(r.message).toContain('http://100.64.0.1:9119');
  });

  it('flags an unresolvable host', () => {
    const r = describeHermesFailure(`${IPC}getaddrinfo ENOTFOUND hermes.example`, 'http://hermes.example:9119');
    expect(r.message).toMatch(/could not be resolved/i);
  });

  it('says the gateway is simply not configured', () => {
    const r = describeHermesFailure(`${IPC}Invalid gateway URL`, null);
    expect(r.message).toMatch(/no hermes gateway is configured/i);
    expect(r.message).not.toContain(' at ');
  });

  it('degrades to a plain sentence for an unknown cause', () => {
    const r = describeHermesFailure(`${IPC}something odd happened`, 'http://127.0.0.1:9119');
    expect(r.message).toBe('Could not reach Hermes at http://127.0.0.1:9119.');
    expect(r.detail).toBe('something odd happened');
  });

  it('omits the address when the base URL is unknown', () => {
    const r = describeHermesFailure(`${IPC}connect ECONNREFUSED 127.0.0.1:9119`, null);
    expect(r.message).not.toContain(' at ');
  });
});

/**
 * An answer Hermes began and never ended (#660, the Audit's I-b): the main
 * process rejects the board's read in two words of its own, which this
 * classifier read as nothing, so the board said its generic "Could not reach
 * Hermes at X." for both:
 * - "its answer was cut off before the end": the connection cut after the
 *   status and its headers came;
 * - "its answer did not end within 30 s": the whole-request deadline, a gateway
 *   trickling its answer past it.
 *
 * How it can fail, written before the code (2026-11-27):
 * 1. A cut or a deadline is worded as the generic sentence, or as a refusal
 *    (nothing listening), which tells the user the gateway is down when it
 *    answered and broke off.
 * 2. The cut and the deadline are worded alike, or as the idle timeout ("did
 *    not answer in time"), which they are not: Hermes began to answer.
 * 3. Either loses the gateway's address, or the detail line loses the words.
 * 4. The timeout and a Node code (ECONNREFUSED) change their sentences.
 * 5. A sentence prints the saved URL whole, its user name, password, query and
 *    hash with it (a token in a query, credentials before the host), where the
 *    main process's own sentence (#660, noAnswerSentence) keeps only the
 *    protocol, the host and the path (the Audit's M1 on #663). Added after 1 to 4.
 * 6. A saved value shaped name:secret parses as a URL (the WHATWG parser reads
 *    the scheme "user:" and the path "s3cretpw"), so a sentence that quotes no
 *    URL that does not parse said "Could not reach Hermes at user://s3cretpw.".
 *    The same for apikey:sk-SECRET, hermes-token:abc123 and any scheme Tars
 *    does not call (ftp://x). Only http: and https: are quoted, as #660's own
 *    sentence does since 0a86e47ce (the Audit's L1 on #663). Added after 5.
 *
 * The sentences themselves are the Frontend's: these only ask that each class
 * has its own, apart from a refusal's.
 */
describe('describeHermesFailure, for an answer Hermes began and never ended', () => {
  const AT = 'http://127.0.0.1:9119';
  const said = (raw: string) => describeHermesFailure(`${IPC}${raw}`, AT);
  const refusal = said('connect ECONNREFUSED 127.0.0.1:9119');
  const timeout = said('timeout');
  const generic = said('something odd happened');
  const cut = said('its answer was cut off before the end');
  const deadline = said('its answer did not end within 30 s');

  it('the cut has a sentence of its own, naming the gateway, apart from a refusal and the generic one (1, 3)', () => {
    expect(cut.message).toContain(AT);
    expect(cut.message).not.toBe(generic.message);
    expect(cut.message).not.toBe(refusal.message);
    expect(cut.message).not.toMatch(/not answering/i);
    expect(cut.detail).toBe('its answer was cut off before the end');
  });

  it('the deadline has a sentence of its own, naming the gateway, apart from a refusal and the generic one (1, 3)', () => {
    expect(deadline.message).toContain(AT);
    expect(deadline.message).not.toBe(generic.message);
    expect(deadline.message).not.toBe(refusal.message);
    expect(deadline.message).not.toMatch(/not answering/i);
    expect(deadline.detail).toBe('its answer did not end within 30 s');
  });

  it('the cut, the deadline and the idle timeout are three sentences (2)', () => {
    expect(new Set([cut.message, deadline.message, timeout.message]).size).toBe(3);
  });

  it('the timeout and a Node code keep their sentences (4)', () => {
    expect(timeout.message).toMatch(/did not answer in time/i);
    expect(refusal.message).toMatch(/not answering/i);
  });

  /** Every class of sentence the board has, each of which names the gateway. */
  const RAWS: Array<[string, string]> = [
    ['the cut', 'its answer was cut off before the end'],
    ['the deadline', 'its answer did not end within 30 s'],
    ['a refusal', 'connect ECONNREFUSED 127.0.0.1:443'],
    ['the timeout', 'timeout'],
    ['a host that cannot be resolved', 'getaddrinfo ENOTFOUND gw.example'],
    ['a TLS refusal', 'self-signed certificate'],
    ['the generic one', 'something odd happened'],
  ];

  describe('a saved URL that carries a user name, a password, a query and a hash (5)', () => {
    const SAVED = 'https://hermes-user:s3cretpw@gw.example/base?token=s3crettok#s3cretfrag';

    it.each(RAWS)('%s names the gateway by its protocol, host and path, and nothing else of the URL', (_what, raw) => {
      const { message } = describeHermesFailure(`${IPC}${raw}`, SAVED);

      expect(message).toContain('https://gw.example/base');
      // The user, the password, the query's token and the hash: every one of them holds "s3cret" but the user.
      for (const secret of ['hermes-user', 's3cret', 'token=']) expect(message).not.toContain(secret);
    });
  });

  describe('a saved value that is not an http(s) URL, though it parses as one (6)', () => {
    /** [the value saved, what of it must never show]. */
    const NOT_HTTP: Array<[string, string]> = [
      ['user:s3cretpw', 's3cretpw'],
      ['apikey:sk-SECRET', 'sk-SECRET'],
      ['hermes-token:abc123', 'abc123'],
      ['ftp://x', 'ftp:'],
    ];
    const CASES = NOT_HTTP.flatMap(([saved, secret]) => RAWS.map(([what, raw]) => [saved, what, raw, secret] as const));

    it.each(CASES)('%s, %s: quotes nothing of it', (saved, _what, raw, secret) => {
      const { message } = describeHermesFailure(`${IPC}${raw}`, saved);

      expect(message).not.toContain(secret);
      expect(message).not.toContain(' at ');
    });

    it.each([['http://127.0.0.1:9119'], ['https://gw.example/base']])('%s is still quoted', (saved) => {
      for (const [, raw] of RAWS) expect(describeHermesFailure(`${IPC}${raw}`, saved).message).toContain(` at ${saved}`);
    });
  });
});
