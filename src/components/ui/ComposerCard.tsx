'use client';

import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { ArrowUp, FileText, Image as ImageIcon, Plus, X } from 'lucide-react';
import { StatusSquare } from './StatusBadge';
import type { StatusTone } from './StatusBadge';

/**
 * The Chat's message composer: one card under the thread, modeled on Claude's
 * and ChatGPT's. What is attached, then the text, then a row with + and the
 * pickers on the left and send on the right. The room and Hermes both use it,
 * with their own pickers and their own notices.
 *
 * Frames: `Chat · A · Composer · states` and its `· light`, in
 * `design/chat-redesign-a.pen`.
 */

/** The field grows to this many lines, then scrolls inside the card. */
const MAX_LINES = 8;
/** Body text is 14/20, on the 4px grid every chat frame is drawn on. */
const LINE_PX = 20;
/** The field's own padding, top and bottom together: an empty field is 28. */
const FIELD_PAD_PX = 8;

/**
 * A line across the top of the card about what will happen to the message:
 * it will queue, it is held, nobody can receive it, it was not sent.
 */
export interface ComposerNotice {
  /** The square at the start, for the agent the sentence is about. */
  tone?: StatusTone;
  hollow?: boolean;
  text: string;
  /** `error` in the error ink, `question` in the primary one, else secondary. */
  emphasis?: 'error' | 'question';
  /** 26px buttons at the right end of the strip. */
  actions?: ReactNode;
}

/**
 * What the strip says when a send failed. The words stay in the field, so it
 * says so, and send is how to try again: the card needs no second button.
 */
export function notSentText(reason?: string | null): string {
  const why = (reason ?? '').trim().replace(/[.\s]+$/, '');
  return `Not sent: ${why || 'the message was not accepted'}. Your text is still here; press send to try again.`;
}

