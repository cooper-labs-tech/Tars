'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './Button';
import { Dropdown } from './Dropdown';

/**
 * A table's pager, under it: how many rows a page holds, which rows show and of how many, and the pages, the one
 * shown a box. Frames `Usage · pages · five rows a card`, `· states` and `· narrowest window`. Its words and pages come
 * from the caller (src/lib/pager.ts); this only draws them. Narrower than 520 px it says previous, the page shown of
 * how many, next, as the narrowest window draws the averages.
 */
export function Pager({
  label,
  rows,
  choices,
  onRows,
  range,
  page,
  last,
  pages,
  onPage,
}: {
  /** The card's name: "Agents" names the pager "Agents pages" and its menu "Agents rows per page". */
  label: string;
  rows: number;
  choices: readonly number[];
  onRows: (rows: number) => void;
  /** "6 to 10 of 23", or "all 7" when one page holds every row. */
  range: string;
  page: number;
  last: number;
  /** The page buttons, gaps included, or none when one page holds every row. */
  pages: Array<number | 'gap'>;
  onPage: (page: number) => void;
}) {
  return (
    <nav aria-label={`${label} pages`} className="@container">
      <div className="flex items-center gap-1.5 min-w-0">
        <Dropdown
          size="sm"
          className="w-24 shrink-0"
          value={String(rows)}
          options={choices.map(n => ({ value: String(n), label: `${n} rows` }))}
          onChange={value => onRows(Number(value))}
          ariaLabel={`${label} rows per page`}
        />
        <span className="flex-1" />
        {range && (
          <span className={`${pages.length > 0 ? 'hidden @min-[520px]:inline' : ''} mr-1 font-mono text-[10.5px] text-muted-foreground whitespace-nowrap`}>
            {range}
          </span>
        )}
        {pages.length > 0 && (
          <>
            <Button size="icon" className="shrink-0" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}>
              <ChevronLeft className="w-3 h-3" />
            </Button>
            <span className="hidden @min-[520px]:contents">
              {pages.map((p, i) => (p === 'gap'
                ? <span key={`gap-${i}`} aria-hidden="true" className="w-3.5 text-center font-mono text-[11px] text-muted-foreground">…</span>
                : (
                  <Button
                    key={p}
                    size="icon"
                    active={p === page}
                    aria-current={p === page ? 'page' : undefined}
                    aria-label={`Page ${p}`}
                    className="shrink-0 font-mono"
                    onClick={() => onPage(p)}
                  >
                    {p}
                  </Button>
                )))}
            </span>
            <span className="@min-[520px]:hidden px-1 font-mono text-[11px] text-text-secondary whitespace-nowrap">{`${page} / ${last}`}</span>
            <Button size="icon" className="shrink-0" aria-label="Next page" disabled={page >= last} onClick={() => onPage(page + 1)}>
              <ChevronRight className="w-3 h-3" />
            </Button>
          </>
        )}
      </div>
    </nav>
  );
}
