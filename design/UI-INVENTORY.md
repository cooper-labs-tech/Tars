# Tars 1.5.0: surface inventory

Every surface the app can render today. A frame must exist for each line here;
`npm run e2e:guard` checks the routed ones are covered by the visual suite too.

The frames live in two Pencil documents, and the second is a fork of the first
rather than a companion to it. `design/tars-redesign.pen` holds 359 root frames, 92 of them drawn and not built yet: the 81 listed at the end, and the 11 of the Usage activity grid in their own section. Every frame but the app icon, the launch pictures and the library sheet uses the tokens, so each has its light version.
`design/chat-design.pen` holds 72 of those, the other two hundred and eighty-seven being newer than the
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
`Landing · desktop` (its `Preview` section shows the new interface as the preview
of 2.0.0, with a picture of a chat's page that e2e/new-interface-pictures.mjs takes), `Landing · 404`, `Landing · privacy and terms` (the two
legal pages, drawn once: they share one layout), and `Landing · social image`,
the picture link previews show. It was forked from `tars-redesign.pen` on 2026-09-23 with
only the landing kept, and the landing frame left the first two documents in the
same change. Draw anything for the site in `landing.pen`.

Generated against the code, not from memory. Anything removed from the app
(ClaudeMon, Support, the 3D view, Obsidian, Automations, Scheduled Tasks,
custom dashboard boards, the sidebar collapse) is deliberately absent.

## Chats per project: the new shell behind a switch, and what is still drawn only

JeanBrasse's direction of 2026-10-07: a project keeps its team (the orchestrator and its
agents), and you open several chats in it, each a conversation with the orchestrator
on one topic, all served by the same team, several at once. The current Chat stays as
it is, as the super orchestrator's space, and the chats are added beside it.

**Built, behind Settings, Preferences, "New interface"** (off unless turned on; plan
2.0.0, frontend brief of 12/10). Since 2.0.0 that row shows to everyone, off by default:
the preview. Before, it showed only once `"newInterface": true` in
`~/.dorothy/app-settings.json` had turned the preview on, so that whoever did could turn
it off (JeanBrasse, 12/10). Off, the app draws exactly as before. On:

