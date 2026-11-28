'use client';

import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { CardTitleContext } from '@/components/ui/CardTitle';
import type { MorePage } from './more-pages';

/**
 * A page of More, opened as a card above the app, as Claude desktop opens its
 * Settings (`Shell · chats · Settings card`). The app stays as it was under
 * the scrim and its route does not move; the card's head carries the page's
 * icon and name, Escape, the cross or a click on the scrim closes it. The page
 * inside is the one its own route shows, unchanged, but for a header that
 * would only repeat the card's name (ui/CardTitle).
 */
export function PageCard({ page, onClose }: { page: MorePage; onClose: () => void }) {
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    card.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const Icon = page.icon;
  const Page = page.Page;
  const HeadExtra = page.HeadExtra;
  return (
    <div className="fixed inset-0 z-[80] bg-scrim flex items-center justify-center" onMouseDown={onClose}>
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={page.label}
        tabIndex={-1}
        className="w-[min(1080px,calc(100vw-64px))] h-[calc(100vh-128px)] bg-card border border-border-accent flex flex-col outline-none"
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-4 pl-[22px] pr-[14px] py-[14px] border-b border-border shrink-0">
          <div className="flex items-center gap-[10px] min-w-0">
            <Icon className="w-4 h-4 shrink-0 text-muted-foreground" />
            <h2 className="font-serif text-[22px] leading-[1.15] text-foreground truncate">{page.label}</h2>
          </div>
          <div className="flex items-center gap-[10px] shrink-0">
            {HeadExtra && <HeadExtra />}
            <span className="font-mono text-[10.5px] text-status-idle">esc</span>
            {/* A square of the small height: Button's own padding would leave the cross 4px. */}
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="w-[26px] h-[26px] flex items-center justify-center border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
        <div className={page.bare ? 'flex-1 min-h-0 flex flex-col' : 'flex-1 min-h-0 overflow-y-auto px-[26px] pt-[18px] pb-[22px]'}>
          <CardTitleContext.Provider value={page.label}>
            <Page />
          </CardTitleContext.Provider>
        </div>
      </div>
    </div>
  );
}
