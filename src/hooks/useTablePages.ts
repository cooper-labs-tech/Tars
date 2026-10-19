'use client';

import { useEffect, useState } from 'react';
import { DEFAULT_ROWS, pageCount, pageOf, rowsOf } from '@/lib/pager';

/**
 * A table's page and its rows a page (Usage's three tables, `Usage · pages · notes`). The rows choice is remembered
 * under `storageKey`, read once mounted, since there is no storage when the page is built. The page goes back to 1
 * when `resetKey` (the list: its timeframe, project or sort) or the rows choice changes, and stays, inside the pages
 * there are, when only the figures do.
 */
export function useTablePages(storageKey: string, resetKey: string, total: number) {
  const [size, setSize] = useState(DEFAULT_ROWS);
  useEffect(() => {
    try { setSize(rowsOf(window.localStorage.getItem(storageKey))); } catch { /* storage refused: five */ }
  }, [storageKey]);
  const key = `${resetKey}|${size}`;
  const [at, setAt] = useState({ key, page: 1 });
  const page = pageOf(at.key === key ? at.page : 1, total, size);
  return {
    size,
    page,
    last: pageCount(total, size),
    pickSize: (rows: number) => {
      setSize(rows);
      try { window.localStorage.setItem(storageKey, String(rows)); } catch { /* held while the page is open */ }
    },
    goTo: (next: number) => setAt({ key, page: next }),
  };
}
