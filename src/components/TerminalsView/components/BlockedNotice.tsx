'use client';

import { Button, StatusSquare } from '@/components/ui';
import type { BlockedReason } from '@/lib/blocked-reason';

const ACTION = 'font-mono lowercase';

/**
 * The line a panel shows while its CLI says it is blocked (OSC 7501, #510): a permission, a question, or a sign-in,
 * with the CLI's own message, and the action that brings its terminal forward. The row of MessageWaitingNotice, 26
 * high under the header: the sentence is cut first, the action stays. Frame: `Blocked (2.0.5) · an agent blocked,
 * its reason`.
 */
export default function BlockedNotice({ blocked, onOpen }: { blocked: BlockedReason; onOpen: () => void }) {
  return (
    <div
      role="status"
      data-blocked={blocked.kind}
      title={blocked.line}
      className="h-[26px] shrink-0 flex items-center gap-2 pl-3 pr-1 bg-secondary border-b border-border select-none"
    >
      <StatusSquare tone={blocked.tone} />
      <p className="min-w-0 flex-1 truncate text-[11px] leading-tight text-muted-foreground">{blocked.line}</p>
      <div className="shrink-0 flex items-center">
        <Button variant="ghost" size="sm" className={ACTION} onClick={onOpen} title="Bring its terminal forward">
          {blocked.action}
        </Button>
      </div>
    </div>
  );
}
