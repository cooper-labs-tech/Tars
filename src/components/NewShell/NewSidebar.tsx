'use client';

import { Fragment, Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowDownToLine, CalendarClock, ChevronDown, ChevronUp, Columns, Ellipsis, FolderKanban,
  LayoutDashboard, MessageSquare, Plus,
} from 'lucide-react';
import { ChatList } from './ChatList';
import { Brand, BrandMark } from '@/components/Brand';
import { Button } from '@/components/ui';
import { useWhatsNewBadge } from '@/hooks/useWhatsNewBadge';
import { useAppPathname } from '@/hooks/useAppPathname';
import { useElectronAgents } from '@/hooks/useElectron';
import { shellPlaceFor, type ShellPlace } from '@/lib/new-shell';
import { useStore } from '@/store';
import { MORE_PAGES, type MorePageId } from './more-pages';
import { hoverEnd, hoverStart } from '@/lib/prefetch-on-hover';

/** The route each page of More shows, for what prefetch-on-hover starts reading while the pointer rests on it. */
const ROUTE_OF: Record<MorePageId, string> = {
  agents: '/agents', review: '/review', logs: '/logs', vault: '/vault', extensions: '/skills', usage: '/usage',
  resources: '/resources', brain: '/memory', settings: '/settings', 'whats-new': '/whats-new',
};

