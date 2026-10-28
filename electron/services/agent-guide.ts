/**
 * How Tars works, for an agent: the one source of it.
 *
 * Every agent learns the app from the Tars that runs it. Its identity block
 * (the bootstrap, the prompt of a CLI without Claude's SessionStart hook)
 * carries the short section identitySection writes,
 * for its role, and the tars_guide tool of mcp-orchestrator reads the topics
 * below through GET /api/guide, stamped with this Tars's version. Nothing
 * else explains the app to an agent: an orchestrator of another project once
 * believed delegate_task honoured a per-task model before it did, no agent
 * had ever filed a kanban task, and scripts were kept in temporary folders
 * that a session's end wipes, or under ~/Documents, which iCloud evicts.
 *
 * TOOL_TOPIC names a topic for every tool an agent can see, across the
 * bundled MCP servers; __tests__/electron/services/agent-guide.test.ts fails
 * when a server gains a tool the guide does not know, or the guide names one
 * no server has. A tool is named in a topic's text between backticks.
 */

import type { AgentStatus } from '../types';
import { hasOrchestratorPowers } from '../core/agent-role';
import { ensureProjectFiles } from '../utils/project-files';
import { needsPromptInjection } from './memory-hub';

export type GuideRole = 'orchestrator' | 'worker';

export interface GuideTopic {
  id: string;
  title: string;
  /** The roles whose identity section points at it. */
  roles: readonly GuideRole[];
  /** `{folder}` is the agent's project folder. */
  text: string;
}

