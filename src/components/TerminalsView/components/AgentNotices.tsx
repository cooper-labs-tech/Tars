'use client';

import { useMemo } from 'react';
import { Button, StatusSquare } from '@/components/ui';
import { markNoticesSeen, useAgentNotices } from '@/hooks/useAgentNotices';
import { noticeTone, noticeWho } from '@/lib/agent-notices';

/** Rows a panel gives its notices before it counts the rest. */
const SHOWN = 3;

/**
 * What Tars says about this agent that its terminal never shows: a session refused on a hook, a conversation that
 * starts over on a restart. Frame: `Agent notices (2.0.7) · in its panel and in Logs`.
 *
 * Between the header and the terminal, never inside it: the terminal is the CLI's screen. The notices not seen yet,
 * newest first, at most three, each with when Tars wrote it and `seen`, which takes it off the panel (Logs keeps
 * it); past three, how many more and `mark all seen`. The tone is the square's: an error for a refused session, a
 * wait for a conversation that starts over. With none to show, nothing is drawn.
 */
export default function AgentNotices({ agentId }: { agentId: string }) {
  const notices = useAgentNotices(agentId);
  const unseen = useMemo(() => notices.filter(n => n.seenAt === undefined), [notices]);
  if (unseen.length === 0) return null;
  const more = unseen.length - SHOWN;
  return (
    <div role="log" aria-label="Tars's notices about this agent" className="shrink-0">
      {unseen.slice(0, SHOWN).map(n => (
        <div
          key={n.id}
          data-agent-notice={n.id}
          className="flex items-center gap-2.5 px-3.5 py-2 bg-secondary border-b border-border"
        >
          <StatusSquare tone={noticeTone(n.kind)} />
          <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{noticeWho(n)}</span>
          <p title={n.line} className="min-w-0 flex-1 line-clamp-2 text-[11.5px] leading-snug text-foreground">{n.line}</p>
          <Button variant="ghost" size="sm" className="shrink-0 font-mono" onClick={() => markNoticesSeen(agentId, [n.id])}>
            seen
          </Button>
        </div>
      ))}
      {more > 0 && (
        <div className="flex items-center gap-2 px-3.5 py-1.5 bg-secondary border-b border-border">
          <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-muted-foreground">
            {more} earlier notice{more === 1 ? '' : 's'}, in Logs
          </span>
          <Button variant="ghost" size="sm" className="shrink-0 font-mono" onClick={() => markNoticesSeen(agentId)}>
            mark all seen
          </Button>
        </div>
      )}
    </div>
  );
}
