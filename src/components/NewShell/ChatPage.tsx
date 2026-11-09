'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ArrowUp, Square } from 'lucide-react';
import { BrandMark } from '@/components/Brand';
import AgentTerminalDialog from '@/components/AgentWorld/AgentTerminalDialog';
import PermissionAskNotice from '@/components/PermissionAskNotice';
import { RichText } from '@/components/Overseer/RichText';
import { Button, ComposerCard, PanelCaption, StatusSquare } from '@/components/ui';
import { useElectronAgents } from '@/hooks/useElectron';
import { useChatFeed } from '@/hooks/useChatFeed';
import { projectNameOf, refreshChats, useChats } from '@/hooks/useChats';
import { forgetSentOutcome, sendComposer, useChatComposer, writeComposer } from '@/hooks/useChatComposer';
import { stripOf, type SendOutcome } from '@/lib/chat-send';
import type { AgentStatus, ChatItem, ChatView } from '@/types/electron';
import { ChatHead, clockOf } from './chat-bits';

/**
 * A chat's page, its conversation read from its runner's transcripts and
 * followed live (src/hooks/useChatFeed.ts). Frames: `Chat · chats · from its
 * transcripts, working`, `· waiting on you`, `· a new chat, its first message`,
 * `· the composer, sending` and `· every slot working`, in chat-redesign-a.pen.
 * Each line is shown as what it is, the lines of one speaker under one head;
 * the runner in a turn says so at the end of the thread, and its permission
 * ask sits above the composer, the one its window shows. The composer sends
 * through chat:send (PR D): a runner that runs has the words typed into it, one
 * that does not is started with them, and a new chat's first message makes its
 * runner and names it. A refusal is said in the page and the words stay; a
 * full limit names who works, with a Stop for each (src/lib/chat-send.ts).
 * The field and its send are kept per chat for the window
 * (src/hooks/useChatComposer.ts): a page left during a launch finds them again.
 */

/** Within this many pixels of the end, the thread follows what arrives. */
const FOLLOW_PX = 24;

type Speaker = { key: string; name: string; mark: 'you' | 'tars' | 'letter'; runner: boolean };

function speakerOf(item: ChatItem, runnerName: string): Speaker | null {
  switch (item.kind) {
    case 'user': return { key: 'you', name: 'You', mark: 'you', runner: false };
    case 'text':
    case 'tool': return { key: 'runner', name: runnerName, mark: 'letter', runner: true };
    case 'message': return { key: `message:${item.from ?? ''}`, name: item.from ?? 'An agent', mark: 'letter', runner: false };
    case 'note': {
      const from = item.from ?? 'Tars';
      return { key: `note:${from}`, name: from, mark: from === 'Tars' ? 'tars' : 'letter', runner: false };
    }
    default: return null;
  }
}

type Block = { speaker: Speaker; items: ChatItem[] } | { speaker: null; item: ChatItem };

/** The lines of one speaker in a row share a head; a divider or a raw line stands alone. */
function blocksOf(items: ChatItem[], runnerName: string): Block[] {
  const blocks: Block[] = [];
  for (const item of items) {
    const speaker = speakerOf(item, runnerName);
    const last = blocks[blocks.length - 1];
    if (!speaker) blocks.push({ speaker: null, item });
    else if (last?.speaker && last.speaker.key === speaker.key) last.items.push(item);
    else blocks.push({ speaker, items: [item] });
  }
  return blocks;
}

/** The runner's last tool call in the turn it is in: back over its own lines, to the words it answers. */
function doingOf(items: ChatItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].kind === 'tool') return items[i].text;
    if (items[i].kind !== 'text') return null;
  }
  return null;
}

function stateOf(runner: { name: string; status: string } | null, ask: AgentStatus['permissionAsk'] | undefined): string {
  if (!runner) return '';
  if (runner.status === 'running') return 'working';
  if (runner.status === 'waiting') return ask ? `waiting on you since ${clockOf(ask.askedAt)}` : 'waiting on you';
  if (runner.status === 'error' || runner.status === 'stopped') return runner.status;
  return `${runner.name} answers here`;
}

/** Where a line of the thread sits under the thread's top, in pixels; null when it is not drawn. */
function topOf(el: HTMLElement, id: string): number | null {
  const line = el.querySelector(`[data-chat-item="${CSS.escape(id)}"]`);
  return line ? line.getBoundingClientRect().top - el.getBoundingClientRect().top : null;
}