export const GUIDE_TOPICS: readonly GuideTopic[] = [
  {
    id: 'delegation',
    title: 'Delegating and following a long run',
    roles: ['orchestrator'],
    text: [
      'You delegate to the agents of your own project: `list_agents` shows them, `whoami` shows you. Another project is refused unless the tool takes allowCrossProject and you set it.',
      'Write every task you hand as a spec in five parts, each on a line of its own. Target: what must be true when it is done. Change: what to do to get there. Constraints: what must not break or change, and the rules that hold. May touch: the files, folders, branches and tools the agent may use, and nothing else. Proof: the observable check of acceptance, which the agent runs and reports (a command and its expected output, a test that turns green, a file or a page to look at). A task with no proof cannot be accepted: you would have nothing to check its answer against.',
      '`delegate_task` is the way to hand work: the task goes into the agent\'s own terminal, the session its card shows, which keeps its conversation, its memory and its background work. With no CLI running there, Tars starts that session on its conversation, with the task. No temporary copy of the agent is ever made. Tars answers at once with a taskId, and the tool follows the task in steps of two minutes.',
      'You get back the agent\'s full final message for the task, why it ended (completed, error, stopped, interrupted), and its tokens and cost. That is read from the session itself, and only where its CLI lets Tars read it: claude (and the API-key providers that run it) and Qwen Code give all of it, from their hooks and their transcript. codex and pi give their final message and why it ended, from their own session log, but not their tokens or cost. gemini gives its final message when its turn ends, cut at 4000 bytes, without tokens or cost. opencode, amp and grok give Tars no prompt hook: the task goes into their terminal, in their interactive session, which stays after it (opencode started with it as its first prompt, amp with it typed in), and the tool says it was delivered, with no answer, tokens or cost. Read their terminal with `get_agent_output`, or ask them to report with send_message to "requester".',
      'A task you delegate runs in the permission mode of the agent that receives it, whatever yours: from a sender in a narrower mode (plan, say) it arrives marked so, "(sender in plan mode, you in bypass mode)", which asks that agent and does not bind it. Delegate to an agent whose own mode fits the work.',
      'One task at a time: an agent at work (a task in hand, or a turn in its terminal, which counts only on a CLI that tells Tars its turns end: not amp, grok or opencode) gets the task queued, and delegate_task keeps waiting and returns its real result, or says which task it waits behind, from whom and since when. When the answer says it is queued, follow it with `task_status` by its id, not `wait_for_agent`, which follows the task the agent works on now. A task still queued when Tars restarts is lost and never ran: ask for it again.',
      'timeoutSeconds is how long the tool waits: 3600 s (an hour) when you give none. The task is never stopped there: it goes on in the agent\'s terminal, and `task_status` reads its end later.',
      'If delegate_task says the task may still be working (Tars was out of reach for a while), do not send it again: read it with `task_status`, by its taskId or its clientRequestId. A task still waiting its turn can be taken back with `task_cancel`.',
      'What waits for an agent is its queue: `agent_queue` reads it in order and pauses or resumes it, `task_move` puts an item first or before another, `task_cancel` takes one back. A stop keeps the queue, paused (`stop_agent` with dropQueue drops it), and so does a restart of Tars: resume it when it should go in.',
      'A `model` given to delegate_task applies only when Tars starts the agent\'s session for the task; an open session keeps its own, and the answer says so.',
      '`start_agent` is deprecated: it hands the task the same way and answers with its taskId without waiting. Use delegate_task. `wait_for_agent` waits on an agent\'s status, `get_agent_output` reads its terminal, `get_agent` gives its whole record.',
      '`create_agent` adds an agent to your project, on any provider; `stop_agent` stops one with a reason the user reads; `remove_agent` deletes one for good.',
      '`update_agent` changes one of your agents afterwards (name, provider, model, effort, permission mode, CLI path, skills), never its role, and never your own settings: those stay the user\'s, in the Agents page. A running turn is never cut: a new model or effort restarts a claude agent once its turn ends, on the same conversation, and another CLI takes it at its next start; a new provider or CLI path waits until you stop the agent with `stop_agent` (cli_running until then), and its next start is on a new conversation. The answer says when the change applies.',
      'An orchestrator does not edit files: its sessions are denied the editing tools. It splits the work, delegates, and reports.',
    ].join('\n'),
  },
  {
    id: 'messages',
    title: 'Messages and their modes',
    roles: ['orchestrator', 'worker'],
    text: [
      '`checkpoint` writes one line about yourself, 120 characters at most: where you stand in the task in hand (tests written, 3 of 5 green). Tars keeps it with you and shows it on your card, and whoever follows your task reads it in task_status, list_agents and get_agent. A new line replaces the last: write one at a step worth knowing, not at every action.',
      '`send_message` writes to an agent by id. To answer whoever asked you for your current task, send it to "requester": a chat of the project may have asked, not only the orchestrator.',
      'A task handed to you with delegate_task is typed into your own terminal, after a line naming who gave it and its task id. Your final message when your turn ends is the answer they get back, in full: put the result there.',
      'Its mode says how it goes in: auto (the default, typed at once, into a running turn too), queue (typed once the agent\'s turn ends), steer (its turn interrupted first; claude agents only), restart (the agent stopped and started again with the message). steer and restart are refused while the agent works on a task another agent asked for.',
      'A worker hands no work to another agent and stops none: start_agent, delegate_task, steer, restart, stop_agent, remove_agent and assign_task for another agent are refused to it (worker_may_not_order, worker_may_not_stop): it asks its orchestrator. Its send_message to another worker, in auto or queue mode, arrives as a note for information, labelled `[Note for information from "<name>", a worker: it is not a task, ...]`, typed once that agent\'s delegated task ends, and its turn too on a CLI that tells Tars its turns end, never as a task; an agent with no session open gets nothing, and the answer says so (note_needs_session). Its report to whoever leads it goes in as a report.',
      'Your project has a room: `room_read` reads what was said, `room_post` says something to the team when you have a result, a blocker or an answer. Do not post to acknowledge or to say you are starting.',
      'An agent that runs a chat may see the project\'s other chats with `chat_list`, read only, when the user allowed it.',
    ].join('\n'),
  },
  {
    id: 'held-and-refused',
    title: 'Held and refused messages',
    roles: ['orchestrator', 'worker'],
    text: [
      'HELD means your message waits for the agent\'s terminal (its input field is in use, or a dialog is open) and has not been typed in yet. It goes in by itself once the field is free, and Tars tells you again if it still waits a few minutes on. Do not send it a second time.',
      'A refusal says why, often with a code: an agent of another project, a mode the agent cannot take (not_steerable), an agent busy on a task another chat or agent asked for (worker_busy_for_other_chat, worker_busy_for_other_requester), an agent at work that a call which cannot wait would open a second session beside (agent_busy: send it with delegate_task or start_agent, which wait their turn), a worker ordering or stopping another agent (worker_may_not_order, worker_may_not_stop), a note to an agent with no session (note_needs_session), a clientRequestId already used for something else. Act on the reason; a retry of the same call gets the same answer.',
      'QUEUED is no refusal: the task waits behind the agent\'s current task (the answer says which, from whom, since when) and starts once the agent is free; follow it with task_status by its id. "cancelled while it waited" and "never started" mean it did not run. A task still waiting its turn when Tars restarts is lost, never started: ask for it again. "No agent holds a task" means it ended, or was never asked.',
      'A message sent twice with the same clientRequestId is answered from the first one\'s receipt: nothing is typed twice.',
    ].join('\n'),
  },
  {
    id: 'kanban',
    title: 'The kanban',
    roles: ['orchestrator', 'worker'],
    text: [
      'The board is Hermes\'s, shown on the Kanban page of Tars: one space per project, one lane per agent. The kanban tools reach it through Tars, for your project only.',
      'File a task with `create_task` when there is work nobody holds yet: a follow-up you found, a defect outside your task, something the user should decide. It arrives parked in the backlog, where Hermes never starts it; its description says it is Tars\'s agents\', for whoever opens it.',
      'Claim a task with `assign_task` before you work on it (one at a time); report with `update_task_progress`; finish it with `mark_task_done` and a one to three sentence summary. `move_task` moves a task you hold between backlog, ongoing and done; planned is the user\'s: it hands a task to Hermes, and only the user does that. `list_tasks` and `get_task` read the board; `delete_task` removes a task you filed by mistake.',
      'On a Hermes whose version Tars has not measured, a task you claim stays `scheduled` on Hermes (`list_tasks` shows it ongoing, Hermes: scheduled): it is yours all the same, and `mark_task_done` finishes it.',
      'An orchestrator files the work it splits, so the user sees it on the board, and its workers claim and finish their own.',
      'When Hermes is not configured, refuses or cannot be reached, or Tars is signed out of it ("Tars is signed out of Hermes: sign in again in Settings, Hermes."), the tool says so and what was written: the user connects or signs in to Hermes in Tars (Settings, Hermes). Tell the user or your requester once, keep the task in your project folder\'s reports/, and go on with the work; do not call the tool again in a loop.',
      'A claim or a release whose answer says its note could not be written on the board still stood: the task moved, so do not do it again.',
      'When the error names a task that was created, or says Hermes may have done what you asked before its answer was lost, read the board (`get_task`, `list_tasks`) before writing again: never create a task twice.',
    ].join('\n'),
  },
  {
    id: 'project-folder',
    title: 'Your project folder',
    roles: ['orchestrator', 'worker'],
    text: [
      'Tars keeps a folder for your project, outside the repository: {folder}',
      'tools/ for scripts and benches worth running again, reports/ for what you hand over and what the next session should know. The user reads and edits both in Tars\'s Vault. Every agent of the project shares it, and Tars never deletes it.',
      'Durable files go there: never create folders at the top of your home folder. Keep nothing there that belongs in the repository, and nothing secret.',
      'Your temporary folder ($TMPDIR) is scratch: a session or a cleanup can empty it. Do not keep work under ~/Documents either: it can be evicted to the cloud and a read then blocks.',
    ].join('\n'),
  },
  {
    id: 'asking-the-user',
    title: 'Asking the user',
    roles: ['orchestrator', 'worker'],
    text: [
      'A worker asks its requester, not the user: end your turn with the question in your report, or `send_message` to "requester".',
      'An orchestrator asks the user with `ask_user`, from its terminal: Tars sends the question to their Telegram through their Hermes, which takes the relay to Hermes on (Settings, Hermes), and the tool returns at once. Their answer is typed into your terminal later, after the line "Message from the user via Telegram:". Do not wait for it in a loop: go on with other work, or end your turn.',
      'A request that came from Telegram, Slack or Discord is answered there: `send_telegram`, `send_slack`, `send_discord`. With the relay on, `send_telegram` goes to the user through Hermes and the file tools are gone; with it off, files go with `send_telegram_document`, `send_telegram_photo`, `send_telegram_video`.',
      'Ask only what you cannot decide: otherwise decide, say what you assumed, and go on.',
    ].join('\n'),
  },
  {
    id: 'memory-and-vault',
    title: 'Memory and the vault',
    roles: ['orchestrator', 'worker'],
    text: [
      '`memory_search` searches what the team remembers: the project\'s memory notes and the memory backends the user connected; `memory_read` returns the project\'s whole digest (its memory notes, the recent activity of other sessions, the Hermes memory), `memory_write` records a fact, `memory_sources` lists where memory comes from.',
      'The vault holds documents the whole fleet shares, by folder: `vault_list_folders`, `vault_create_folder`, `vault_delete_folder`, `vault_list_documents`, `vault_search`, `vault_get_document`, `vault_create_document`, `vault_update_document`, `vault_delete_document`, `vault_attach_file`.',
    ].join('\n'),
  },
  {
    id: 'social',
    title: 'X and Twitter tools',
    roles: [],
    text: [
      'With the keys set in Tars\'s Settings: `x_post_tweet`, `x_reply_tweet` and `x_delete_tweet` post as the user\'s account; `twitter_search`, `twitter_get_tweet`, `twitter_get_tweet_comments`, `twitter_get_user` and `twitter_get_user_tweets` read. Posting speaks for the user in public: only when the task says so.',
    ].join('\n'),
  },
  {
    id: 'limits',
    title: 'Limits worth knowing',
    roles: ['orchestrator', 'worker'],
    text: [
      'A delegated task ends with your turn: your final message then is its answer. Your session and its background work go on, but whoever gave you the task is told it is done: wait for the builds and tests you started before you answer.',
      'Your identity, your team and your project come from Tars and are current as of your session\'s start: `whoami` reads them again.',
      'You act in your own project. Tools that act on another project refuse unless they take allowCrossProject.',
      'An agent sleeps after 30 minutes without a turn; a message or a task wakes it.',
      'What you start carries your agent id in its environment (CLAUDE_AGENT_ID), detached or not. When you are stopped, Tars ends all of it by its PID, an ansible run and a `fly ssh` session excepted; a sleep waits while any of it runs outside your terminal. Label each Docker container you start, `docker run --label tars.agent=$CLAUDE_AGENT_ID` (`labels: [tars.agent=...]` in a compose file), so that it is stopped with you. What runs on with no session of yours is reported to your orchestrator after an hour, never ended.',
      'A disk short of space: `disk_scan` lists what Tars\'s disk janitor would propose to delete, by rule. Only the user approves a deletion, in Tars\'s window: never delete those yourself.',
      '`tars_guide` with no topic lists the topics; with one, returns it. The guide is the one of the Tars that runs you.',
    ].join('\n'),
  },
  {
    id: 'heavy-runs',
    title: 'Heavy runs: one slot for the whole machine',
    roles: ['orchestrator', 'worker'],
    text: [
      'Test suites, builds, Docker and simulators take the machine\'s heavy-run slot first: every project\'s agents share it, one run at a time unless the user set more. A dev server started on its own does not take it (it would hold the only slot for hours); one a test run starts is inside that run.',
      'For one command: `tars-slot run --label "<what>" -- <command>` in your terminal waits for the slot, runs the command, gives it back and exits with its code; git hooks and scripts use it too, as `"$TARS_SLOT" run ...`, which needs no PATH (a login shell may set PATH anew). `tars-slot take`, from a script that runs the steps itself, holds it across them (until the script ends or `tars-slot give-back <ticket>`); from your own Bash tool its lease ends with that one command. `tars-slot status` shows the queue.',
      'From a tool: `heavy_slot_take` (then `heavy_slot_give_back` when the run is over; Tars gives it back when your turn ends, and the owner can from the window), `heavy_slot_status` for who holds it and who waits.',
      'The queue: gate (a release gate, orchestrators only), then normal, then background, then arrival. A run started from inside your own run (a pre-push hook) is granted at once. A grant waits while free disk or memory is under the floor, and says so.',
      'During a run Tars tells you, your orchestrator and the window when the disk fills or the swap grows fast. Tars never stops a run itself: you decide.',
    ].join('\n'),
  },
];

