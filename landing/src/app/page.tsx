'use client';

import Image from 'next/image';
import { useState, useEffect } from 'react';
import dashboard from '@/assets/dashboard.png';
import newInterface from '@/assets/new-interface.png';
import { GetTars, HeroDownload } from '@/components/Downloads';
import { PreviewSection } from '@/components/PreviewSection';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteNav } from '@/components/SiteNav';
import { readVisitor, type Arch, type Builds, type Os } from '@/lib/platforms';

const FEATURES = [
  {
    title: 'Every agent, one screen',
    body: 'Real terminals in a grid, grouped by project. Watch six agents work at once, open any of them fullscreen in one press, broadcast one instruction to all.',
  },
  {
    title: 'Someone watching the whole thing',
    body: 'A Hermes agent sees every agent in every project and tells you what they are doing, which decisions are in flight, and which ones are stuck on you. It asks before it writes to any of them.',
  },
  {
    title: 'Delegation that reports back',
    body: 'An orchestrator hands work over the Agent Client Protocol, and every task comes back with a stop reason, the tools it used and what it cost.',
  },
  {
    title: 'Deploy a whole team',
    body: 'One click puts an orchestrator, frontend, backend, QA, audit and database engineer on a project, each on its own git worktree, model and brief.',
  },
  {
    title: 'Any CLI, any model',
    body: 'Claude, Codex, Gemini, Grok, OpenCode, Ollama, Venice, DeepSeek, Kimi, MiniMax and a dozen more. Model lists and prices come from a live catalogue, so today\u2019s release is here today.',
  },
  {
    title: 'One memory, five sources',
    body: 'Project files, the session ledger, your Hermes gateway, gbrain and Honcho behind one interface that every CLI can reach.',
  },
  {
    title: 'See what they actually did',
    body: 'A diff review of every branch, one search across the fleet\u2019s output as each terminal showed it, and spend hour by hour or day by day, per provider and against the budget you set, down to what each task cost, with the work it handed on to other agents.',
  },
  {
    title: 'Several Claude subscriptions',
    body: 'Run your Claude agents on up to five subscriptions. Tars asks Claude Code itself for each account\u2019s 5 h and weekly use, never its sign-in, and starts each agent on the account with the most room left; one cut short by a limit carries on from another, in the same conversation.',
  },
  {
    title: 'When an agent stops, or stalls',
    body: 'Stop one, and its card, panel and window say who stopped it and when, and an orchestrator that stops one says why. On Claude Code 2.1.289 or newer, a Claude agent reports its state from inside it: one whose Claude Code froze is marked stalled after five minutes of silence, never for a long command or a subagent, and its orchestrator is told.',
  },
  {
    title: 'Your Telegram, through Hermes',
    body: 'Turn on Telegram through Hermes, and your own Hermes becomes Tars\u2019s voice on Telegram: your orchestrators\u2019 questions and the event reports reach you there, and your reply goes to the orchestrator it answers, or to the project you name with @project.',
  },
  {
    title: 'Agents that sleep, and come back',
    body: 'An agent with no turn for 30 minutes sleeps and gives back its memory; a message, a task or a key typed in its panel wakes it on its own conversation in about a second. After a crash or a power cut, the agents that were working start again on theirs, with a note of what was cut.',
  },
  {
    title: 'Permissions, asked in Tars',
    body: 'On Claude Code 2.1.289 or newer, a Claude agent asks Tars, not its terminal, before a command or a call Claude Code would ask you about. Its card, its panel and its window say what it would run, read or open; allow it, or deny it with a reason the agent reads.',
  },
  {
    title: 'Worktrees that start ready, and lose nothing',
    body: 'An agent\u2019s worktree starts with its project\u2019s dependencies cloned, at almost no disk space, when the project\u2019s own install matches its lock on a volume that can clone. Delete the agent and what it had not committed is kept on a wip/ branch; a worktree holding what no branch can carry, such as a .env or a submodule\u2019s unpushed work, stays where it is, and Tars says why.',
  },
  {
    title: 'Your disk, in view',
    body: 'Settings, System says how much your disk has free and lists the folders under your projects\u2019 .worktrees that git no longer knows and no agent owns, with their size. Tars removes them only once you confirm, keeps one a process works in, and starts no agent under 2 GB free.',
  },
];

