'use client';

import Image from 'next/image';
import { Download, Github } from 'lucide-react';
import { useState, useEffect } from 'react';
import dashboard from '@/assets/dashboard.png';
import { SiteFooter } from '@/components/SiteFooter';
import { SiteNav } from '@/components/SiteNav';

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
    body: 'A diff review of every branch, one search across the fleet\u2019s output as each terminal showed it, and spend hour by hour or day by day, per provider and against the budget you set, beside each Claude account\u2019s 5 h and weekly limits.',
  },
  {
    title: 'Several Claude subscriptions',
    body: 'Run your Claude agents on up to five subscriptions. Each starts on the account with the most room left, and one cut short by a limit carries on from another account, in the same conversation.',
  },
  {
    title: 'When an agent stops, or stalls',
    body: 'Stop one, and its card, panel and window say who stopped it and when, and an orchestrator that stops one says why. One that reads running but has written nothing for 30 minutes and runs no command is marked stalled, and its orchestrator is told.',
  },
];

export default function Home() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    fetch('/api/stats').then(r => r.json()).then(d => setCount(d.total)).catch(() => { });
  }, []);

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
        <div className="flex flex-wrap items-center gap-3">
          <a href="/api/download" className="flex items-center gap-2 px-5 py-2.5 bg-accent text-bg text-sm font-medium hover:bg-accent-deep transition-colors">
            <Download className="w-4 h-4" />
            Download for Mac
          </a>
          <a href="https://github.com/JeanBrasse/Tars" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 px-5 py-2.5 border border-line-strong text-sm text-ink-soft hover:text-ink transition-colors">
            <Github className="w-4 h-4" />
            Source
          </a>
          {/* GitHub's own count of .dmg downloads (src/lib/downloads.ts).
              Nothing while there is none, or when GitHub did not answer. */}
          {count !== null && count > 0 && (
            <span className="font-mono text-xs text-ink-muted">{count.toLocaleString()} downloads</span>
          )}
        </div>
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

      {/* Download */}
      <section id="download" className="max-w-[1040px] mx-auto px-6 py-20 text-center">
        <h2 className="font-display text-4xl mb-4">Get Tars</h2>
        <p className="text-ink-soft text-[15px] mb-8 max-w-md mx-auto">
          macOS desktop app. Free and open source. No account, no cloud in the middle.
        </p>
        <a href="/api/download" className="inline-flex items-center gap-2 px-6 py-3 bg-accent text-bg text-sm font-medium hover:bg-accent-deep transition-colors">
          <Download className="w-4 h-4" />
          Download for Mac
        </a>
      </section>

      <SiteFooter />
    </main>
  );
}