/** The main menu of `Shell · chats · empty`: Chat and Projects, then the three pages kept for now. */
const MAIN: Array<{ place: ShellPlace; href: string; label: string; icon: typeof MessageSquare }> = [
  { place: 'chat', href: '/chats', label: 'Chat', icon: MessageSquare },
  { place: 'projects', href: '/projects', label: 'Projects', icon: FolderKanban },
  { place: 'dashboard', href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { place: 'kanban', href: '/kanban', label: 'Kanban', icon: Columns },
  { place: 'schedules', href: '/crons', label: 'Schedules', icon: CalendarClock },
];

// The current entry is a box, tinted, with the accent edge the frames draw.
const rowClass = (current: boolean) =>
  `flex items-center gap-[10px] h-8 px-2.5 border transition-colors ${
    current ? 'bg-accent-dim border-primary' : 'border-transparent hover:bg-secondary'
  }`;
const iconClass = (current: boolean) => `w-3.5 h-3.5 shrink-0 ${current ? 'text-primary' : 'text-status-idle'}`;
const labelClass = (current: boolean) => `text-[13px] flex-1 truncate text-left ${current ? 'text-foreground' : 'text-text-secondary'}`;

/** Where the sidebar keeps its project filter, for this window only. */
const FILTER_KEY = 'tars-chats-filter';

function readFilter(): string | null {
  try {
    return localStorage.getItem(FILTER_KEY) || null;
  } catch {
    return null;
  }
}

/** The chat list, with the chat the page shows as its current row. */
function ListOfChats({ filter, onFilter }: { filter: string | null; onFilter: (path: string | null) => void }) {
  const selectedId = useSearchParams().get('chat');
  return <ChatList filter={filter} onFilter={onFilter} selectedId={selectedId} />;
}

/**
 * The new shell's sidebar (`Shell · chats · empty`, `· More open`, `· list, a
 * chat open`). The chats are their records (#361): the list, its project
 * filter, New chat making a chat's record. Nothing is made up of what a chat
 * says: that comes with PR D and E.
 */
export default function NewSidebar({ onOpenPage }: { onOpenPage: (id: MorePageId) => void }) {
  const place = shellPlaceFor(useAppPathname());
  const whatsNewHasNew = useWhatsNewBadge();
  const { vaultUnreadCount, pendingUpdateVersion, setUpdateBannerDismissed } = useStore();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreArea = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const [filter, setFilter] = useState<string | null>(null);
  useEffect(() => setFilter(readFilter()), []);
  const chooseFilter = (path: string | null) => {
    setFilter(path);
    try {
      if (path) localStorage.setItem(FILTER_KEY, path);
      else localStorage.removeItem(FILTER_KEY);
    } catch { /* storage blocked: the filter lasts the page */ }
    // On a project's page, the filter chooses the project.
    if (path && place === 'projects') router.push(`/project?path=${encodeURIComponent(path)}`);
  };
  // A chat is with a project's orchestrator: with none in any project, New chat has nothing to make (Shell · chats · empty draws it dimmed).
  const { agents } = useElectronAgents();
  const canMakeChat = agents.some(agent => agent.role === 'orchestrator' && !!agent.projectPath);
  const hrefOf = (item: (typeof MAIN)[number]) =>
    item.place === 'projects' && filter ? `/project?path=${encodeURIComponent(filter)}` : item.href;

  // A click anywhere else, or Escape, puts the menu away.
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!moreArea.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  const tarsCurrent = place === 'tars';

  return (
    <aside aria-label="Sidebar" className="fixed left-0 top-0 h-screen w-[240px] bg-card border-r border-border flex flex-col z-50">
      <div className="window-drag flex items-center h-[54px] px-[18px] shrink-0">
        <Brand
          markClassName="w-[13px] h-[13px]"
          wordmarkClassName="font-serif text-xl text-foreground"
          markSlotClassName="w-3.5"
          gapClassName="gap-[10px]"
        />
      </div>

      <nav aria-label="Main menu" className="px-2 pt-1 pb-1 space-y-px shrink-0">
        {MAIN.map((item, index) => {
          const current = place === item.place;
          return (
            <Fragment key={item.href}>
              {index === 2 && (
                <div aria-hidden className="px-2.5 py-1">
                  <div className="h-px bg-border" />
                </div>
              )}
              <Link href={hrefOf(item)} aria-current={current ? 'page' : undefined} className={rowClass(current)}
                onPointerEnter={() => hoverStart(item.href)} onPointerLeave={hoverEnd}>
                <item.icon className={iconClass(current)} />
                <span className={labelClass(current)}>{item.label}</span>
              </Link>
            </Fragment>
          );
        })}
      </nav>

      <div className="px-2 pt-2 pb-0.5 shrink-0">
        <Button
          className="w-full"
          disabled={!canMakeChat}
          title={canMakeChat ? undefined : 'A chat is with the orchestrator of a project, and no project has one yet.'}
          onClick={() => router.push(`/chats?new=1${filter ? `&project=${encodeURIComponent(filter)}` : ''}`)}
        >
          <Plus className="w-3.5 h-3.5" />
          New chat
        </Button>
      </div>

      <div className="px-2 pt-2 shrink-0">
        <Link
          href="/chat"
          aria-label="Tars, all projects"
          aria-current={tarsCurrent ? 'page' : undefined}
          className={`flex items-center gap-[10px] px-2.5 py-[7px] border transition-colors ${
            tarsCurrent ? 'bg-accent-dim border-primary' : 'bg-secondary border-border hover:border-border-accent'
          }`}
        >
          <BrandMark className="w-2.5 h-2.5 shrink-0" />
          <span className="min-w-0 flex flex-col">
            <span className="text-[12.5px] leading-[1.4] font-semibold text-foreground">Tars</span>
            <span className="font-mono text-[10.5px] leading-[1.35] text-status-idle">all projects</span>
          </span>
        </Link>
      </div>

      {/* The list takes the height left, and scrolls in it; without one, it is the gap above the foot. */}
      <div className="flex-1 min-h-0 flex flex-col">
        <Suspense fallback={null}>
          <ListOfChats filter={filter} onFilter={chooseFilter} />
        </Suspense>
      </div>

      {/* Only while there is one to install, as in the sidebar before. */}
      {pendingUpdateVersion && (
        <div className="px-2 pb-1 shrink-0">
          <button
            onClick={() => setUpdateBannerDismissed(false)}
            title={`Update to ${pendingUpdateVersion}`}
            className={`w-full ${rowClass(false)} bg-primary/10 border-primary/30`}
          >
            <ArrowDownToLine className="w-[13px] h-[13px] shrink-0 text-primary" />
            <span className="text-[13px] text-primary truncate">Update to {pendingUpdateVersion}</span>
          </button>
        </div>
      )}

      <div ref={moreArea} className="relative px-2 pt-2 pb-0.5 border-t border-border shrink-0">
        {moreOpen && (
          <div
            role="menu"
            aria-label="More"
            className="absolute left-2 bottom-full mb-1.5 w-[224px] p-1 bg-secondary border border-border-accent flex flex-col gap-px"
          >
            {MORE_PAGES.map(page => (
              <Fragment key={page.id}>
                {page.id === 'settings' && (
                  <div aria-hidden className="px-2.5 py-1">
                    <div className="h-px bg-border" />
                  </div>
                )}
                <button
                  type="button"
                  role="menuitem"
                  onPointerEnter={() => hoverStart(ROUTE_OF[page.id])}
                  onPointerLeave={hoverEnd}
                  onClick={() => {
                    setMoreOpen(false);
                    onOpenPage(page.id);
                  }}
                  className="flex items-center gap-[10px] h-8 px-2.5 border border-transparent hover:bg-card transition-colors"
                >
                  <page.icon className={iconClass(false)} />
                  <span className={labelClass(false)}>{page.label}</span>
                  {page.id === 'vault' && vaultUnreadCount > 0 && (
                    <span className="font-mono text-[10.5px] text-status-idle">{vaultUnreadCount}</span>
                  )}
                  {page.id === 'whats-new' && whatsNewHasNew && <span aria-hidden className="w-1.5 h-1.5 bg-primary shrink-0" />}
                </button>
              </Fragment>
            ))}
          </div>
        )}
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(open => !open)}
          className={`w-full flex items-center gap-[10px] h-8 px-2.5 border transition-colors ${
            moreOpen ? 'bg-secondary border-border-accent' : 'border-transparent hover:bg-secondary'
          }`}
        >
          <Ellipsis className={`w-3.5 h-3.5 shrink-0 ${moreOpen ? 'text-foreground' : 'text-status-idle'}`} />
          <span className={`text-[13px] flex-1 text-left ${moreOpen ? 'text-foreground' : 'text-text-secondary'}`}>More</span>
          {whatsNewHasNew && <span aria-hidden className="w-1.5 h-1.5 bg-primary shrink-0" />}
          {moreOpen ? <ChevronDown className="w-3 h-3 text-status-idle" /> : <ChevronUp className="w-3 h-3 text-status-idle" />}
        </button>
      </div>

      <div className="flex items-center gap-2 pl-[18px] pt-3 pb-[14px] shrink-0">
        <span className="w-1.5 h-1.5 bg-status-running shrink-0" />
        <span className="font-mono text-[11px] text-status-idle">Connected</span>
      </div>
    </aside>
  );
}
