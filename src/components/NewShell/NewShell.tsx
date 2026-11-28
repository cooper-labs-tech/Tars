'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useAppPathname } from '@/hooks/useAppPathname';
import NewSidebar from './NewSidebar';
import { PageCard } from './PageCard';
import { MORE_PAGES, type MorePageId } from './more-pages';
import { DataFolderNotice } from '@/components/DataFolderNotice';
import { useStore } from '@/store';

/**
 * The new shell (plan 2.0.0), while Settings, Preferences, "New interface" is
 * on: the sidebar of `Shell · chats · empty`, 240 wide, the page in the main
 * column with the gutters every page is drawn for, and a page of More as a
 * card above it. Going to another page puts the card away.
 */
export default function NewShell({ children }: { children: ReactNode }) {
  const pathname = useAppPathname();
  const [open, setOpen] = useState<MorePageId | null>(null);
  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    setOpen(null);
  }, [pathname]);

  // A page of More asked for from a page (a project's Load agents card opens the Load window at Projects).
  const moreRequest = useStore(s => s.moreRequest);
  useEffect(() => {
    const asked = MORE_PAGES.find(p => p.id === moreRequest?.page);
    if (asked) setOpen(asked.id);
  }, [moreRequest]);

  const page = open ? MORE_PAGES.find(p => p.id === open) : undefined;

  return (
    <>
      {/* The traffic lights' drag strip, the sidebar's width only, as before. */}
      <div className="window-drag fixed top-0 left-0 h-7 w-[240px] z-[60]" />
      <NewSidebar onOpenPage={setOpen} />
      <main className="min-h-screen ml-[240px] px-[26px] pb-[22px] pt-[22px]">
        <DataFolderNotice className="-mx-[26px] -mt-[22px] mb-[22px]" />
        {children}
      </main>
      {page && <PageCard page={page} onClose={close} />}
    </>
  );
}