export function ComposerCard({
  value,
  onChange,
  onSubmit,
  placeholder,
  canSubmit,
  submitLabel,
  disabled = false,
  notice,
  attachments,
  controls,
  onAttach,
  attachLabel,
  onPasteFiles,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Send: the button, and Enter without Shift. */
  onSubmit: () => void;
  placeholder: string;
  /** Whether send does anything now. Off, the button fades and Enter does nothing. */
  canSubmit: boolean;
  /** What send will do, for its tooltip and its accessible name. */
  submitLabel: string;
  /** The field itself is off: there is nobody to write to. */
  disabled?: boolean;
  notice?: ComposerNotice | null;
  /** Tiles above the text; nothing when there are none. */
  attachments?: ReactNode;
  /** The pickers, after +. */
  controls?: ReactNode;
  /** + is off without it. */
  onAttach?: () => void;
  /** What + does, or why it cannot. */
  attachLabel: string;
  /** Files pasted into the field join the message, as they do in Claude's
   *  and ChatGPT's. Without it, a paste is text only. */
  onPasteFiles?: (files: File[]) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // An empty field is exactly one line, stated rather than measured: the
    // measured height of an empty textarea moves by a pixel with font loading,
    // and that pixel moves the whole card and the thread above it.
    if (!value) {
      el.style.height = `${LINE_PX + FIELD_PAD_PX}px`;
      return;
    }
    // Measured rather than counted: a long line that wraps takes two rows on
    // screen and one newline in the value, and only the browser knows which.
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_LINES * LINE_PX + FIELD_PAD_PX)}px`;
  }, [value]);

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (!onPasteFiles || files.length === 0) return;
    onPasteFiles(files);
    // A copied image comes with nothing to type; a copied page, with its text
    // as well as its picture, and the text still goes in the field.
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Not while an input method is composing: its Enter picks a candidate.
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (canSubmit) onSubmit();
  };

  return (
    // Focus is the card's border, one step darker, and never the accent: in
    // this card orange is send and nothing else. Nothing clips it: the
    // pickers' panels open upward out of the card, over the thread.
    <div
      role="group"
      aria-label="Message composer"
      className={`shrink-0 flex flex-col rounded border border-border bg-card transition-colors ${
        disabled ? '' : 'focus-within:border-border-accent'
      }`}
    >
      {notice && (
        // 36 high, the square hanging at 10 and the button ending 24 from the
        // edge, as the frame's strip across the card.
        <div role="status" className="flex items-center gap-2 h-9 pl-2.5 pr-6 shrink-0 min-w-0 border-b border-border bg-secondary">
          {notice.tone && <StatusSquare tone={notice.tone} hollow={notice.hollow} size={8} />}
          <p
            title={notice.text}
            className={`min-w-0 truncate text-[12px] leading-4 ${
              notice.emphasis === 'error'
                ? 'text-danger'
                : notice.emphasis === 'question'
                  ? 'text-foreground'
                  : 'text-text-secondary'
            }`}
          >
            {notice.text}
          </p>
          <span className="flex-1" />
          {notice.actions && <div className="flex items-center gap-2 shrink-0">{notice.actions}</div>}
        </div>
      )}

      {/* The text and + at 24 from the card's edge, send ending 24 from it:
          the body at 16 and 24, the field and + each bringing their 8. */}
      <div className="flex flex-col gap-2 pt-3 pr-6 pb-3 pl-4">
        {attachments && <div className="pl-2">{attachments}</div>}

        <textarea
          ref={ref}
          rows={1}
          value={value}
          disabled={disabled}
          aria-label="Message"
          placeholder={placeholder}
          onChange={e => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          // Inline because globals.css gives every textarea a background, a
          // border and an accent focus border outside any layer, which no
          // utility class can override. The field has no box of its own: the
          // card is the box, and the card is what takes focus.
          style={{
            lineHeight: `${LINE_PX}px`,
            maxHeight: MAX_LINES * LINE_PX + FIELD_PAD_PX,
            background: 'transparent',
            border: 'none',
          }}
          className="w-full px-2 py-1 text-[14px] text-foreground outline-none resize-none overflow-y-auto disabled:cursor-not-allowed"
        />

        <div className="flex items-center gap-1 min-w-0">
          <button
            type="button"
            onClick={onAttach}
            disabled={!onAttach || disabled}
            aria-label={attachLabel}
            title={attachLabel}
            className="inline-flex items-center justify-center w-8 h-8 shrink-0 border border-transparent text-muted-foreground transition-colors cursor-pointer hover:text-foreground hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Plus className="w-4 h-4" />
          </button>
          {controls}
          <span className="flex-1" />
          <button
            type="button"
            onClick={onSubmit}
            disabled={!canSubmit}
            aria-label={submitLabel}
            title={submitLabel}
            className="inline-flex items-center justify-center w-8 h-8 shrink-0 border border-primary bg-primary text-primary-foreground transition-colors cursor-pointer hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ArrowUp className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One attached file, above the text: its kind, its name, what it is, and its
 * remove. A 56px tile whatever the file, because the card never holds an
 * image's pixels today: Hermes's files are on the gateway once picked. The
 * frame's thumbnail is for a pasted or dropped image, which arrives with its
 * bytes, and comes with them.
 */
export function AttachmentTile({
  name,
  meta,
  isImage,
  title,
  onRemove,
}: {
  name: string;
  meta: string;
  isImage: boolean;
  /** On hover: where the file really is, when that is worth reading but too
   *  long for the tile. The name when absent. */
  title?: string;
  onRemove?: () => void;
}) {
  const Kind = isImage ? ImageIcon : FileText;
  return (
    <div className="flex items-center gap-2 w-[200px] h-14 pl-3 pr-1 shrink-0 rounded border border-border bg-secondary" title={title ?? name}>
      <span className="inline-flex items-center justify-center w-8 h-8 shrink-0 rounded border border-border bg-card">
        <Kind className="w-4 h-4 text-muted-foreground" />
      </span>
      <span className="flex-1 min-w-0 flex flex-col gap-0.5">
        <span className="text-[12px] leading-4 font-medium text-foreground truncate">{name}</span>
        <span className="font-mono text-[10.5px] leading-4 text-text-muted truncate">{meta}</span>
      </span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          title={`Remove ${name}`}
          className="inline-flex items-center justify-center w-[26px] h-[26px] shrink-0 border border-transparent text-muted-foreground transition-colors cursor-pointer hover:text-foreground hover:bg-card"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

/**
 * A pasted, dropped or picked image, above the text: the picture itself in a
 * 56px tile, its remove on hover or focus. Frame: `Chat · A · Composer ·
 * states` > `WITH ATTACHMENTS`, the first two tiles.
 */
export function ImageTile({
  src,
  name,
  title,
  onRemove,
}: {
  /** A local URL for the image's bytes, owned and revoked by the caller. */
  src: string;
  name: string;
  title?: string;
  onRemove?: () => void;
}) {
  return (
    <div className="group relative w-14 h-14 shrink-0 rounded border border-border hover:border-border-accent bg-term-bg overflow-hidden" title={title ?? name}>
      {/* A blob URL of bytes still in this window: nothing to optimise, and
          next/image has nothing to fetch. */}
      <img src={src} alt={name} className="w-full h-full object-cover" />
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${name}`}
          title={`Remove ${name}`}
          className="absolute top-[3px] right-[3px] inline-flex items-center justify-center w-[26px] h-[26px] rounded border border-border bg-card text-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer"
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