function Mark({ speaker }: { speaker: Speaker }) {
  if (speaker.mark === 'tars') {
    return <span className="w-6 h-6 shrink-0 flex items-center justify-center"><BrandMark className="w-2.5 h-2.5" /></span>;
  }
  const you = speaker.mark === 'you';
  return (
    <span className={`w-6 h-6 shrink-0 flex items-center justify-center border text-[11px] leading-[1.2] font-semibold text-foreground ${you ? 'bg-accent-dim border-primary' : 'bg-secondary border-border'}`}>
      {speaker.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function Line({ item }: { item: ChatItem }) {
  if (item.kind === 'tool') {
    return (
      <div data-chat-item={item.id} data-kind="tool" className="pl-8 flex items-center gap-2 min-w-0">
        <ArrowRight className="w-3 h-3 shrink-0 text-status-idle" />
        <span className="font-mono text-[11px] leading-[1.4] text-text-secondary truncate" title={item.text}>{item.text}</span>
      </div>
    );
  }
  if (item.kind === 'note') {
    const text = item.from === 'Tars' ? item.text.replace(/^\[Tars\]\s*/, '') : item.text;
    return (
      <div data-chat-item={item.id} data-kind="note" className="pl-8">
        <p className="max-w-[700px] text-[13px] leading-[1.5] text-text-secondary whitespace-pre-wrap break-words">{text}</p>
      </div>
    );
  }
  return (
    <div data-chat-item={item.id} data-kind={item.kind} className="pl-8">
      <div className="max-w-[700px] text-[14px] leading-[1.5] text-foreground break-words">
        {item.kind === 'user' ? <p className="whitespace-pre-wrap">{item.text}</p> : <RichText text={item.text} />}
      </div>
    </div>
  );
}

function Alone({ item }: { item: ChatItem }) {
  if (item.kind === 'divider') {
    return (
      <div data-chat-item={item.id} data-kind="divider" className="pl-8 flex items-center gap-2.5">
        <span className="flex-1 h-px bg-border" />
        <span className="font-mono text-[10.5px] leading-[1.4] text-status-idle">{item.text === 'session' ? 'new session' : item.text}</span>
        <span className="flex-1 h-px bg-border" />
      </div>
    );
  }
  return (
    <p data-chat-item={item.id} data-kind={item.kind} className="pl-8 font-mono text-[10.5px] leading-[1.4] text-status-idle truncate" title={item.text}>
      {item.text}
    </p>
  );
}

/**
 * A send the limit refused (`Chat · chats · every slot working`): its sentence,
 * each chat working with a way to it and its Stop, and the words kept.
 */
function LimitBlock({ outcome, chats }: { outcome: Extract<SendOutcome, { kind: 'limit' }>; chats: ChatView[] }) {
  const [stopping, setStopping] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const stop = async (runnerId: string) => {
    setStopping(runnerId);
    setRefused(null);
    try {
      const answer = await window.electronAPI?.agent?.stop(runnerId);
      if (!answer?.success) setRefused('Tars did not stop it.');
    } catch (error) {
      setRefused(error instanceof Error ? error.message : String(error));
    }
    setStopping(null);
    void refreshChats();
  };
  return (
    <div data-chat-limit role="alert" className="flex flex-col border border-border bg-card">
      <div className="flex items-start gap-2.5 px-3 pt-2.5 pb-2">
        <StatusSquare tone="error" className="mt-[5px]" />
        <p className="text-[12.5px] leading-[1.45] text-foreground">{outcome.reason}</p>
      </div>
      {outcome.working.map(work => {
        const listed = chats.find(c => c.id === work.chatId);
        const runnerId = listed?.runnerId ?? null;
        const since = clockOf(work.since);
        return (
          <div key={work.chatId} data-chat-limit-row={work.chatId} className="flex items-center gap-2.5 px-3 py-1.5 border-t border-border min-w-0">
            <StatusSquare tone="running" />
            <Link href={`/chats?chat=${encodeURIComponent(work.chatId)}`} className="text-[12.5px] leading-[1.4] text-primary hover:underline truncate">
              {work.title}
            </Link>
            {listed && <span className="font-mono text-[10.5px] text-status-idle shrink-0">{projectNameOf(listed.projectPath)} #{listed.number}</span>}
            {since && <span className="font-mono text-[10.5px] text-status-idle shrink-0">since {since}</span>}
            <span className="flex-1" />
            <Button size="sm" disabled={!runnerId || stopping !== null} onClick={() => runnerId && void stop(runnerId)}>
              <Square className="w-3 h-3" />
              Stop
            </Button>
          </div>
        );
      })}
      {refused && <p role="alert" className="px-3 pb-1.5 text-xs text-status-waiting">Not stopped: {refused}</p>}
      <p className="px-3 pt-1 pb-2.5 font-mono text-[10.5px] text-status-idle">Your message stays in the composer.</p>
    </div>
  );
}

export function ChatPage({ chat }: { chat: ChatView }) {
  const { agents, startAgent, stopAgent } = useElectronAgents();
  // The orchestrator's window, opened when its question went back to its terminal: this page shows none.
  const [terminalOpen, setTerminalOpen] = useState(false);
  const { chats } = useChats();
  const { feed, problem, showEarlier, readingEarlier } = useChatFeed(chat.id);

  // The record as its last event told it; the runner as the fleet has it now.
  const record = feed.chat ?? chat;
  const runnerId = feed.runner !== undefined ? feed.runner?.id ?? null : record.runnerId;
  const runner = agents.find(agent => agent.id === runnerId);
  const listed = record.runner?.id === runnerId ? record.runner : null;
  const runnerName = runner?.name ?? listed?.name ?? 'The orchestrator';
  const status = runner?.status ?? listed?.status;
  const ask = runner?.status === 'waiting' ? runner.permissionAsk : undefined;
  const working = status === 'running';
  const doing = working ? doingOf(feed.items) : null;
  const team = agents.filter(agent => agent.projectPath === record.projectPath);
  const created = clockOf(record.createdAt);
  const state = stateOf(runnerId && status ? { name: runnerName, status } : null, ask);
  const meta = [created && `created ${created}`, state].filter(Boolean).join(' · ');
  const earlier = feed.hasEarlier ? feed.items[0]?.n ?? 0 : 0;
  // A chat whose runner is not made yet, or not running, is started by the send.
  const launching = !(listed?.live ?? false);
  const firstMessage = !runnerId && feed.items.length === 0 && !problem;

  // The field, and what the last send came to, this chat's for the window (src/hooks/useChatComposer.ts).
  const { text, sending, outcome, nameProblem } = useChatComposer(chat.id);
  // A held message goes in once the orchestrator takes a turn: the strip has said what it had to.
  useEffect(() => {
    if (working) forgetSentOutcome(chat.id);
  }, [working, chat.id]);
  // Its first message names a chat nobody named.
  const submit = () => void sendComposer(chat.id, { nameIt: record.titleSource === 'auto' });
  const strip = stripOf({ outcome, sending, launching, working });

  // At the end, the thread follows what arrives; scrolled up, it stays. Show
  // earlier keeps the line that was first where it was.
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const kept = useRef<{ id: string; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const was = kept.current;
    if (was && feed.items[0]?.id !== was.id) {
      kept.current = null;
      const top = topOf(el, was.id);
      if (top !== null) el.scrollTop += top - was.top;
      return;
    }
    if (following.current) el.scrollTop = el.scrollHeight;
  }, [feed.items, working, doing, ask?.askedAt]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_PX;
  };
  const readEarlier = () => {
    const el = scroller.current;
    const first = feed.items[0];
    const top = el && first ? topOf(el, first.id) : null;
    kept.current = first && top !== null ? { id: first.id, top } : null;
    showEarlier();
  };

  return (
    <div className="-mx-[26px] -mt-[22px] -mb-[22px] h-screen flex flex-col">
      <ChatHead chat={record} meta={meta} team={team} />

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 flex flex-col">
          <div ref={scroller} onScroll={onScroll} role="log" aria-label="Conversation" className="flex-1 min-h-0 overflow-y-auto [overflow-anchor:none]">
            {firstMessage && (
              <div className="min-h-full flex flex-col items-center justify-center gap-3 px-10 pb-20">
                <BrandMark className="w-2.5 h-2.5" />
                <h2 className="font-serif text-[22px] leading-[1.15] text-foreground text-center">Its conversation starts with your first message</h2>
                <p className="max-w-[480px] text-center text-[12.5px] leading-[1.5] text-text-secondary">
                  Your first message starts this chat&apos;s orchestrator: a conversation of its own, in a worktree of its own, served by the project&apos;s team.
                </p>
              </div>
            )}
            <div className="flex flex-col gap-[18px] pt-6 px-10 pb-4">
              {earlier > 0 && (
                <div className="pl-8 flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={readEarlier}
                    disabled={readingEarlier}
                    className="h-[26px] px-2.5 flex items-center gap-1.5 border border-border bg-card text-[11.5px] text-text-secondary hover:bg-secondary transition-colors disabled:opacity-40"
                  >
                    <ArrowUp className="w-3 h-3" />
                    Show earlier
                  </button>
                  <span className="font-mono text-[10.5px] leading-[1.35] text-status-idle">
                    {earlier} earlier {earlier === 1 ? 'line' : 'lines'}
                  </span>
                </div>
              )}
              {blocksOf(feed.items, runnerName).map(block => block.speaker ? (
                <div key={block.items[0].id} className="flex flex-col gap-1.5">
                  <div data-chat-speaker className="flex items-center gap-2 min-w-0">
                    <Mark speaker={block.speaker} />
                    <span className="text-[12.5px] leading-[1.4] font-semibold text-foreground truncate">{block.speaker.name}</span>
                    {block.speaker.runner && runner?.role === 'orchestrator' && (
                      <span className="h-[22px] px-[7px] flex items-center shrink-0 border border-primary bg-accent-dim font-mono text-[10.5px] leading-[1.35] text-foreground">orchestrator</span>
                    )}
                    <span className="font-mono text-[10.5px] leading-[1.35] text-status-idle shrink-0">{clockOf(block.items[0].at)}</span>
                  </div>
                  {block.items.map(item => <Line key={item.id} item={item} />)}
                </div>
              ) : <Alone key={block.item.id} item={block.item} />)}
              {problem && <p role="alert" className="pl-8 text-xs text-status-waiting">{problem}</p>}
              {working && (
                <div className="pl-8 flex items-center gap-2.5 min-w-0">
                  <span className="w-1.5 h-1.5 shrink-0 bg-status-running" />
                  <span className="text-[12.5px] leading-[1.4] text-text-secondary shrink-0">The orchestrator is working</span>
                  {doing && <span className="font-mono text-[10.5px] leading-[1.35] text-status-idle truncate" title={doing}>{doing}</span>}
                </div>
              )}
            </div>
          </div>

          <div className="shrink-0 flex flex-col gap-2 px-10 pb-5">
            {runner && <PermissionAskNotice agent={runner} layout="window" onAskedInTerminal={() => setTerminalOpen(true)} />}
            {outcome?.kind === 'limit' && <LimitBlock outcome={outcome} chats={chats ?? []} />}
            {nameProblem && <p role="alert" className="text-xs text-status-waiting">{nameProblem}</p>}
            <ComposerCard
              value={text}
              onChange={value => writeComposer(chat.id, value)}
              onSubmit={submit}
              placeholder="Message the orchestrator about this chat"
              canSubmit={!sending && text.trim().length > 0}
              submitLabel="Send"
              disabled={sending && launching}
              attachLabel="A message to a chat is text: files cannot be attached here"
              notice={strip}
            />
          </div>
        </div>

        <aside aria-label="Delegated in this chat" className="w-[340px] shrink-0 bg-card border-l border-border flex flex-col">
          <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2.5">
            <PanelCaption>Delegated in this chat</PanelCaption>
          </div>
          <p className="px-4 py-3 text-xs leading-[1.5] text-text-secondary">
            What this chat delegates shows here once a task names the chat it came from.
          </p>
          <p className="px-4 py-3 border-t border-border text-[11.5px] leading-[1.45] text-status-idle">
            Each task runs in its agent&apos;s terminal on the Dashboard. The room shows what this project and Tars say to each other.
          </p>
        </aside>
      </div>
      {/* Its terminal, where Claude Code's own dialog waits once ask in terminal handed it the question. */}
      <AgentTerminalDialog
        agent={terminalOpen ? runner ?? null : null}
        open={terminalOpen && !!runner}
        onClose={() => setTerminalOpen(false)}
        onStart={(id, prompt) => void startAgent(id, prompt)}
        onStop={id => void stopAgent(id)}
        agents={agents}
      />
    </div>
  );
}
