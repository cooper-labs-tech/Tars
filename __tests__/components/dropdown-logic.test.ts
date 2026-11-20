import '../setup/home-guard';
import { describe, it, expect } from 'vitest';
import { filterOptions, initialIndex, stepIndex } from '@/components/ui/dropdown-logic';

/**
 * The themed dropdown replaced the native <select> in every card and modal,
 * because macOS draws a native select's popup itself and so ignores the app
 * palette entirely. Replacing a native control means re-earning what it gave
 * for free, and the keyboard is the part that is easiest to ship broken.
 */

const MODELS = [
  { value: 'claude-opus-5', label: 'Opus 5', hint: '1M context - $5/M in' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5', hint: '1M context - $3/M in' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5', hint: '200K context - $1/M in' },
];

describe('filterOptions', () => {
  it('returns everything for an empty or blank query', () => {
    expect(filterOptions(MODELS, '')).toHaveLength(3);
    expect(filterOptions(MODELS, '   ')).toHaveLength(3);
  });

  it('matches the label, case insensitively', () => {
    expect(filterOptions(MODELS, 'OPUS').map(o => o.value)).toEqual(['claude-opus-5']);
  });

  it('matches the hint too, which is where the useful words are', () => {
    // "1M context" is not in any label; without hint matching this finds nothing.
    expect(filterOptions(MODELS, '1M').map(o => o.value))
      .toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(filterOptions(MODELS, '200K').map(o => o.value)).toEqual(['claude-haiku-4-5']);
  });

  it('returns an empty list rather than falling back to everything', () => {
    expect(filterOptions(MODELS, 'gpt')).toEqual([]);
  });

  it('tolerates options with no hint', () => {
    const plain = [{ value: 'a', label: 'Alpha' }];
    expect(filterOptions(plain, 'alpha')).toHaveLength(1);
    expect(filterOptions(plain, 'context')).toHaveLength(0);
  });
});

describe('stepIndex', () => {
  const three = [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }, { value: 'c', label: 'c' }];

  it('moves one row in the asked direction', () => {
    expect(stepIndex(three, 0, 1)).toBe(1);
    expect(stepIndex(three, 2, -1)).toBe(1);
  });

  it('wraps at both ends, the way a native select does', () => {
    expect(stepIndex(three, 2, 1)).toBe(0);
    expect(stepIndex(three, 0, -1)).toBe(2);
  });

  it('starts at the first row when nothing is highlighted yet', () => {
    expect(stepIndex(three, -1, 1)).toBe(0);
  });

  it('steps over a disabled row instead of parking on it', () => {
    const withDisabled = [
      { value: 'a', label: 'a' },
      { value: 'b', label: 'b', disabled: true },
      { value: 'c', label: 'c' },
    ];
    expect(stepIndex(withDisabled, 0, 1)).toBe(2);
    expect(stepIndex(withDisabled, 2, -1)).toBe(0);
  });

  it('gives up rather than looping forever when every row is disabled', () => {
    const allOff = [
      { value: 'a', label: 'a', disabled: true },
      { value: 'b', label: 'b', disabled: true },
    ];
    expect(stepIndex(allOff, 0, 1)).toBe(-1);
  });

  it('has nothing to land on in an empty list', () => {
    expect(stepIndex([], 0, 1)).toBe(-1);
  });
});

describe('initialIndex', () => {
  it('opens on the current value, so arrows move from where the user is', () => {
    expect(initialIndex(MODELS, 'claude-sonnet-5')).toBe(1);
  });

  it('falls back to the first choosable row when the value is not listed', () => {
    // What happens while a filter narrows the list out from under the selection.
    expect(initialIndex(MODELS, 'claude-fable-5')).toBe(0);
  });

  it('skips a disabled first row on that fallback', () => {
    const withDisabled = [
      { value: 'a', label: 'a', disabled: true },
      { value: 'b', label: 'b' },
    ];
    expect(initialIndex(withDisabled, 'nope')).toBe(1);
  });

  it('returns -1 for an empty list', () => {
    expect(initialIndex([], 'anything')).toBe(-1);
  });
});