export default function Home() {
  // Undefined until /api/stats answers; its builds and newest release are null when GitHub did not.
  const [stats, setStats] = useState<{ total: number | null; builds: Builds | null; latest: string | null }>();
  // The visitor's system, read in the browser and kept nowhere.
  const [visitor, setVisitor] = useState<{ os: Os | null; arch: Arch | null }>();

  useEffect(() => {
    setVisitor(readVisitor(navigator));
    fetch('/api/stats').then(r => r.json()).then(d => setStats({ total: d.total ?? null, builds: d.builds ?? null, latest: d.latest ?? null })).catch(() => setStats({ total: null, builds: null, latest: null }));
  }, []);

  // Until both are known, Download goes to the list below rather than name a system.
  const os = stats && visitor ? visitor.os : null;

  return (
    <main className="min-h-screen bg-bg text-ink">
      <SiteNav home />

      {/* Hero */}
      <section className="max-w-[1040px] mx-auto px-6 pt-16 pb-20 border-b border-line">
        <p className="font-mono text-xs text-accent mb-5">A control room for AI coding agents</p>
        <h1 className="font-display text-5xl md:text-7xl leading-[1.05] max-w-3xl mb-6">
          Run a team of agents like you run a team of engineers.
        </h1>
        <p className="text-ink-soft text-[15px] leading-relaxed max-w-xl mb-9">
          Tars puts every agent in one place: parallel terminals per project, teams you deploy in a
          click, one memory they all share, and delegation that comes back with what each task did and
          what it cost.
        </p>
        <HeroDownload visitor={os} arch={visitor?.arch ?? null} builds={stats?.builds ?? null} latest={stats?.latest ?? null} count={stats?.total ?? null} />
      </section>

      {/* The product itself: the Dashboard of a real Tars, four Claude Code
          sessions on one project, one of them in the middle of a turn. It
          replaced a hand-drawn terminal whose output was invented. */}
      <section className="max-w-[1040px] mx-auto px-6 py-14 border-b border-line">
        <Image
          src={dashboard}
          alt="The Tars Dashboard: four Claude Code agents working side by side on one project, one of them in the middle of a turn."
          priority
          sizes="(min-width: 1040px) 992px, 100vw"
          className="w-full h-auto border border-line"
        />
      </section>

      {/* Features */}
      <section id="features" className="max-w-[1040px] mx-auto px-6 py-16 border-b border-line">
        <h2 className="font-display text-3xl mb-10">What it does</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-9">
          {FEATURES.map(f => (
            <div key={f.title}>
              <h3 className="text-base font-medium mb-2">{f.title}</h3>
              <p className="text-ink-soft text-[14px] leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <PreviewSection
        picture={(
          <Image
            src={newInterface}
            alt="A chat's page in the new interface: its orchestrator hands the scroll lock's test to QA and its fix to the Frontend Engineer, reads their answers and runs the tests, while the chat list says 2 of 3 chats are working."
            sizes="(min-width: 1040px) 992px, 100vw"
            className="w-full h-auto border border-line"
          />
        )}
      />

      {/* How */}
      <section id="how" className="max-w-[1040px] mx-auto px-6 py-16 border-b border-line">
        <h2 className="font-display text-3xl mb-10">How it works</h2>
        <ol className="space-y-6">
          {[
            ['Point it at a folder', 'Add your project. Tars finds the CLIs already installed on your machine.'],
            ['Create an agent, or a team', 'One agent from a template, or a full engineering team with a worktree branch each.'],
            ['Let them work', 'Terminals stream live. The orchestrator delegates and gets an answer. Nothing starts without you asking.'],
            ['Wire in Hermes', 'Your own gateway schedules the recurring work, and its kanban board drives what the team picks up next.'],
          ].map(([t, d], i) => (
            <li key={t} className="flex gap-5">
              <span className="font-mono text-xs text-accent pt-1 shrink-0">{String(i + 1).padStart(2, '0')}</span>
              <div>
                <h3 className="text-base font-medium mb-1">{t}</h3>
                <p className="text-ink-soft text-[14px] leading-relaxed">{d}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Download: a card per system (Landing · desktop, Get Tars). */}
      <GetTars builds={stats?.builds ?? null} latest={stats?.latest ?? null} visitor={os} arch={visitor?.arch ?? null} />

      <SiteFooter />
    </main>
  );
}
