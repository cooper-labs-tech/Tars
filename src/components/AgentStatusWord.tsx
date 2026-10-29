'use client';

import { StatusSquare } from '@/components/ui';
import type { AgentStatus } from '@/types/electron';
import { STATUS_COLORS, statusWord } from '@/app/agents/constants';
import { wakingLine } from '@/lib/asleep-line';
import { blockedReason } from '@/lib/blocked-reason';

/**
 * An agent's status as the word its row prints, in its ink: the panel's
 * header, the card, the window. An asleep agent's word follows a hollow
 * square, the mark of an agent no CLI holds, and one coming back reads waking
 * in the waiting ink, after a square of it (#322). Every other status is the
 * word alone, as it was. Frame: `Agent asleep · and how it wakes`. One its CLI says is blocked (OSC 7501, #510) reads
 * what on: waiting · permission or question, blocked · sign in in the error ink. Frame: `Blocked (2.0.5)`.
 */
export default function AgentStatusWord({ agent, className = '', title }: {
  agent: Pick<AgentStatus, 'status' | 'waking' | 'programStatus'>;
  className?: string;
  title?: string;
}) {
  if (wakingLine(agent)) {
    return (
      <>
        <StatusSquare tone="waiting" />
        <span className={`${className} text-status-waiting`} title={title}>waking</span>
      </>
    );
  }
  if (agent.status === 'asleep') {
    return (
      <>
        <StatusSquare hollow />
        <span className={`${className} ${STATUS_COLORS.asleep.text}`} title={title}>asleep</span>
      </>
    );
  }
  const blocked = blockedReason(agent);
  if (blocked) {
    return (
      <span className={`${className} ${blocked.tone === 'error' ? 'text-status-error' : 'text-status-waiting'}`} title={title ?? blocked.line}>
        {blocked.word}
      </span>
    );
  }
  return (
    <span className={`${className} ${STATUS_COLORS[agent.status].text}`} title={title}>
      {statusWord(agent.status)}
    </span>
  );
}
