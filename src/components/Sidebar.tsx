'use client';

import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard,
  FolderKanban,
  Puzzle,
  Settings,
  Bot,
  BarChart2,
  Columns,
  CalendarClock,
  FileDiff,
  ScrollText,
  Moon,
  Sun,
  Archive,
  Brain,
  Gift,
  MessageSquare,
  ArrowDownToLine,
  Gauge,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { LATEST_RELEASE, WHATS_NEW_STORAGE_KEY } from '@/data/changelog';

import { useStore } from '@/store';
import Link from 'next/link';
import { Brand } from '@/components/Brand';
import { usePathname, useRouter } from 'next/navigation';
import { useAppPathname, normalisePathname } from '@/hooks/useAppPathname';
import { pageShortcutDigit, rendererPlatform } from '@/lib/terminal-keys';
import { hoverEnd, hoverStart } from '@/lib/prefetch-on-hover';

const navItems = [
  { href: '/', icon: LayoutDashboard, label: 'Dashboard', shortcut: '1' },
  // No digit is free (1-9 and 0 are all already spoken for below), so Chat
  // ships without one, the same as Brain - a shortcut that stole one from an
  // existing page would be a worse regression than Chat launching without one.
  { href: '/chat', icon: MessageSquare, label: 'Chat' },
  { href: '/agents', icon: Bot, label: 'Agents', shortcut: '2' },
  { href: '/kanban', icon: Columns, label: 'Kanban', shortcut: '3' },
  { href: '/crons', icon: CalendarClock, label: 'Schedules', shortcut: '4' },
  { href: '/review', icon: FileDiff, label: 'Review', shortcut: '5' },
  { href: '/logs', icon: ScrollText, label: 'Logs', shortcut: '6' },
  { href: '/vault', icon: Archive, label: 'Vault', shortcut: '7' },
  { href: '/projects', icon: FolderKanban, label: 'Projects', shortcut: '8' },
  { href: '/skills', icon: Puzzle, label: 'Extensions', shortcut: '9' },
  { href: '/usage', icon: BarChart2, label: 'Usage', shortcut: '0' },
  { href: '/resources', icon: Gauge, label: 'Resources' },
  { href: '/memory', icon: Brain, label: 'Brain' },
];

/**
 * Every row in the column is the same 32px box on the same inset: the nav's
 * px-2 plus the row's px-2.5 puts the icon slot at x=18 and, after a 10px gap,
 * the label at x=42 - the same two columns the brand row uses.
 * Active is a filled box, never a rule and never an inverted fill.
 */
/**
 * Whether a nav entry is the page on screen.
 *
 * Dashboard is `/`, which is a prefix of everything, so it only ever matches
 * exactly. The rest match themselves and anything under them, and both sides
 * are normalised because the static export renders hrefs with a trailing slash
 * that the entries here do not have.
 */
function isNavActive(pathname: string, href: string): boolean {
  const here = normalisePathname(pathname);
  const target = normalisePathname(href);
  if (target === '/') return here === '/';
  return here === target || here.startsWith(`${target}/`);
}

const rowClass = (isActive: boolean) =>
  `flex items-center gap-[10px] h-8 px-2.5 transition-colors cursor-pointer ${
    isActive ? 'bg-accent-dim' : 'hover:bg-secondary'
  }`;
const iconClass = (isActive: boolean) =>
  `w-3.5 h-3.5 shrink-0 ${isActive ? 'text-primary' : 'text-status-idle'}`;
const labelClass = (isActive: boolean) =>
  `text-sm flex-1 truncate ${isActive ? 'text-foreground' : 'text-text-secondary'}`;
const badgeClass = 'min-w-[16px] h-4 flex items-center justify-center px-1 text-[9px] font-medium';

interface SidebarProps {
  isMobile?: boolean;
}

/** Whether What's New has a release the person has not opened yet. The new shell's More reads it too. */
export function useWhatsNewBadge() {
  const [hasNew, setHasNew] = useState(false);

  useEffect(() => {
    const check = () => {
      const lastSeen = Number(localStorage.getItem(WHATS_NEW_STORAGE_KEY) || '0');
      setHasNew(LATEST_RELEASE.id > lastSeen);
    };
    check();
    window.addEventListener('whats-new-seen', check);
    return () => window.removeEventListener('whats-new-seen', check);
  }, []);

  return hasNew;
}

