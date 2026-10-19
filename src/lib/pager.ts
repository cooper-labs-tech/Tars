/**
 * The pager of Usage's three tables: AGENTS, AVERAGE PER AGENT and AVERAGE PER MODEL (2.0.4, the maintainer's request
 * of 18/10). Frames: `Usage · pages · five rows a card`, `· states`, `· narrowest window`, and the rules in `· notes`.
 * Pure, so the tables draw it and the tests read it.
 */

/**
 * Rows a page. Five keeps the three tables short, the averages beside each other in one screen; ten holds a team (the
 * Full engineering team template makes six agents, with room for an orchestrator and helpers); twenty-five half of a
 * fleet of fifty, this Mac's on 18/10, in two pages; fifty that fleet in one.
 */
export const ROWS_CHOICES = [5, 10, 25, 50] as const;
export const DEFAULT_ROWS = 5;

/** Where each card keeps its choice in the window's storage: one each, never shared. */
export const ROWS_KEYS = {
  agents: 'usage.rows.agents',
  perAgent: 'usage.rows.perAgent',
  perModel: 'usage.rows.perModel',
} as const;

/** A remembered choice, read back: one of the four, or five for anything else. */
export function rowsOf(stored: string | null | undefined): number {
  const n = Number(stored);
  return typeof stored === 'string' && /^\d+$/.test(stored) && (ROWS_CHOICES as readonly number[]).includes(n) ? n : DEFAULT_ROWS;
}

/** How many pages `total` rows make at `size` a page: one at least, an empty table's. */
export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}

/** A page kept inside the pages there are: the last for one past it, the first for one before it or not a number. */
export function pageOf(page: number, total: number, size: number): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(1, Math.floor(page)), pageCount(total, size));
}

/** The rows of a page, the page kept inside the pages there are. */
export function pageRows<T>(rows: readonly T[], page: number, size: number): T[] {
  const p = pageOf(page, rows.length, size);
  return rows.slice((p - 1) * size, p * size);
}

/**
 * The page buttons: every page up to seven; past seven, the first, the last, the page shown and its two neighbours,
 * with a gap where pages are skipped.
 */
export function pageButtons(page: number, last: number): Array<number | 'gap'> {
  if (last <= 7) return Array.from({ length: last }, (_, i) => i + 1);
  const shown = [...new Set([1, page - 1, page, page + 1, last])].filter((p) => p >= 1 && p <= last).sort((a, b) => a - b);
  const out: Array<number | 'gap'> = [];
  for (const p of shown) {
    const before = out[out.length - 1];
    if (typeof before === 'number' && p - before > 1) out.push('gap');
    out.push(p);
  }
  return out;
}

/** Which rows show, and of how many: "6 to 10 of 23", "6 of 6" for a page of one, "all 7" when one page holds them. */
export function rangeText(page: number, size: number, total: number): string {
  if (total === 0) return '';
  if (total <= size) return `all ${total}`;
  const p = pageOf(page, total, size);
  const from = (p - 1) * size + 1;
  const to = Math.min(p * size, total);
  return from === to ? `${to} of ${total}` : `${from} to ${to} of ${total}`;
}

/** A pager shows over five rows: at five or fewer, no choice changes what shows. */
export function pagerShown(total: number): boolean {
  return total > DEFAULT_ROWS;
}

/** The page buttons show when the rows do not fit one page at the size chosen. */
export function pagesShown(total: number, size: number): boolean {
  return total > size;
}
