/**
 * An Esc or a Ctrl-C a person typed from the window into an agent's terminal (trace feature B3, 27/11): what a traced
 * session counts as an interruption, and as the cause of a harness hanging up on its request.
 *
 * Every key the window sends reaches the main process as xterm sends it, one onData chunk per key or per sequence
 * (agent:input, then pty-manager.ts writeHumanInput), the same bytes on macOS, Linux and Windows, read here before
 * node-pty writes them to the terminal, a ConPTY's included. So a lone Esc is a chunk that is ESC and nothing else, and
 * a lone Ctrl-C one that is ETX and nothing else: an arrow key (ESC [ A, or ESC O A), a modified or function key, a
 * mouse or focus report, a terminal's reply, Alt with a key (ESC x) and a bracketed paste all come as one chunk with
 * more after the ESC. A chunk cut in two is not something xterm sends, but the wait below makes it harmless: an ESC
 * followed within ESC_WAIT_MS by any chunk is taken for the start of a sequence, never for an Esc, as a terminal's
 * own escape timeout does. No person types Esc then another key within that.
 */

export type InterruptKey = 'esc' | 'ctrl_c';

/** How long a lone ESC waits for the rest of a sequence before it is an Esc. */
export const ESC_WAIT_MS = 50;

/** What one chunk of a person's keys is: a lone Esc, a lone Ctrl-C, or neither. */
export function interruptKeyOf(chunk: string): InterruptKey | null {
  if (chunk === '\x1b') return 'esc';
  if (chunk === '\x03') return 'ctrl_c';
  return null;
}

interface Waiting<C> { at: number; context?: C; timer: ReturnType<typeof setTimeout> }

/**
 * A person's keys, per agent: a Ctrl-C told at once, an Esc once ESC_WAIT_MS passed with no chunk after it, at the
 * time it came. `context` is what the caller read when the key came (whether the model was answering), handed back
 * with it.
 */
export class InterruptKeys<C = undefined> {
  private readonly waiting = new Map<string, Waiting<C>>();

  constructor(private readonly onKey: (agentId: string, key: InterruptKey, at: number, context?: C) => void, private readonly waitMs = ESC_WAIT_MS) {}

  feed(agentId: string, chunk: string, at: number, context?: C): void {
    // Any chunk within the wait makes a waiting ESC the start of a sequence.
    this.forget(agentId);
    const key = interruptKeyOf(chunk);
    if (key === 'ctrl_c') { this.onKey(agentId, key, at, context); return; }
    if (key !== 'esc') return;
    const timer = setTimeout(() => {
      this.waiting.delete(agentId);
      this.onKey(agentId, 'esc', at, context);
    }, this.waitMs);
    timer.unref?.();
    this.waiting.set(agentId, { at, context, timer });
  }

  /** The Esc an agent's keys hold while its wait runs, if any: a harness may hang up before the wait is over. */
  pending(agentId: string): { at: number } | undefined {
    const w = this.waiting.get(agentId);
    return w ? { at: w.at } : undefined;
  }

  /** An agent's waiting Esc dropped: its terminal is gone. */
  forget(agentId: string): void {
    const w = this.waiting.get(agentId);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiting.delete(agentId);
  }

  dispose(): void {
    for (const id of [...this.waiting.keys()]) this.forget(id);
  }
}
