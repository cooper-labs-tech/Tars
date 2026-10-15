import type { OverseerMessage } from '@/types/electron';

/**
 * One entry in the rendered thread: either a message, or a run of consecutive
 * replies that came back as the format template instead of an answer.
 */
export type ThreadItem =
  | { kind: 'message'; message: OverseerMessage }
  | { kind: 'echo'; key: string; messages: OverseerMessage[] };

/**
 * Fold each run of consecutive template echoes into a single entry.
 *
 * Per run rather than one banner for the whole conversation, because where they
 * happened is the part that matters: a fold sitting under a question JeanBrasse asked
 * says that question went unanswered, which a count at the top of the thread
 * cannot. Nothing is dropped - every message stays in the run it belongs to and
 * the fold opens onto all of them.
 *
 * The role is tested alongside the flag rather than trusted. Nothing marks a
 * user message today, and the flag is computed rather than stored, but folding
 * is the one thing that must never happen to a line JeanBrasse typed, so the rule
 * that protects it is written where it is relied on instead of being inherited
 * from how the reader currently happens to behave.
 */
export function groupThread(messages: OverseerMessage[]): ThreadItem[] {
  const items: ThreadItem[] = [];

  for (const message of messages) {
    if (!message.templateEcho || message.role !== 'overseer') {
      items.push({ kind: 'message', message });
      continue;
    }
    const last = items[items.length - 1];
    if (last && last.kind === 'echo') last.messages.push(message);
    else items.push({ kind: 'echo', key: message.id, messages: [message] });
  }

  return items;
}