/**
 * Cmd/Ctrl + digit jumps to a page (Ctrl on Windows). The shortcuts were
 * declared next to each nav item and bound to nothing, so they were decoration
 * until now.
 */
function useNavShortcuts() {
  const router = useRouter();

  useEffect(() => {
    // Windows: Ctrl+digit from anywhere but a text field, a terminal included
    // (its panels moved to Alt+digit). See pageShortcutDigit.
    const platform = rendererPlatform();
    const onKey = (e: KeyboardEvent) => {
      const digit = pageShortcutDigit(e, platform, e.target as HTMLElement | null);
      if (digit === null) return;

      const item = navItems.find(nav => nav.shortcut && nav.shortcut === digit);
      if (!item) return;
      e.preventDefault();
      router.push(item.href);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);
}

export default function Sidebar({ isMobile = false }: SidebarProps) {
  const pathname = useAppPathname();
  useNavShortcuts();
  const {
    mobileMenuOpen, setMobileMenuOpen, darkMode, toggleDarkMode, vaultUnreadCount,
    pendingUpdateVersion, setUpdateBannerDismissed,
  } = useStore();
  const whatsNewHasNew = useWhatsNewBadge();

  // Matches --sidebar-w; ClientLayout offsets the content by the same number.
  const sidebarWidth = 216;

  // Close mobile menu when navigating
  const handleNavClick = () => {
    if (isMobile) {
      setMobileMenuOpen(false);
    }
  };

  const isSettingsActive = isNavActive(pathname, '/settings');
  const isWhatsNewActive = isNavActive(pathname, '/whats-new');

  // The column is one uniform surface - the only border is its right edge.
  const connectedLine = (
    <div className="flex items-center gap-2 pl-[18px] pt-3 pb-[14px] shrink-0">
      <span className="w-1.5 h-1.5 bg-status-running shrink-0" />
      <span className="font-mono text-[11px] text-status-idle">Connected</span>
    </div>
  );

  // Desktop sidebar
  if (!isMobile) {
    return (
      <motion.aside
        initial={false}
        animate={{ width: sidebarWidth }}
        transition={{ duration: 0.2, ease: 'easeInOut' }}
        className="fixed left-0 top-0 h-screen bg-card border-r border-border flex-col z-50 hidden lg:flex"
      >
        {/* Logo - top area also serves as drag region for macOS traffic lights.
            54px tall so the first nav row starts at y=54; the 18px inset and the
            14px mark slot line the mark up with the nav icons and the wordmark
            with the nav labels. */}
        <div className="window-drag flex items-center h-[54px] px-[18px] shrink-0">
          <Brand
            markClassName="w-[13px] h-[13px]"
            wordmarkClassName="font-serif text-xl text-foreground"
            markSlotClassName="w-3.5"
            gapClassName="gap-[10px]"
          />
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-2 pb-2 space-y-px overflow-y-auto">
          {navItems.map((item) => {
            const isActive = isNavActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={rowClass(isActive)}
                onPointerEnter={() => hoverStart(item.href)}
                onPointerLeave={hoverEnd}
              >
                <item.icon className={iconClass(isActive)} />
                <span className={labelClass(isActive)}>{item.label}</span>
                {item.href === '/vault' && vaultUnreadCount > 0 && (
                  <span className={`${badgeClass} bg-primary text-primary-foreground`}>
                    {vaultUnreadCount}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* What's New, Settings and the theme toggle ride the same rhythm as the
            nav rows; the nav's flex-1 pins them to the bottom. */}
        <div className="px-2 space-y-px shrink-0">
          {/* Only while there is one to install. The update panel is
              dismissible, and dismissing it used to be the end of it until the
              next launch; this is the way back, and the only permanent sign
              that the app is behind. */}
          {pendingUpdateVersion && (
            <button
              onClick={() => setUpdateBannerDismissed(false)}
              title={`Update to ${pendingUpdateVersion}`}
              className={`w-full ${rowClass(false)} bg-primary/10 border border-primary/30`}
            >
              <ArrowDownToLine className="w-[13px] h-[13px] shrink-0 text-primary" />
              <span className="text-[13px] text-primary truncate">
                Update to {pendingUpdateVersion}
              </span>
            </button>
          )}

          <Link href="/whats-new" className={rowClass(isWhatsNewActive)}>
            <div className="relative shrink-0">
              <Gift className={iconClass(isWhatsNewActive)} />
              {whatsNewHasNew && (
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-danger rounded-full" />
              )}
            </div>
            <span className={labelClass(isWhatsNewActive)}>What&apos;s New</span>
            {whatsNewHasNew && (
              <span className={`${badgeClass} bg-danger text-background`}>1</span>
            )}
          </Link>

          <Link
            href="/settings"
            className={rowClass(isSettingsActive)}
            onPointerEnter={() => hoverStart('/settings')}
            onPointerLeave={hoverEnd}
          >
            <Settings className={iconClass(isSettingsActive)} />
            <span className={labelClass(isSettingsActive)}>Settings</span>
          </Link>

          <button onClick={toggleDarkMode} className={`w-full ${rowClass(false)}`}>
            {darkMode ? <Sun className={iconClass(false)} /> : <Moon className={iconClass(false)} />}
            <span className={`${labelClass(false)} text-left`}>
              {darkMode ? 'Light Mode' : 'Dark Mode'}
            </span>
          </button>
        </div>

        {connectedLine}
      </motion.aside>
    );
  }

  // Mobile sidebar (drawer)
  return (
    <AnimatePresence>
      {mobileMenuOpen && (
        <motion.aside
          initial={{ x: -sidebarWidth }}
          animate={{ x: 0 }}
          exit={{ x: -sidebarWidth }}
          transition={{ duration: 0.2, ease: 'easeInOut' }}
          className="fixed left-0 top-0 h-screen bg-card border-r border-border flex flex-col z-50 lg:hidden"
          style={{ width: sidebarWidth }}
        >
          {/* Logo */}
          <div className="flex items-center h-[54px] px-[18px] shrink-0">
            <Brand
              markClassName="w-[13px] h-[13px]"
              wordmarkClassName="font-serif text-xl text-foreground"
              markSlotClassName="w-3.5"
              gapClassName="gap-[10px]"
            />
          </div>

          {/* Navigation */}
          <nav className="flex-1 px-2 pb-2 space-y-px overflow-y-auto">
            {navItems.map((item) => {
              const isActive = isNavActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={handleNavClick}
                  className={rowClass(isActive)}
                >
                  <item.icon className={iconClass(isActive)} />
                  <span className={labelClass(isActive)}>{item.label}</span>
                  {item.href === '/vault' && vaultUnreadCount > 0 && (
                    <span className={`${badgeClass} bg-primary text-primary-foreground`}>
                      {vaultUnreadCount}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          <div className="px-2 space-y-px shrink-0">
            <Link
              href="/whats-new"
              onClick={handleNavClick}
              className={rowClass(isWhatsNewActive)}
            >
              <div className="relative shrink-0">
                <Gift className={iconClass(isWhatsNewActive)} />
                {whatsNewHasNew && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 bg-danger rounded-full" />
                )}
              </div>
              <span className={labelClass(isWhatsNewActive)}>What&apos;s New</span>
              {whatsNewHasNew && (
                <span className={`${badgeClass} bg-danger text-background`}>1</span>
              )}
            </Link>

            <Link
              href="/settings"
              onClick={handleNavClick}
              className={rowClass(isSettingsActive)}
            >
              <Settings className={iconClass(isSettingsActive)} />
              <span className={labelClass(isSettingsActive)}>Settings</span>
            </Link>

            <button onClick={toggleDarkMode} className={`w-full ${rowClass(false)}`}>
              {darkMode ? <Sun className={iconClass(false)} /> : <Moon className={iconClass(false)} />}
              <span className={`${labelClass(false)} text-left`}>
                {darkMode ? 'Light Mode' : 'Dark Mode'}
              </span>
            </button>
          </div>

          {connectedLine}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
