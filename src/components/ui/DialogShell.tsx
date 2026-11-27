'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

/**
 * Every dialog in the app.
 *
 * The two dozen hand-rolled overlays each picked their own scrim, their own
 * radius, a `max-h-[90vh]` that left an empty gutter under short content, and
 * an X in the corner competing with the Cancel button underneath it. The
 * design has one dialog: pinned 90px from the top of the window, centred
 * horizontally, exactly as tall as what is in it, and dismissed from the
 * footer.
 *
 * Header, body and footer all sit on the same `bg-card`; the only thing
 * separating them is a 1px border.
 */
export function DialogShell({
  open = true,
  onClose,
  title,
  subtitle,
  headerRight,
  width = 620,
  footerLeft,
  footerRight,
  children,
  className = '',
}: {
  /** Consumers that mount conditionally can ignore this. */
  open?: boolean;
  /** Escape and a click on the scrim both call it. */
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Sits opposite the title, top-right of the header band - a mode switch, not an action. */
  headerRight?: ReactNode;
  /** 620-860. Wider than that and the dialog stops reading as a dialog. */
  width?: number;
  /** Secondary action, far left of the footer (Delete, Reset, ...). */
  footerLeft?: ReactNode;
  /** `[Cancel][primary]` in that order - the accent-filled one is rightmost. */
  footerRight?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  // More below: the body overflows and is not scrolled to its end (`Dialog · a body longer than the window`). macOS
  // hides the scroll bar, so without it a half-cut line was the only sign, and an answer could be given unread.
  const body = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const el = body.current;
    setMore(!!el && el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  }, []);
  useEffect(() => {
    const el = body.current;
    if (!open || !el) return;
    measure();
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    for (const child of Array.from(el.children)) seen.observe(child);
    return () => seen.disconnect();
  }, [open, measure, children]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] bg-scrim" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        // Height comes from the content. The max only exists so a long body
        // scrolls inside the dialog instead of running off the bottom of the
        // window - it is not a fixed height.
        style={{ width }}
        className={`absolute top-[90px] left-1/2 -translate-x-1/2 max-w-[calc(100vw-48px)] max-h-[calc(100vh-140px)] flex flex-col border border-border bg-card ${className}`}
      >
        {(title || subtitle) && (
          <div className="px-4 py-3.5 border-b border-border shrink-0 flex items-start justify-between gap-4">
            <div className="min-w-0">
              {title && <h2 className="font-serif text-2xl leading-[1.15] text-foreground">{title}</h2>}
              {subtitle && (
                <p className="mt-0.5 text-[12.5px] leading-[1.4] text-muted-foreground">{subtitle}</p>
              )}
            </div>
            {headerRight && <div className="shrink-0 pt-0.5">{headerRight}</div>}
          </div>
        )}
        <div className="relative min-h-0 flex flex-col">
          <div ref={body} onScroll={measure} className="min-h-0 overflow-y-auto p-4">{children}</div>
          {more && (
            <button
              type="button"
              onClick={() => body.current?.scrollBy({ top: body.current.clientHeight - 26, behavior: 'smooth' })}
              className="absolute inset-x-0 bottom-0 h-[26px] flex items-center justify-center gap-1.5 border-t border-border bg-card font-mono text-[10.5px] text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className="w-3 h-3" aria-hidden />
              more below
            </button>
          )}
        </div>
        {(footerLeft || footerRight) && (
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-border shrink-0">
            <div className="flex items-center gap-2">{footerLeft}</div>
            <div className="flex items-center gap-2">{footerRight}</div>
          </div>
        )}
      </div>
    </div>
  );
}
