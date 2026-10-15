import { summariseRuns } from './overseer-runs';
import { isSameThingSaidAgain, isTemplateEcho } from './overseer-envelope';
import { serializeSnapshot, type FleetSnapshot } from './overseer-fleet';
import type { OverseerMessage } from './overseer-store';

// ── Prompt composition ───────────────────────────────────────────────────

const HISTORY_TURN_LIMIT = 24;
const HISTORY_CHAR_BUDGET = 6000;

function serializeHistory(history: OverseerMessage[]): string {
  // This is where the loop lived. Hermes was shown its own placeholder as
  // something it had already said, so it said it again, and the prompt for
  // the next turn then held two of them. Whatever the guard in finishTurn
  // let through, or an older build wrote before that guard existed, stops
  // here: an echo is never quoted back as an example to follow.
  const usable = history.filter(m => m.role !== 'overseer' || !isTemplateEcho(m.text));
  const recent = usable.slice(-HISTORY_TURN_LIMIT);
  let omitted = usable.length - recent.length;
  const kept: string[] = [];
  let used = 0;

  /**
   * A run of the overseer saying one thing becomes that thing, once, with the
   * count.
   *
   * This is where the second loop is broken, and it is broken here rather than
   * on the way in for two reasons. Nothing on disk is touched, so a heuristic
   * that gets it wrong costs a line of context and not a message the user
   * wrote. And it works on conversations that are already stuck: an install
   * carrying a hundred and seventy eight copies of one sentence stops being
   * conditioned by them the next time it composes a turn, with nobody having
   * to clear anything.
   *
   * JeanBrasse's turns in between do not break the run. He asked the same question
   * three times and got the same answer three times, which is one answer.
   */
  // Built newest first, then turned round at the end, so the line a run of
  // repeats belongs to is always the one just added and never has to be found
  // again by index.
  const newestFirst: string[] = [];
  let runIndex = -1;
  let runOf: string | null = null;
  let runExtra = 0;
  const closeRun = () => {
    if (runExtra > 0 && runIndex >= 0) {
      newestFirst[runIndex] +=
        `\n(the overseer said that again ${runExtra} more time(s) before this, adding nothing new. Do not say it again.)`;
    }
    runExtra = 0;
    runIndex = -1;
    runOf = null;
  };

  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];

    if (m.role === 'overseer') {
      if (runOf !== null && isSameThingSaidAgain(m.text, runOf)) {
        runExtra++;
        continue;
      }
      closeRun();
    }

    const speaker = m.role === 'user' ? 'USER' : 'OVERSEER';
    const actionNote = m.action ? ` [proposed messaging agent ${m.action.agentId}]` : '';
    const line = `${speaker}: ${m.text}${actionNote}`;
    if (used + line.length > HISTORY_CHAR_BUDGET) {
      closeRun();
      omitted += i + 1;
      break;
    }
    newestFirst.push(line);
    used += line.length;
    if (m.role === 'overseer') {
      runIndex = newestFirst.length - 1;
      runOf = m.text;
    }
  }
  closeRun();
  kept.push(...newestFirst.reverse());
  const lines: string[] = [];
  if (omitted > 0) lines.push(`(${omitted} earlier message(s) omitted)`);
  lines.push(...kept);
  return lines.join('\n');
}

/**
 * The prompt sent to Hermes for one turn. Exported so it can be inspected
 * independently of the network round trip in askOverseer().
 */
export function composeTurn(
  snapshot: FleetSnapshot,
  history: OverseerMessage[],
  userMessage: string,
  opts: { isBriefing?: boolean } = {},
): string {
  const instructions = [
    'You are the Overseer: a Hermes agent embedded in Tars, watching every coding agent in every project for the user.',
    'Your job is to report what the fleet is doing, the decisions in flight, challenge choices that look wrong, and propose next steps. You talk to orchestrator agents as a peer would, through the user.',
    '',
    'Rules:',
    '- You never claim to have done anything yourself. You only report, challenge, and propose.',
    '- You may name an agent to message ONLY by an "id" value that literally appears in the FLEET SNAPSHOT below. Never invent an id, and never substitute a name for an id.',
    '- You never send anything directly. Tars shows the user exactly what you propose to write, and to which agent, before anything is sent; nothing happens until they approve it.',
    '- Reply with EXACTLY one JSON object and nothing else, before or after it.',
    '- The object has two keys. "say" is a string: what you are telling the user, in plain text or light markdown, written by you about the snapshot below. "action" is null.',
    '- Only when you are proposing to message one specific agent, "action" is instead an object with three keys: "kind", which is always the string message_agent; "agent_id", an id copied from the snapshot; and "text", the exact message you propose sending. If no agent in the snapshot is the right target, "action" stays null.',
    '- There is no specimen of that object written here, deliberately. Three times now a model has answered by returning the example it was shown rather than filling it in, once for a whole day, and the shape of the example made no difference: a blank one was copied, then a filled in one was copied, and the filled in one was worse because it read like a real observation. Build the object from what you can actually see below.',
    '- Look at the FLEET SNAPSHOT below before you write. It is the fleet as it is right now; the conversation above it is only what was already said, and some of it is hours old. Never repeat an earlier answer of yours: if nothing has changed since it, say that briefly instead of saying the same thing again.',
  ].join('\n');

  const turnLabel = opts.isBriefing
    ? '=== AUTOMATIC CHECK-IN (Tars\' watch timer, not a message from the user) ==='
    : '=== USER ===';
  const turnBody = opts.isBriefing
    ? `${userMessage}\nThis is an unprompted check-in triggered by a fleet change, not a question. If something is worth flagging, say it concisely; otherwise say something minimal like "Nothing worth flagging."`
    : userMessage;

  // What the fleet has been doing, when there is anything to say. A snapshot
  // answers "where is everyone"; this answers "how has it been going", which
  // is what makes "that is the third time it has restarted on this" possible.
  const history24h = summariseRuns();

  // The snapshot sits after the conversation, not before it. It used to open
  // the prompt, which put twenty four turns of history between the fleet as it
  // is now and the question being asked, and a stuck conversation is exactly
  // the case where those twenty four turns all say one thing. The freshest
  // state now reads last, immediately above the turn it has to answer.
  return [
    instructions,
    '',
    '=== CONVERSATION SO FAR (what was already said; the older lines may be hours old) ===',
    history.length ? serializeHistory(history) : '(nothing yet, this is the first turn)',
    ...(history24h ? ['', `=== ${history24h}`] : []),
    '',
    '=== FLEET SNAPSHOT (the fleet as it is right now, taken this second) ===',
    serializeSnapshot(snapshot),
    '',
    turnLabel,
    turnBody,
  ].join('\n');
}
