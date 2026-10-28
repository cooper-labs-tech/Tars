'use client';

import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';
import { Archive, BarChart2, Bot, Brain, FileDiff, Gauge, Gift, Puzzle, ScrollText, Settings } from 'lucide-react';
import { LoadingPanel } from '@/components/ui';

const loading = () => <LoadingPanel what="Opening the page" />;

export type MorePageId = 'agents' | 'review' | 'logs' | 'vault' | 'extensions' | 'usage' | 'resources' | 'brain' | 'settings' | 'whats-new';

export interface MorePage {
  id: MorePageId;
  label: string;
  icon: ComponentType<{ className?: string }>;
  /** The page itself, the one its own route shows, loaded when its card first opens. */
  Page: ComponentType;
}

/**
 * The pages of More, in the order of `Shell · chats · More open`. Each opens as
 * a card above the app; Settings starts a group of its own, after a rule.
 */
export const MORE_PAGES: MorePage[] = [
  { id: 'agents', label: 'Agents', icon: Bot, Page: dynamic(() => import('@/app/agents/page'), { ssr: false, loading }) },
  { id: 'review', label: 'Review', icon: FileDiff, Page: dynamic(() => import('@/app/review/page'), { ssr: false, loading }) },
  { id: 'logs', label: 'Logs', icon: ScrollText, Page: dynamic(() => import('@/app/logs/page'), { ssr: false, loading }) },
  { id: 'vault', label: 'Vault', icon: Archive, Page: dynamic(() => import('@/app/vault/page'), { ssr: false, loading }) },
  { id: 'extensions', label: 'Extensions', icon: Puzzle, Page: dynamic(() => import('@/app/skills/page'), { ssr: false, loading }) },
  { id: 'usage', label: 'Usage', icon: BarChart2, Page: dynamic(() => import('@/app/usage/page'), { ssr: false, loading }) },
  { id: 'resources', label: 'Resources', icon: Gauge, Page: dynamic(() => import('@/app/resources/page'), { ssr: false, loading }) },
  { id: 'brain', label: 'Brain', icon: Brain, Page: dynamic(() => import('@/app/memory/page'), { ssr: false, loading }) },
  { id: 'settings', label: 'Settings', icon: Settings, Page: dynamic(() => import('@/app/settings/page'), { ssr: false, loading }) },
  { id: 'whats-new', label: "What's New", icon: Gift, Page: dynamic(() => import('@/app/whats-new/page'), { ssr: false, loading }) },
];
