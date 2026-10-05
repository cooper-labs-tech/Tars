# Tars 1.5.0: surface inventory

Every surface the app can render today. A frame must exist for each line here;
`npm run e2e:guard` checks the routed ones are covered by the visual suite too.

The frames live in two Pencil documents, and the second is a fork of the first
rather than a companion to it. `design/tars-redesign.pen` holds 117 root frames.
`design/chat-design.pen` holds 72 of those, the other forty-five being newer than the
fork; the two panel history frames this document dropped with the history view;
and the eleven frames of the Chat
room listed on the `/chat` line below: 85 in all. 71 share their ids
and names across the two. The 72nd, `Agent error · reason`, was drawn after the
fork by one script run against both documents, so it has the same name and the
same content in each but different ids. The room frames were drawn in the fork
and exist nowhere else. They describe the Chat before its redesign: the Chat as
it ships is specified in the third document below.

Reconciling them means one document again, and it is deliberately not done here:
a headless Pen session and the Pen desktop app writing the same `.pen` end with
the last save erasing the other, so it waits for a moment when Pen is closed.
Until then, draw anything for the Chat in `chat-redesign-a.pen` and anything
else in `tars-redesign.pen`.

A third document, `design/chat-redesign-a.pen`, holds the Chat page's redesign:
direction A, which JeanBrasse chose on 2026-09-17 (the thread first, the team folded
into the left column), with its composer, modeled on Claude's and ChatGPT's. The
Chat implements it since #165 (merged 2026-09-24): the room and Hermes pages in
every state a user can meet, sheets for the team, the thread, Hermes, the
composer and the room head, each dark and light, and two notes frames. Hermes is the global room.
Draw anything for the Chat in `chat-redesign-a.pen`.

A fourth document, `design/landing.pen`, holds the site in `landing/`:
`Landing · desktop`, `Landing · 404`, `Landing · privacy and terms` (the two
legal pages, drawn once: they share one layout), and `Landing · social image`,
the picture link previews show. It was forked from `tars-redesign.pen` on 2026-09-23 with
only the landing kept, and the landing frame left the first two documents in the
same change. Draw anything for the site in `landing.pen`.

Generated against the code, not from memory. Anything removed from the app
(ClaudeMon, Support, the 3D view, Obsidian, Automations, Scheduled Tasks,
custom dashboard boards, the sidebar collapse) is deliberately absent.

## Pages (14)