/** The topic that explains each tool an agent can see. */
export const TOOL_TOPIC: Readonly<Record<string, string>> = {
  // mcp-orchestrator
  disk_scan: 'limits',
  whoami: 'limits',
  list_agents: 'delegation',
  get_agent: 'delegation',
  get_agent_output: 'delegation',
  create_agent: 'delegation',
  update_agent: 'delegation',
  start_agent: 'delegation',
  stop_agent: 'delegation',
  remove_agent: 'delegation',
  wait_for_agent: 'delegation',
  delegate_task: 'delegation',
  task_status: 'delegation',
  task_cancel: 'delegation',
  agent_queue: 'delegation',
  task_move: 'delegation',
  send_message: 'messages',
  checkpoint: 'messages',
  room_post: 'messages',
  room_read: 'messages',
  chat_list: 'messages',
  ask_user: 'asking-the-user',
  send_telegram: 'asking-the-user',
  send_slack: 'asking-the-user',
  send_discord: 'asking-the-user',
  tars_guide: 'limits',
  heavy_slot_take: 'heavy-runs',
  heavy_slot_give_back: 'heavy-runs',
  heavy_slot_status: 'heavy-runs',
  // mcp-telegram
  send_telegram_document: 'asking-the-user',
  send_telegram_photo: 'asking-the-user',
  send_telegram_video: 'asking-the-user',
  // mcp-kanban
  list_tasks: 'kanban',
  get_task: 'kanban',
  create_task: 'kanban',
  update_task_progress: 'kanban',
  mark_task_done: 'kanban',
  move_task: 'kanban',
  delete_task: 'kanban',
  assign_task: 'kanban',
  // mcp-memory
  memory_search: 'memory-and-vault',
  memory_read: 'memory-and-vault',
  memory_write: 'memory-and-vault',
  memory_sources: 'memory-and-vault',
  // mcp-vault
  vault_attach_file: 'memory-and-vault',
  vault_create_document: 'memory-and-vault',
  vault_create_folder: 'memory-and-vault',
  vault_delete_document: 'memory-and-vault',
  vault_delete_folder: 'memory-and-vault',
  vault_get_document: 'memory-and-vault',
  vault_list_documents: 'memory-and-vault',
  vault_list_folders: 'memory-and-vault',
  vault_search: 'memory-and-vault',
  vault_update_document: 'memory-and-vault',
  // mcp-socialdata, mcp-x
  twitter_get_tweet: 'social',
  twitter_get_tweet_comments: 'social',
  twitter_get_user: 'social',
  twitter_get_user_tweets: 'social',
  twitter_search: 'social',
  x_delete_tweet: 'social',
  x_post_tweet: 'social',
  x_reply_tweet: 'social',
};

