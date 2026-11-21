import type { CLIProvider } from '../providers/cli-provider';

/** How a message goes into an agent's terminal (send_message's mode, services/api-routes/agent-routes.ts). */
export type SendMode = 'auto' | 'queue' | 'steer' | 'restart';
export type AskedMode = SendMode | 'note' | 'note-now';

/**
 * The mode a message goes in with, from the one asked: a note waits for the turn's end (`queue`), a note-now goes at
 * once (`auto`), and a worker's message to another agent is a note. For a CLI that loses what is typed during its turn
 * (`noteDuringTurn: 'lost'`, Goose), nothing goes at once: `auto` and `note-now` wait for the turn's end too.
 */
export function sendModeOf(asked: AskedMode, opts: { workerNote: boolean; noteDuringTurn?: CLIProvider['noteDuringTurn'] }): SendMode {
  const mode: SendMode = opts.workerNote || asked === 'note' ? 'queue' : asked === 'note-now' ? 'auto' : asked;
  return mode === 'auto' && opts.noteDuringTurn === 'lost' ? 'queue' : mode;
}