| Route | Name | Frame |
|---|---|---|
| `/` | Dashboard (terminal grid) | Dashboard · dark, Dashboard · light, Panel header · session and fullscreen, Agent error · reason, Message waiting · notice, Agent stopped · who and why (and its light copy) |
| `/chat` | Chat (Hermes overseer + one room per project) | Chat · Overseer (`tars-redesign.pen`). The room, all eleven in `chat-design.pen`: Chat · Hermes · with rooms, Chat · Room · agents at work, Chat · Room · you step in, Chat · Room · limit reached, Chat · Room · all stopped, Chat · Room · no agents, Chat · Room · add an agent, Chat · Room · stop an agent, Chat · Room · edit an agent, Chat · Room · the rows a room is made of, Chat · Room · at rest or stopped. The redesign, in `chat-redesign-a.pen`, which the page implements since #165: Chat · A · Room · agents at work, · at rest, · one agent busy, · one agent stopped, · everyone stopped, · an agent errors, · a long thread, scrolled up, · delivery states, · team folded, · members join and leave, · nothing said yet, how it runs open, · no agents yet, · the bus does not answer; Chat · A · Hermes, · answering, · paused, a write sent, · not connected, · nothing said yet; Chat · A · first run, nothing to watch; the sheets Chat · A · Team rows · states, · Thread rows · states, · Hermes · states, · Composer · states and · Room head · states (a long path, a long name); each with its `· light`; A · notes and A · every state · notes |
| `/agents` | Agents | Agents · dark (every project, grouped), Agents · one project, Agents · project picker open, Agent error · reason, Agent stopped · who and why (and its light copy) |
| `/kanban` | Kanban | Kanban · dark |
| `/crons` | Schedules | Schedules · dark |
| `/review` | Review | Review · dark, Review · light, Review · states (a patch that could not be read, a patch cut short) and its light copy |
| `/logs` | Logs | Logs · dark |
| `/vault` | Vault | Vault · dark |
| `/projects` | Projects | Projects · dark, Agent stopped · who and why (a stopped agent's row) |
| `/skills` | Extensions (Skills + Plugins) | Extensions · Skills, Extensions · Plugins |
| `/usage` | Usage | Usage · dark, Usage · light, Usage · daily messages, Usage · last 24 hours, Usage · limits per account (each with its light copy) |
| `/memory` | Brain (Projects / Agents / Backends) | Brain · Projects, Brain · Agents, Brain · Backends |
| `/whats-new` | What's new | What's new · dark |
| `/settings` | Settings | see below |
| `/tray-panel` | Tray panel (menu-bar popover) | Tray panel |

## Settings (6 groups, 19 sections)

| Group | Sections |
|---|---|
| General | Preferences, Terminal, Notifications, System |
| AI & Providers | Providers, Claude accounts, CLI Paths, Permissions |
| Hermes | Connection (+ link out to Schedules), with its Telegram through Hermes switch: Settings · Connection, and its states in Settings · Connection · Telegram through Hermes (and its light copy) |
| Integrations | Telegram, Slack, Discord, X (Twitter), Google Workspace; Telegram with Telegram through Hermes on, the bot off and nothing to type: Settings · Telegram · Telegram through Hermes (and its light copy) |
| Extensions | Skills & Plugins, Custom MCP, Tasmania |
| Workspace | Git, Memory Backends |

Claude accounts is off until turned on. On, it lists up to five Claude
subscriptions, each with its 5 h and weekly use, and the two thresholds that
move agents between them; the account an agent runs on then shows, with a menu
that pins it, on its card in Agents, its pane header on the Dashboard and its
window. A move by Tars is one grey line in the agent's pane and window, and the
control's title says where the agent came from. Frames: Settings · Claude
accounts, Settings · Claude accounts · states,
Agent · Claude account (and their light copies).

## Overlays and dialogs (15)

- Add a Claude account, Sign in <account>, Remove <account>? (Settings >
  Claude accounts): adding names the account, then a terminal on its new
  folder runs Claude Code's own sign-in, which Tars never sees; the account
  reads signed in once Claude Code says so. Remove asks first. Frames:
  Settings · Claude accounts · states (and its light copy)
- New agent / New team (`NewChatModal`): one screen, a "One agent | A team"
  switch in the header. One agent: project, provider tiles + model, task
  textarea, one collapsed Options row (skills, effort, permissions, worktree,
  orchestrator, CLI binary). A team: project + start-from-preset, a member
  table (role/provider/model/effort/branch), a shared brief, the same
  Options pattern. Replaces the old four-step wizard and `DeployTeamDialog`.
  The Orchestrator row is the role: what it gives, one per project, and in
  the edit dialog that saving restarts the agent once it is free.
  Frames: Overlay · New agent (one screen), Overlay · New team (one screen),
  Overlay · New agent · Options open, Overlay · Edit agent · Orchestrator
  (and its light copy), Orchestrator role · states
- Replace the orchestrator of <project>?: asked before a save would give the
  role to an agent while another agent of the same project holds it (the
  toggle, a new agent, a move to another project, a team with an orchestrator
  member). It names the agent that loses the role; Cancel goes back to the
  dialog. Frames: Overlay · Replace the orchestrator (and its light copy),
  Orchestrator role · states
- Templates manager (the Templates button on the Agents page), with the
  Template form, Instantiate and Import it opens. Import reviews a file before
  saving anything: each template's permission mode, the folders it adds, its
  skills and its whole prompt, with the characters that do not show written
  out, and it refuses a file it cannot show as it will be used. Instantiate
  shows the same facts and the prompt, and sends the prompt only while
  "Start it with this prompt" is on (on for a built-in template, off for any
  other). Frames: Overlay · Templates manager, Overlay · Template form,
  Overlay · Instantiate template, Overlay · Import template, and the two drawn
  for that review, Overlay · Instantiate template · prompt and Overlay · Import
  template · review, each with its light copy
- Agent terminal dialog: header, panel header, footer, sidebar, secondary project,
  super-agent sidebar; a stopped agent's header, second row and the rail's
  stopped group in Agent stopped · who and why
- Start prompt (`StartPromptModal`)
- Kanban: new task, card detail, done summary
- Plugin install, Install terminal (settings)

## Menus, dropdowns and controls

- `ui/Dropdown`: the themed replacement for `<select>`
- Add agent dropdown (dashboard)
- Terminal context menu (right-click)
- Global toolbar, terminal panel header menu, layout preset selector
- The panel's `session` label and its fullscreen button (the arrows, turned inward in fullscreen), in the terminal panel header
- Project tab bar (dashboard)
- Toggle, StatusBadge/StatusDot, Field (label/input/select/textarea), Button

## Terminal panel

A terminal panel shows its agent's session: the pty as it is, which its header
names `session`. A full-screen CLI holds the alternate screen, so the panel
does not scroll it and is not meant to. The arrows after start or stop put the
panel in fullscreen, and turn inward to take it back; the panel's menu keeps
clear, and hide from this board outside fullscreen. The history view, which
read the transcript instead, is gone since 1.9.2.

| Frame | What it holds |
|---|---|
| Panel header · session and fullscreen | The header at rest and in fullscreen, and its menu in both (and its light copy) |
| Message waiting · notice | The line a panel shows while a message waits for a field somebody is typing in, with the two ways out |
| Left fullscreen · notice | The line a panel shows when its claude left fullscreen and the wheel can no longer scroll it, with restart (and its light copy) |
| Restart pending · notice | The line a panel shows while a changed setting waits to restart its agent: which settings, and what the restart waits on (and its light copy) |

## States every data surface must show

Loading (three stages: nothing under 400ms, skeleton, then a named slow
operation), empty, error, needs-sign-in, permission-denied.

## Motion

- Launch: mark, wordmark, boot steps, gateway handshake
- Page load: skeleton in the real shape of the content
