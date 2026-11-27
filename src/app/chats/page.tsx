'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { MessageSquare } from 'lucide-react';
import { BrandMark } from '@/components/Brand';
import { LoadingPanel, PageHeader } from '@/components/ui';
import { ChatPage } from '@/components/NewShell/ChatPage';
import { NewChatRecord } from '@/components/NewShell/NewChatRecord';
import { chatShown } from '@/lib/chat-sections';
import { useChats } from '@/hooks/useChats';

/**
 * The chats page of the new shell. `?new=1`: a new chat's record. `?chat=`: that
 * chat, opened. Neither: the first chat of the list opened, or, with none at
 * all, the state `Shell · chats · empty` draws. No chat is made up. A chat opens
 * on its page: its conversation, or, for a new chat, its first message, which
 * starts its runner (PR D).
 */
export default function ChatsPage() {
  return (
    <Suspense>
      <ChatsPageInner />
    </Suspense>
  );
}

function ChatsPageInner() {
  const params = useSearchParams();
  const { chats, at } = useChats();

  if (params.get('new') === '1') return <NewChatRecord initialProject={params.get('project')} />;
  if (chats === null) return <LoadingPanel what="Reading the chats" />;

  const open = chatShown(chats, params.get('chat'), at);
  if (open) return <ChatPage key={open.id} chat={open} />;

  return (
    <div className="h-[calc(100vh-44px)] flex flex-col">
      <PageHeader title="Chats" subtitle="A conversation with the orchestrator of a project, on one topic." />
      <div className="flex-1 min-h-0 border border-border bg-card flex flex-col items-center justify-center gap-3 pb-[60px]">
        <BrandMark className="w-2.5 h-2.5" />
        <h2 className="font-serif text-[22px] leading-[1.15] text-foreground">No chats yet</h2>
        <p className="max-w-[460px] text-center text-[12.5px] leading-[1.5] text-text-secondary">
          A project gets its chat Main once it has an orchestrator. Meanwhile, talk to Tars, all projects.
        </p>
        <Link
          href="/chat"
          className="inline-flex items-center gap-2 h-8 px-3 border border-border bg-card text-sm text-foreground hover:bg-secondary transition-colors"
        >
          <MessageSquare className="w-3.5 h-3.5 text-status-idle" />
          Open Tars, all projects
        </Link>
      </div>
    </div>
  );
}
