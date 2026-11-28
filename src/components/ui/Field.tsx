'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, ReactNode } from 'react';

const BASE = 'px-2 bg-secondary border text-xs text-foreground placeholder:text-muted-foreground outline-none transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
/** Same 32px as a md Button, so a field and the button beside it share edges. */
const CONTROL_HEIGHT = 'h-8';
/** The 26px row used in dense tables, e.g. a team's member grid. */
const CONTROL_HEIGHT_SM = 'h-[26px]';

/** Fills its column, or the fixed 300px settings control column. One source for both. */
type Width = 'full' | 'control';
const WIDTHS: Record<Width, string> = {
  full: 'w-full',
  control: 'w-[300px]',
};

interface FieldProps {
  width?: Width;
  error?: boolean;
  /**
   * The 26px row used in dense tables, e.g. a team's member grid. Not called
   * `size` - `<input>` already has a native `size` attribute (a number of
   * characters), and intersecting it with a `'sm' | 'md'` union collapses to
   * `never`.
   */
  compact?: boolean;
}

/**
 * Read-only reads as read-only (frame XFApe, rows kjeqD and B85KKr): the
 * panel's `surface` fill instead of a field's `surface-raised`, the value in
 * `text-secondary` and the default cursor. On focus it takes the accent border
 * every field takes, the only sign a field holds the focus (state RKPfa).
 * The text stays selectable. `enabled:` leaves a disabled field alone, which
 * `:read-only` matches too; and not on Select, which `:read-only` always
 * matches.
 */
const READ_ONLY = 'read-only:enabled:bg-card read-only:enabled:text-text-secondary read-only:enabled:cursor-default';

// Five states: default, focus, error, disabled, read-only. Disabled lives in
// BASE because the browser owns it, read-only in READ_ONLY; the other three
// are all border colour.
const border = (error?: boolean) =>
  error ? 'border-danger focus:border-danger' : 'border-border focus:border-primary/40';

export function Label({ children }: { children: ReactNode }) {
  return <label className="block text-xs font-medium text-foreground mb-1">{children}</label>;
}

/** The caption under a field in its error state. Pair with `error` on the field itself. */
export function FieldError({ children }: { children: ReactNode }) {
  return <p className="mt-1 text-[11px] text-danger">{children}</p>;
}

export function Input({ className = '', mono, width = 'full', error, compact, ...rest }: InputHTMLAttributes<HTMLInputElement> & FieldProps & { mono?: boolean }) {
  return <input className={`${BASE} ${READ_ONLY} ${compact ? CONTROL_HEIGHT_SM : CONTROL_HEIGHT} ${WIDTHS[width]} ${border(error)} ${mono ? 'font-mono' : ''} ${className}`} {...rest} />;
}

/**
 * A secret with a word, not a glyph: the reveal affordance reads `show`/`hide`
 * in muted mono at the right inside edge instead of an eye icon.
 */
export function PasswordInput({ className = '', width = 'full', error, disabled, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & FieldProps) {
  const [shown, setShown] = useState(false);
  return (
    <span className={`relative block ${WIDTHS[width]} ${className}`}>
      <input
        type={shown ? 'text' : 'password'}
        disabled={disabled}
        className={`${BASE} ${READ_ONLY} ${CONTROL_HEIGHT} w-full ${border(error)} font-mono pr-11`}
        {...rest}
      />
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        disabled={disabled}
        className="absolute right-2 top-1/2 -translate-y-1/2 font-mono text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        {shown ? 'hide' : 'show'}
      </button>
    </span>
  );
}

/**
 * The native indicator is a grey square no theme can reach, so it is suppressed
 * and a chevron drawn over the right inside edge. `className` lands on the
 * wrapper - it is the element that carries the field's box in the layout.
 */
export function Select({ className = '', children, width = 'full', error, compact, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & FieldProps) {
  return (
    <span className={`relative block ${WIDTHS[width]} ${className}`}>
      <select className={`${BASE} ${compact ? CONTROL_HEIGHT_SM : CONTROL_HEIGHT} w-full ${border(error)} appearance-none pr-7`} {...rest}>{children}</select>
      <ChevronDown className="w-3 h-3 text-muted-foreground absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" />
    </span>
  );
}

export function Textarea({ className = '', width = 'full', error, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & FieldProps) {
  return <textarea className={`${BASE} ${READ_ONLY} ${WIDTHS[width]} ${border(error)} py-1.5 resize-y ${className}`} {...rest} />;
}
