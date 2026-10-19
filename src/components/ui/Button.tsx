'use client';

import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'icon';

// Every variant carries a border, transparent where it should not show. The
// filled ones used to have none, so a primary rendered 2px shorter than the
// secondary next to it and no two buttons in a row shared an edge.
// In this codebase `--accent` is the brand orange, not shadcn's subtle hover
// surface, so `hover:bg-accent/50` washes a bordered button half-orange. Every
// neutral hover here is `bg-secondary`.
const VARIANTS: Record<Variant, string> = {
  primary: 'border border-primary bg-primary text-primary-foreground hover:bg-primary/90',
  secondary: 'border border-border bg-card text-foreground hover:bg-secondary',
  ghost: 'border border-transparent text-muted-foreground hover:text-foreground hover:bg-secondary',
  danger: 'border border-danger/40 text-danger hover:bg-danger/10',
};

// Selected is a box, never an inverted fill and never an accent fill: the
// border darkens and the surface lifts one step. Tabs, filter chips and
// segmented controls all read the same because they all come through here.
const ACTIVE = 'border border-border-accent bg-secondary text-foreground';

// Two heights, fixed. Padding-driven heights drifted with the content: an icon
// made a button taller than the one beside it holding only a word. Callers may
// not pass a `py-*` or `h-*` override in `className` - pick a size instead.
const SIZES: Record<Size, string> = {
  sm: 'h-[26px] px-2.5 text-xs gap-1.5',
  md: 'h-8 px-3 text-sm gap-2',
  // The small height, square: a glyph or a figure alone, as a pager's arrows and
  // pages. A `px-0` passed with `sm` loses to its `px-2.5`, and an icon was
  // squeezed into the 4px left between the two.
  icon: 'h-[26px] w-[26px] text-xs',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Selected state for tabs, chips and segmented controls. Replaces the
   *  variant's fill and border - it does not stack on top of them. */
  active?: boolean;
  children?: ReactNode;
}

/**
 * The one button. No inline styles, no shadows, no radius overrides - the
 * shape comes from the theme so a future rebrand never has to hunt through
 * component files.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', active = false, className = '', children, ...rest }, ref,
) {
  // `active` painted the box and told a screen reader nothing, so a selected
  // tab and an unselected one read identically. `aria-pressed` is the right
  // default because a button that carries a selected state is usually a toggle,
  // but it is only a default: a tab wants aria-selected with role="tab", and a
  // disclosure wants aria-expanded, so a caller that has already said which one
  // it is wins.
  const saysItsOwnState =
    'aria-pressed' in rest || 'aria-selected' in rest ||
    'aria-expanded' in rest || 'aria-current' in rest;

  return (
    <button
      ref={ref}
      data-active={active || undefined}
      {...(saysItsOwnState ? {} : { 'aria-pressed': active })}
      className={`inline-flex items-center justify-center font-medium transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${active ? ACTIVE : VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});