| Surface | Frames |
|---|---|
| The new shell: main menu (Chat, Projects, then Dashboard, Kanban and Schedules), New chat, the fixed first entry Tars, all projects (today's room, /chat), the chat list, More at the foot | `tars-redesign.pen`: Shell · chats · empty, Shell · chats · list, a chat open |
| More open: Agents, Review, Logs, Vault, Extensions, Usage, Resources, Brain, Settings, What's New | `tars-redesign.pen`: Shell · chats · More open |
| A page of More, opened as a card above the app, over a scrim, the page under it not moving | `tars-redesign.pen`: Shell · chats · Settings card |
| Tars, all projects: the current Chat page, unchanged, in the new shell | `chat-redesign-a.pen`: Chat · chats · Tars, all projects |
| The chat list, read from the chats' records (#361): Pinned, Active, Working, Snoozed and Settled, the last two folded; each row with its title, project and number, and its runner's state; the project filter; "No chats yet" before a project has an orchestrator | `tars-redesign.pen`: Shell · chats · list, a chat open, Shell · chats · empty |
| A chat's actions, behind the dots on its row: pin, rename in place, snooze until a chosen time, settle, make it the project's inbox, delete. Delete asks first; a refusal says why in the store's words and names the work out; a deletion that leaves its runner's worktree on disk, or its uncommitted work on a wip/ branch, says what stays and where above the list until ok puts it away | `tars-redesign.pen`: Shell · chats · a chat's actions · states |
| New chat: its record, a project with an orchestrator (one without cannot be chosen) and a title | `tars-redesign.pen`: Shell · chats · new chat, its record |
| A chat with a runner (Main, today) open on its conversation, `/chats` (listed with the pages below): its lines read from its runner's transcripts (#371) and followed live, the last 200 and Show earlier for the ones before, each line as what it is, one speaker's lines under one head; its runner working at the end of the thread, with its last tool call; its permission ask above the composer, the one its window shows; the Chat's composer, sending through chat:send: while the orchestrator works the words go in when its turn ends, a held or a refused send says so in the strip, the words kept, and a full limit names who works, with a Stop for each; the panel saying when what the chat delegates shows there | `chat-redesign-a.pen`: Chat · chats · from its transcripts, working, Chat · chats · from its transcripts, waiting on you, Chat · chats · the composer, sending, Chat · chats · every slot working |
| A chat without a runner yet (a new chat): its head, and its first message, which starts its orchestrator in a worktree of its own | `chat-redesign-a.pen`: Chat · chats · a new chat, its first message; the list beside it, `tars-redesign.pen`: Shell · chats · list, a chat open |
| How many chats work against the Mac's limit, above the list ("N of M working", from system:chatLimit) | `chat-redesign-a.pen`: Chat · chats · a new chat, its first message, Chat · chats · every slot working |
| A project's page, `/project` (listed with the pages below): its chats by number, Main named as its inbox, its team with what each agent is on, its Dashboard terminals and its room | `tars-redesign.pen`: Shell · chats · project page, from the records |

The specs that walk them with the switch on are `e2e/new-interface-shell.spec.ts`,
`e2e/new-interface-chats.spec.ts`, `e2e/new-interface-chat-page.spec.ts` and
`e2e/new-interface-chat-send.spec.ts`.

**Drawn only** (from the Backend's orchestrator per chat design, v2.2): what a chat
delegated waits for a task to name the chat it came from, and a new chat is made from
its record rather than its first message. The first column names no route, so
`npm run e2e:guard` does not read this table.

| Surface | Frames |
|---|---|
| What a chat delegated, with its state and result, once a task names the chat it came from | `chat-redesign-a.pen`: Chat · chats · orchestrator working, · a worker on another chat, · a result back, · waiting on you, · a task given up |
| New chat from its first message: the title taken from it | `chat-redesign-a.pen`: Chat · chats · new chat |

Each frame has its `· light` copy beside it. A notes frame says what each frame
shows: Chats · shell · notes, Chats · the list from the records · notes, Chats · chat
page from the transcripts · notes, and Chats · chat page · notes, which also says how
the room relates to the chats and what follows the Backend's v2.2.

## Pages (18)

| Route | Name | Frame |
|---|---|---|
| `/` | Dashboard (terminal grid) | Dashboard · dark, Dashboard · light, Panel header · fullscreen, Agent error · reason, Message waiting · notice, Agent stopped · who and why, Agent asleep · and how it wakes, Permission asked of Tars (each with its light copy); the orchestrator layout: Dashboard · orchestrator layout · 2 agents, · 3 agents, · 6 agents, · 7 agents, the column scrolled, · equal grid, · narrowest window, · new interface, · a board with no orchestrator (6 agents, equal grid and new interface each with its light copy), and its rules in · notes; since 2.0.5: Checkpoint (2.0.5) · the line in the Dashboard terminal header (and its light copy), Dashboard header (2.0.5) · start, wake and stop in the ··· menu (and its light copy), Blocked (2.0.5) · an agent blocked, its reason (and its light copy), and Dashboard (2.0.5) · twelve agents, three columns, scrolled (and its light copy) |
| `/chat` | Chat (Hermes overseer + one room per project) | Chat · Overseer (`tars-redesign.pen`). The room, all eleven in `chat-design.pen`: Chat · Hermes · with rooms, Chat · Room · agents at work, Chat · Room · you step in, Chat · Room · limit reached, Chat · Room · all stopped, Chat · Room · no agents, Chat · Room · add an agent, Chat · Room · stop an agent, Chat · Room · edit an agent, Chat · Room · the rows a room is made of, Chat · Room · at rest or stopped. The redesign, in `chat-redesign-a.pen`, which the page implements since #165: Chat · A · Room · agents at work, · at rest, · one agent busy, · one agent stopped, · everyone stopped, · an agent errors, · a long thread, scrolled up, · delivery states, · team folded, · members join and leave, · nothing said yet, how it runs open, · no agents yet, · the bus does not answer; Chat · A · Hermes, · answering, · paused, a write sent, · not connected, · nothing said yet; Chat · A · first run, nothing to watch; the sheets Chat · A · Team rows · states, · Thread rows · states, · Hermes · states, · Composer · states and · Room head · states (a long path, a long name); each with its `· light`; A · notes and A · every state · notes |
| `/chats` | Chats (the new shell's chats page: the chat open, on its conversation, or a new chat on its first message, or a new chat's record, read from the chats' records) | Shell · chats · list, a chat open, Shell · chats · new chat, its record, Shell · chats · empty (`tars-redesign.pen`), Chat · chats · from its transcripts, working, Chat · chats · from its transcripts, waiting on you, Chat · chats · a new chat, its first message, Chat · chats · the composer, sending, Chat · chats · every slot working (`chat-redesign-a.pen`), each with its light copy |
| `/project` | A project's page (the new shell's, under Projects; `?path=` names the project) | Shell · chats · project page, from the records (and its light copy) |
| `/agents` | Agents | Agents · dark (every project, grouped), Agents · one project, Agents · project picker open, Agent error · reason, Agent stopped · who and why, Agent asleep · and how it wakes (each with its light copy), Permission asked of Tars (an agent's card, and its window; and its light copy), Agents · an agent deleted, what stays and where (its worktree kept, why and where, and its work on a wip/ branch, above the grid until ok; and its light copy) |
| `/kanban` | Kanban | Kanban · dark |
| `/crons` | Schedules | Schedules · dark |
| `/review` | Review | Review · dark, Review · light, Review · states (a patch that could not be read, a patch cut short) and its light copy; every repository of every project since 2.0.4: Review · projects and their repositories, · search, · a folder with no git (the first and the last with their light copies, the first at the narrowest window), · states (and its light copy), · notes for the Backend; their old-shop row, a project added by hand whose folder is gone, with its removal, is drawn for 2.0.5 (listed at the end) |
| `/logs` | Logs | Logs · dark |
| `/vault` | Vault | Vault · dark; each project's reports and tools since 2.0.4: Vault · project folders · a report, · a report, editing, · a tool (the first two with their light copies, editing at the narrowest window), · states (and its light copy), · notes for the Backend; every folder of each project's folder as a tree since 2.0.5: Vault (2.0.5) · project folders as a tree (its light copy, the narrowest window), · project folder tree · states (and its light copy), · notes for the Backend, drawn in #526 |
| `/projects` | Projects | Projects · dark, Agent stopped · who and why (a stopped agent's row), Agent asleep · and how it wakes (an asleep agent's row) |
| `/skills` | Extensions (Skills + Plugins) | Extensions · Skills, Extensions · Plugins |
| `/usage` | Usage | Usage · dark, Usage · light, Usage · daily messages, Usage · last 24 hours, Usage · limits per account, Usage · cost per task, Usage · cost per agent, Usage · pages (five rows a card, states, narrowest window; notes), Usage · cards while they read (each with its light copy; the agent table's headers, figures highest first, words A to Z, and focused, are its col header states) |
| `/resources` | Resources (this computer: the heavy-run slot and its queue, what each agent and project holds, the disk janitor; ?view= names the view) | Resources (2.0.5) · heavy runs, · agents and projects, · disk (each with its light copy and at the narrowest window), · heavy runs · states, · agents and projects · states, · disk · states (each with its light copy), · notes |
| `/memory` | Brain (Projects / Agents / Backends) | Brain · Projects, Brain · Agents, Brain · Backends; a project's row naming the older copy of its memory: Brain · Projects · a row with an older copy · states (and its light copy); fifty agents and a thousand memory files fitted to the canvas, a project's memory one box, with the zoom controls: Brain · Agents · fifty agents, fitted; a project opened, the list of its memory files and one of them open: Brain · Agents · a project's memory files, Brain · Agents · a project's memory file, open (panel) |
| `/whats-new` | What's new | What's new · dark |
| `/settings` | Settings | see below |
| `/tray-panel` | Tray panel (menu-bar popover) | Tray panel |

## Usage: the activity grid, drawn only

Drawn on 2026-10-18 for the maintainer's approval and not built: no data channel gives
a day's tokens per model yet. The first column names no route, so `npm run e2e:guard`
does not read this table.

| Surface | Frames |
|---|---|
| The Usage page's activity card, under the four tiles: one square per local day over the last 53 weeks, Monday to Sunday, in five steps of the accent; the period's totals above the grid (tokens, cost, active days, longest streak, most used model); a day's tooltip with its tokens per model (the six largest, then +N others) and its cost | `tars-redesign.pen`: Usage · activity |
| Its states: no usage yet, loading, the narrowest window (1200 by 800), where the squares keep 16 px and the grid scrolls inside its card while the page does not, and a wide window (1920 by 1080), where the squares stop at 22 px and the grid sits centred in its card; in between, the squares grow with the card so the grid ends at its right edge | `tars-redesign.pen`: Usage · activity · no usage yet, Usage · activity · loading, Usage · activity · narrowest window, Usage · activity · wide window |

Each frame has its `· light` copy below it. Usage · activity · notes says what each
part shows and what the Backend would provide.

## Settings (6 groups, 20 sections)

| Group | Sections |
|---|---|
| General | Preferences (with the New interface switch last, off by default: Settings · Preferences, and with the row on Settings · Preferences · new interface on, each with its light copy; the last error report beside the Send error reports switch: Settings · Preferences · error reports, the last report, and its light copy), Terminal, Notifications, System (with the disk and the folders no agent owns: Settings · System · folders no agent owns, and its states, each with its light copy); Preferences' Keep this computer awake row since 2.0.5: Keep awake (2.0.5) · Settings, General, Preferences (its light copy, the narrowest window), · states (and its light copy) |
| AI & Providers | Providers (an API key set, replaced or cleared, never shown: Secrets · Settings, Providers, an API key, and its light copy), Claude accounts, CLI Paths (what Tars found as it opens, the detection Providers reads too: Secrets · CLIs, one detection, and its light copy), Permissions |
| Hermes | Connection (+ link out to Schedules): Settings · Connection, its Incoming webhooks row pointing to Gateways; its token set and replaced, never shown: Secrets · Settings, Hermes connection (and its light copy). Its Telegram through Hermes switch moves to Relay, drawn for 2.0.4 (listed at the end). Gateways, every Hermes that hands Tars work, its two addresses, its secret shown and copied by Tars only, added, replaced and removed asking once, and the projects it may reach: Gateways · Settings, Hermes (its light copy, the narrowest window), · states (and its light copy), · notes for the Backend |
| Integrations | Telegram, Slack, Discord, X (Twitter), Google Workspace; Telegram since 2.0.5, Tars's own bot gone: Telegram goes through Hermes, its one action leading to Settings, Hermes, nothing to type, test or switch, and, when Tars found the old bot's token, the line saying to revoke it with BotFather: Settings · Telegram · Telegram through Hermes (and its light copy); every key and token of the other sections set, replaced or cleared, never shown: Secrets · states (Slack's bot token for the pattern, and its light copy), Secrets · notes for the Backend. The frames that drew the bot itself, Settings · Telegram and Secrets · Settings, Telegram (its light copy, the narrowest window), left the document with it in 2.0.5 |
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

## Overlays and dialogs (17)

- More (the new shell, with New interface on): Agents, Review, Logs, Vault,
  Extensions, Usage, Resources, Brain, Settings and What's New, opened above the sidebar's
  foot. Frames: Shell · chats · More open (and its light copy)
- A page of More as a card above the app (the new shell): the page its own route
  shows, under a head with its icon and name, Escape or the cross to close it.
  Frames: Shell · chats · Settings card (and its light copy)
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
  (and its light copy), Orchestrator role · states. Permissions offers plan,
  manual, auto and bypass; plan only for Claude Code, dimmed with its reason
  for another CLI: Permissions · plan mode · states (and its light copy).
  An edit the main process refuses (a worktree git cannot make) keeps the
  dialog open with the changes made, and says why beside its buttons:
  Overlay · Edit agent · not saved (and its light copy). A create it refuses
  does the same in New agent, Not created and git's reason beside the
  buttons: Overlay · New agent · not created; and New team lists the member
  it could not make with that reason above the form, Electron's own words
  taken off: Overlay · New team · a member not made
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
  stopped group in Agent stopped · who and why; an asleep agent's, and the
  rail's asleep group, in Agent asleep · and how it wakes; the Skills tab's
  permissions, plan first, in Permissions · plan mode · states
- Start prompt (`StartPromptModal`)
- Kanban (the Hermes board): new task, a task's detail
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
| Panel header · fullscreen | The header at rest and in fullscreen, and its menu in both; no word names the panel's view (and its light copy) |
| Message waiting · notice | The line a panel shows while a message waits for a field somebody is typing in, with the two ways out |
| Left fullscreen · notice | The line a panel shows when its claude left fullscreen and the wheel can no longer scroll it, with restart (and its light copy) |
| Restart pending · notice | The line a panel shows while a changed setting waits to restart its agent: which settings, and what the restart waits on (and its light copy) |
| Data folder · notice | The line across the top of the main column when Tars could not settle on ~/.tars: two data folders and the one it runs on, or a move refused and the old folder it goes on from, with show folder and dismiss (and its light copy) |
| Permission asked of Tars | The question Claude Code would put to its permission dialog, asked of Tars by the state mod instead: the line a panel shows, with allow, deny with a reason and ask in terminal; a call too long for that line, shown whole in the panel before allow; the same question in full in the agent's window, with why Claude Code asks and the rule that asked under the call, and on its card; too late, when the question went back first (and its light copy) |

## The task banner above an agent's terminal

A task someone gives an agent (delegate_task, a chat, Tars, a channel) goes into the
agent's own terminal, the permanent one, and runs there as one of its turns. While the
agent works on such a task, a banner above its terminal says who gave it, since when,
its first line, how many tasks wait and from whom, and offers stop task. Built in 2.0.4
(`src/components/TaskBanner.tsx`) on the Dashboard's panel and in the agent's window;
the new interface's project page row is drawn and not built yet (listed at the end).
The first column names no route, so `npm run e2e:guard` does not read this table.

| Surface | Frames |
|---|---|
| The banner on the Dashboard's panel, in both shells: a task in hand with nothing waiting; two waiting, and the list the count opens; 660, 582 and 420 wide; the smallest pane, 3x3 in a 1200 by 800 window | `tars-redesign.pen`: Task banner · above the agent's terminal, Task banner · Dashboard, a panel on a given task |
| The agent's window: the banner over its terminal column | `tars-redesign.pen`: Task banner · above the agent's terminal |
| The agent's queue in the list the count opens, since 2.0.5: pause and resume, move to the head, cancel (asks once), drag before another; with nothing in hand and the queue kept paused (after a stop, after a restart), a strip in the banner's place. Without the queue's channel the list has no control | `tars-redesign.pen`: Agent queue (2.0.5) · in its panel (its light copy, the narrowest window), · in its panel · states (and its light copy) |
| The new interface's project page, which shows no terminal: the agent's row in the team carries the banner, with the senders of what waits on a third line (not built yet) | `tars-redesign.pen`: Task banner · new interface, the project page's team |

Each frame has its `· light` copy beside it. Task banner · notes, what the Backend
sends lists the fields, the push and the call the window needs from the main process.

## States every data surface must show

Loading (three stages: nothing under 400ms, skeleton, then a named slow
operation), empty, error, needs-sign-in, permission-denied.

## Motion

- Launch: mark, wordmark, boot steps, gateway handshake
- Page load: skeleton in the real shape of the content

## Drawn, not built yet

Frames of `design/tars-redesign.pen` for what the app does not render yet, in tokens only. Each has its main frames
dark and light, the narrowest window (1200 by 800), its states, and a notes frame saying what the Backend must
provide. Once a feature is built, its frames join the line of its page above, and a new section joins
`e2e/surfaces.mjs`.

For 2.0.4:
- Memory, one picture (Brain links to the Vault): Memory · one picture · Settings, Memory Backends, · Brain, Backends
  (each with its light copy, Settings at the narrowest window), · states (and its light copy), · notes for the Backend.
- Relay, one switch for every gateway Hermes has, a section under Settings, Hermes: Relay · Settings, Hermes · off,
  · turning on, · on, · could not turn on (off, on and could not turn on with their light copies, turning on at the
  narrowest window), · states (and its light copy), · notes for the Backend.
- Providers, one panel per CLI: Providers · one panel per CLI · Codex, · Claude Code (Codex with its light copy and at
  the narrowest window), · states (and its light copy), · notes for the Backend.
- The task banner on the new interface's project page, in the agent's row of the team: Task banner · new interface,
  the project page's team (and its light copy).

For 2.0.5:
- Review, a project added by hand whose folder is gone, said once with its removal asking once (the orchestrator's
  decision of 19/10): the old-shop row of Review · projects and their repositories (each of its copies) and the state
  "a project whose folder is gone: remove asks once" of Review · projects and their repositories · states (and its
  light copy). A state within frames built in 2.0.4, so the counts above stay as they are. Not built: the window is
  not told of such a project (fs:list-projects leaves it out), and the removal of a project known only from its
  agents' paths is not decided yet.
- File panel, opened from anywhere (a terminal, Brain, Review, the Vault): File panel (2.0.5) · opened from an agent's
  terminal (its light copy, the narrowest window), · states (and its light copy), · notes for the Backend.
- Connectors and Decisions, approved on 17/10: Decisions · waiting, rules and decided, Decisions · nothing waits,
  Connectors · in use, Connectors · a fresh install (each with its light copy), and the add flow: Connectors · add a
  server · a command (and its light copy), · the catalogue, · states (and its light copy), · notes for the Backend.
- Browser beside an agent's terminal: Browser (2.0.5) · beside an agent's terminal (its light copy, the narrowest
  window), · states (and its light copy), · notes for the Backend.
- The app's language: Language (2.0.5) · Settings, General, Preferences (and its light copy), · notes.
- Design Mode and the project's profiles in the browser beside an agent's terminal: Browser (2.0.5) · Design Mode, an
  element sent to the agent (its light copy, the narrowest window), · profiles and what Design Mode sends (and its
  light copy).
- The file panel's explorer with git colours, its editor that saves as you type, quick open and a file or picture
  dropped into a prompt: File panel (2.0.5) · explorer with git colours and the editor (its light copy, the narrowest
  window), · quick open and a file dropped into a prompt (and its light copy).
- Terminal splits and a search through the scrollback: Terminal splits (2.0.5) · free splits and a search through the
  scrollback (its light copy, the narrowest window).

For 2.0.6:
- The terminals left on this machine, a fifth figure of Heavy runs naming the machine's count in use, the ones Tars holds
  and the ones it has open, in the words of #553's answer and warning:
  Resources (2.0.6) · heavy runs, terminals left (its light copy, the narrowest window), · terminals left · states (and
  its light copy).
- An agent that cannot start for lack of a terminal, said on its pane and its card, its pane's menu offering start:
  Agent cannot start · no terminal left (2.0.6) (and its light copy).
- A project's MEMORY.md past what Claude Code reads, on Brain's Projects: Brain · Projects · MEMORY.md past what Claude
  Code reads (2.0.6) · states (and its light copy).
- A note among messages, and what the window shows of the other options: Messages (2.0.6) · a note, the waiting digest,
  both zones · what the window shows (and its light copy); in `chat-redesign-a.pen`, Chat · A · Room (2.0.6) · a note
  (and its light copy).
