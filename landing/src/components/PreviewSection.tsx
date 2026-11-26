import type { ReactNode } from 'react';

/**
 * Projects and chats, the preview of 2.0.0 and Tars's only interface since 2.1.0: `Landing · desktop`, its
 * Preview section (design/landing.pen); between its head
 * and its points, the picture of a chat's page the home page hands it (taken by
 * e2e/new-interface-pictures.mjs). No `@/` import and no package of the
 * landing's own: __tests__/landing/preview.test.tsx renders it with the root's,
 * and reads its words against the frame's.
 */
const POINTS = [
  {
    title: 'Every chat, in one list',
    body: 'The sidebar lists your projects’ chats, pinned, active, working, snoozed or settled, each with its state, filters them by project, and says how many work of the most your Mac runs at once. Main is the conversation your orchestrator already had.',
  },
  {
    title: 'A chat’s conversation, live',
    body: 'Write to its orchestrator there, and read the conversation from its own transcripts as it happens: what it says, the tools it calls, the work it hands to its team, and what it asks you. A new chat’s first message starts its own orchestrator.',
  },
  {
    title: 'A page for each project',
    body: 'Its chats, its team and what each agent is on, its terminals and its room, on one page. Agents, Usage, Settings and the other pages open from More, as cards above the app.',
  },
  {
    title: 'Every page, a key away',
    body: 'Cmd and a digit (Ctrl on Windows) opens a page, or its card above the one you are on, as before. Dark or light is in Settings, Preferences, Appearance.',
  },
];

export function PreviewSection({ picture }: { picture?: ReactNode }) {
  return (
    <section id="preview" className="max-w-[1040px] mx-auto px-6 py-16 border-b border-line">
      <p className="font-mono text-xs text-accent mb-3.5">New in 2.1.0</p>
      <h2 className="font-display text-3xl mb-3.5">Projects and chats</h2>
      <p className="text-ink-soft text-[15px] leading-relaxed max-w-[600px] mb-10">
        A project keeps its team, and you open several chats in it, each its own conversation with the
        project{'’'}s orchestrator on one topic. A preview in 2.0.0, it is Tars{'’'}s interface since 2.1.0.
      </p>
      {picture && <div className="mb-10">{picture}</div>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-9">
        {POINTS.map(p => (
          <div key={p.title}>
            <h3 className="text-base font-medium mb-2">{p.title}</h3>
            <p className="text-ink-soft text-[14px] leading-relaxed">{p.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
