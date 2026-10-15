import { agents } from '../core/agent-manager';

/**
 * The narrow set of things the overseer may do without asking.
 *
 * The write gate does not move: nothing reaches a CLI except through
 * `confirmPendingAction`, and it still rejects malformed actions and replays.
 * A rule here decides that a particular proposal counts as already approved,
 * and every rule has to earn that by being specific about the state it applies
 * to. Anything a rule does not match still waits for JeanBrasse, which is every
 * proposal by default: the list starts empty.
 *
 * Two things every rule must respect, because they are correctness rather than
 * taste:
 *
 * - **Never write to a running agent.** Typing into a session mid-task
 *   interleaves with what it is doing.
 * - **Never write to one blocked on a permission dialog.** That dialog wants
 *   arrow keys, and the delayed carriage return Tars sends could accept the
 *   permission it is asking about. `/dispatch` refuses this too; a rule must
 *   not be the thing that gets around it.
 *
 * An automatic send is never silent: the message in the chat says which rule
 * sent it, so a rule doing the wrong thing is visible rather than inferred.
 */

export interface AutoActionRule {
  id: string;
  /** Shown beside the switch. */
  label: string;
  /** What it does and when, in the words a user needs to decide. */
  description: string;
  matches: (target: { agentId: string }, now: number) => boolean;
}

/** How long an agent must have been waiting before a nudge is not premature. */
const STUCK_AFTER_MS = 5 * 60 * 1000;
/** A moment's grace before answering an error, so this does not race the write
 *  that recorded it. */
const ERRORED_AFTER_MS = 60 * 1000;

export const AUTO_ACTION_RULES: AutoActionRule[] = [
  {
    id: 'nudge-waiting',
    label: 'Nudge an agent that is waiting for you',
    description:
      'Sends the overseer\'s message on its own when the agent has been waiting for an answer for more than five minutes and is not blocked on a permission dialog. It has already asked to go on; this stops the fleet stalling on a question nobody saw.',
    matches: ({ agentId }, now) => {
      const agent = agents.get(agentId);
      if (!agent) return false;
      if (agent.status !== 'waiting') return false;
      // A permission dialog cannot be answered with text, and trying could
      // accept it. This is the one state a nudge must never touch.
      if (agent.waitingReason === 'permission') return false;
      const since = Date.parse(agent.lastActivity || '');
      if (!Number.isFinite(since)) return false;
      return now - since >= STUCK_AFTER_MS;
    },
  },
  {
    id: 'restart-errored',
    label: 'Restart an agent that has errored',
    description:
      'Sends the overseer\'s message on its own when the agent is in an error state and has been for a minute. It has already stopped, so there is nothing to interrupt, and a fleet does not recover from an error on its own.',
    matches: ({ agentId }, now) => {
      const agent = agents.get(agentId);
      if (!agent) return false;
      if (agent.status !== 'error') return false;
      // A moment's grace so this does not race the status write that put it
      // there, and so a burst of errors is not answered mid-burst.
      const since = Date.parse(agent.lastActivity || '');
      if (!Number.isFinite(since)) return false;
      return now - since >= ERRORED_AFTER_MS;
    },
  },
];

/**
 * The rule that authorises this action, or null.
 *
 * Resolved against the live agent map at the moment of the decision, never
 * against the snapshot the model was shown: an agent that has moved on since
 * the proposal was written must not be nudged on the strength of what it was
 * doing a minute ago.
 */
export function findAutoRule(
  enabledIds: string[],
  target: { agentId: string },
  now = Date.now(),
): AutoActionRule | null {
  if (!enabledIds || enabledIds.length === 0) return null;
  for (const rule of AUTO_ACTION_RULES) {
    if (!enabledIds.includes(rule.id)) continue;
    if (rule.matches(target, now)) return rule;
  }
  return null;
}
