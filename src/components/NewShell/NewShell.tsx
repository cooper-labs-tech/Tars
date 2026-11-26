'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useAppPathname } from '@/hooks/useAppPathname';
import NewSidebar from './NewSidebar';
import { PageCard } from './PageCard';
import { MORE_PAGES, type MorePageId } from './more-pages';
import { DataFolderNotice } from '@/components/DataFolderNotice';
import { WindowsCaption } from '@/components/WindowsCaption';
import { pageShortcutDigit, rendererPlatform } from '@/lib/terminal-keys';

/**
 * Cmd and a digit (Ctrl on Windows, pageShortcutDigit), the digits the classic sidebar gave each page: a page of
 * the main menu is navigated to, a page of More opens as its card above the page, which does not move.
 */
const SHORTCUTS: Record<string, { href: string } | { card: MorePageId }> = {
  '1': { href: '/' },
  '2': { card: 'agents' },
  '3': { href: '/kanban' },
  '4': { href: '/crons' },
  '5': { card: 'review' },
  '6': { card: 'logs' },
  '7': { card: 'vault' },
  '8': { href: '/projects' },
  '9': { card: 'extensions' },
  '0': { card: 'usage' },
};

/**
 * The shell, the only one since 2.1.0 (JeanBrasse, 26/11): the sidebar of `Shell · chats · empty`, 240 wide, the
 * page in the main column with the gutters every page is drawn for (`Shell · <page>`), and a page of More as a card
 * above it (`Shell · <page> card`). Going to another page puts the card away. On Windows, WindowsCaption draws the
 * caption band over it (`Shell · Windows caption`).
 */
export default function NewShell({ children }: { children: ReactNode }) {
  const pathname = useAppPathname();
  const router = useRouter();
  const [open, setOpen] = useState<MorePageId | null>(null);
  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    setOpen(null);
  }, [pathname]);

  useEffect(() => {
    // Windows: Ctrl and a digit from anywhere but a text field, a terminal included (its panels moved to Alt and a
    // digit). See pageShortcutDigit.
    const platform = rendererPlatform();
    const onKey = (e: KeyboardEvent) => {
      const digit = pageShortcutDigit(e, platform, e.target as HTMLElement | null);
      const to = digit === null ? undefined : SHORTCUTS[digit];
      if (!to) return;
      e.preventDefault();
      if ('card' in to) setOpen(to.card);
      else { setOpen(null); router.push(to.href); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  const page = open ? MORE_PAGES.find(p => p.id === open) : undefined;

  return (
    <>
      {/* The traffic lights' drag strip, the sidebar's width only. */}
      <div className="window-drag fixed top-0 left-0 h-7 w-[240px] z-[60]" />
      <WindowsCaption />
      <NewSidebar onOpenPage={setOpen} />
      <main className="min-h-screen ml-[240px] px-[26px] pb-[22px] pt-[22px]">
        <DataFolderNotice className="-mx-[26px] -mt-[22px] mb-[22px]" />
        {children}
      </main>
      {page && <PageCard page={page} onClose={close} />}
    </>
  );
}