/** The tools a topic's text names, between backticks. */
export function toolsNamedIn(text: string): string[] {
  return [...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map(m => m[1]);
}

/** Why a project has no folder, when nobody said: the one reason a path alone gives. */
const NOT_ABSOLUTE = 'its path is not absolute';

const withFolder = (text: string, folder: string | null, why?: string) =>
  text.replace(/\{folder\}/g, folder ?? `(none: ${why ?? NOT_ABSOLUTE})`);

/** The list of topics, as tars_guide gives it without one. */
export function guideIndex(version: string): string {
  return [
    `Tars ${version}, the guide for agents. Topics (tars_guide with topic: "<id>"):`,
    ...GUIDE_TOPICS.map(t => `- ${t.id}: ${t.title}`),
  ].join('\n');
}

/** One topic, stamped with the version; null for a topic that does not exist. `why`: the project has no folder. */
export function guideTopic(id: string, version: string, folder: string | null, why?: string): string | null {
  const topic = GUIDE_TOPICS.find(t => t.id === id.trim().toLowerCase());
  if (!topic) return null;
  return `Tars ${version}, ${topic.title}\n\n${withFolder(topic.text, folder, why)}`;
}

/**
 * The section of an agent's identity block: what its role uses, its project
 * folder, and where the details are. Kept to a few lines on purpose: every
 * session of every agent carries it.
 */
export function identitySection(role: GuideRole, folder: string | null, why?: string): string[] {
  const where = folder
    ? `- Your project folder, kept by Tars outside the repository: ${folder} (tools/, reports/). Keep scripts and reports worth keeping there, never in a temporary folder, under ~/Documents or in a folder you create at the top of your home folder.`
    : `- Your project has no folder kept by Tars (${why ?? NOT_ABSOLUTE}): keep what must last in the repository or ask your requester.`;
  const lines = [`## How Tars works`];
  if (role === 'orchestrator') {
    lines.push(
      `- Write each task as a spec, a line each. Target: the end state. Change: what to do. Constraints: what must not break. May touch: the files, folders and tools allowed. Proof: the observable check of acceptance. tars_guide delegation says more.`,
      `- delegate_task hands a task to the agent's own terminal and returns its full final answer, tokens and cost (claude, Qwen Code; codex, pi, gemini: the answer only; opencode, amp, grok: delivered only). timeoutSeconds is how long it waits: 3600 s when you give none; the task is never stopped there. If it says the task may still be working, read it with task_status: never send it twice. start_agent is deprecated.`,
      `- send_message modes: auto, queue, steer, restart. HELD means it waits for the terminal and goes in by itself.`,
      `- The kanban is the project's Hermes board (one lane per agent): file the work you split with create_task, so the user sees it.`,
      `- ask_user puts a question to the user from your terminal and returns at once: their answer is typed in later. Do not wait for it.`,
    );
  } else {
    lines.push(
      `- Answer whoever asked you with send_message to "requester", or in your final report. HELD means your message waits for the terminal and goes in by itself.`,
      `- You hand no work to another agent and stop none: ask your orchestrator (send_message to "orchestrator"). What you send another worker is a note for information.`,
      `- The kanban is the project's Hermes board (one lane per agent): claim a task with assign_task, finish it with mark_task_done, file a follow-up you find with create_task.`,
    );
  }
  lines.push(
    where,
    `- When Hermes refuses or cannot be reached, the user signs in to it in Tars (Settings, Hermes): say so once and go on.`,
    `- tars_guide gives the details: delegation, messages, held-and-refused, kanban, project-folder, asking-the-user, limits.`,
  );
  return lines;
}

/**
 * An agent's section, as every session gets it: the bootstrap of a terminal
 * with Claude's SessionStart hook, the prompt of a CLI without it, and the
 * prompt of a run over ACP. Its role is the one its launches read (an
 * orchestrator, or a chat's runner: core/agent-role.ts), and its project's
 * folder is made here if it is not there yet.
 */
export function agentGuideSection(agent: AgentStatus): string {
  const role: GuideRole = hasOrchestratorPowers(agent) ? 'orchestrator' : 'worker';
  const folder = ensureProjectFiles(agent.projectPath);
  return identitySection(role, folder.dir, folder.why).join('\n');
}

/**
 * Who the agent is, in Tars's identity line, as spawnAgentSession's header
 * begins it: what a CLI with no bootstrap to tell it learns first, and the line
 * a codex session is bound to its agent by (services/codex-sessions.ts, the
 * Audit's M1 on #465).
 */
export function identityLine(agent: AgentStatus): string {
  const role = agent.kind === 'chat' ? 'orchestrator' : agent.role || 'worker';
  return `[Tars: you are agent "${agent.name || agent.id}" (id ${agent.id}), ${role} of project ${agent.projectPath}.]`;
}

/**
 * The section for the prompt a session starts on, once: a CLI whose config
 * folder is not Claude's has no SessionStart hook to fetch the bootstrap, so
 * it gets it here, after the agent's identity line; a claude CLI, in a
 * terminal or over ACP, gets it from its bootstrap, and nothing here. Every
 * launch that builds a CLI's first prompt reads it: spawnAgentSession (whose
 * own header says who the agent is, `identity: false`), the window's (Start, a
 * wake, a restart), the bots', and a run over ACP.
 */
export function guideForPrompt(agent: AgentStatus, providerConfigDir: string, opts: { identity?: boolean } = {}): string {
  if (!needsPromptInjection(providerConfigDir)) return '';
  const section = agentGuideSection(agent);
  return opts.identity === false ? section : `${identityLine(agent)}\n\n${section}`;
}
