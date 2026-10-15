import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { test } from '@playwright/test';

/**
 * What the sandboxed app has in it when we photograph it.
 *
 * The suite used to boot against an empty HOME, so every surface rendered its
 * own empty state. That is the least interesting version of each screen: an
 * empty list cannot show a status colour, a row rhythm, a truncation, or a
 * column that has more cards than fit. The screenshots were guarding almost
 * nothing, and they were no use as documentation either.
 *
 * The data below is fictional but shaped exactly like the real thing, so it
 * exercises the same code paths: several providers, every status, a worktree
 * branch, a long name that has to truncate, and one agent with an error.
 *
 * It is written into the sandbox HOME before Electron launches, which is the
 * only moment the app has not yet read it.
 */

const ISO = (daysAgo, hour = 12) => {
  // Fixed clock: a relative timestamp would make every screenshot differ from
  // the last run and the baselines would never settle.
  const base = Date.UTC(2026, 7, 20, hour, 0, 0);
  return new Date(base - daysAgo * 86_400_000).toISOString();
};

// Relative to the sandbox HOME. Absolute paths outside it are not ours to
// create - the first attempt used /Users/e2e and died on EACCES.
const REL_PROJECT = 'projects/tars';
const REL_SECOND = 'projects/1212-capital';
let PROJECT = REL_PROJECT;
let SECOND = REL_SECOND;

const AGENTS = [
  {
    id: 'a1', name: 'Orchestrator', character: 'wizard', provider: 'claude',
    model: 'claude-opus-5', status: 'running', role: 'orchestrator',
    orchestratorMode: true, projectPath: REL_PROJECT, effort: 'high',
    currentTask: 'delegate_task frontend « fix the scroll lock »',
    permissionMode: 'auto', skills: ['superpowers'],
  },
  {
    id: 'a2', name: 'Frontend Engineer', character: 'robot', provider: 'claude',
    model: 'claude-sonnet-5', status: 'waiting', role: 'worker',
    projectPath: REL_PROJECT, branchName: 'feat/frontend', worktreePath: true,
    currentTask: 'Apply patch to TerminalGrid.tsx', effort: 'medium',
  },
  {
    id: 'a3', name: 'Backend Engineer', character: 'robot', provider: 'codex',
    model: 'gpt-5.3-codex', status: 'running', role: 'worker',
    projectPath: REL_PROJECT, branchName: 'feat/backend', worktreePath: true,
    currentTask: 'npm run build', effort: 'medium',
  },
  {
    id: 'a4', name: 'QA', character: 'robot', provider: 'gemini',
    model: 'gemini-3-pro', status: 'idle', role: 'worker',
    projectPath: REL_PROJECT, branchName: 'feat/qa', effort: 'low',
  },
  {
    id: 'a5', name: 'Database migration and schema review', character: 'robot',
    provider: 'grok', model: 'grok-4.6', status: 'error', role: 'worker',
    projectPath: REL_SECOND, currentTask: 'ECONNREFUSED 127.0.0.1:5432', effort: 'medium',
  },
  {
    id: 'a6', name: 'Audit', character: 'robot', provider: 'deepseek',
    model: 'deepseek-chat', status: 'idle', role: 'worker',
    projectPath: REL_SECOND, effort: 'high',
  },
].map((a, i) => ({
  createdAt: ISO(6 - i),
  lastActivity: ISO(0, 9 + i),
  skills: [],
  ...a,
}));

/**
 * The port the sandbox's Hermes points at, and nothing listens on it.
 *
 * With no connection file the app falls back to `mode: 'local'` on Hermes's
 * default port, so the "sandbox" reached whatever was running on the machine
 * recording the baseline. On JeanBrasse's it was his real gateway, which answered
 * `Unauthorized`; elsewhere the connection is refused and the page prints
 * `socket hang up`. Same code, same seed, two different pictures, and the
 * Kanban surface failed or passed on which of them the run happened to get.
 *
 * Pointing it at a port nothing serves makes the refusal the same everywhere
 * and, more to the point, stops the sandbox from touching the machine at all.
 * 9 is `discard`: assigned, never served, and refused immediately.
 */
const HERMES_DEAD_PORT = 9;

/**
 * Where the sandbox looks for Ollama, and nothing listens there either.
 *
 * `ollama:test` falls back to `http://localhost:11434` when no base URL is set,
 * and the Settings page asks it: 88 connection attempts to that port left the
 * machine during a full run, measured on 2026-09-17. Whoever runs Ollama on
 * this machine answered them, which is somebody else's server in a picture that
 * is meant to be a sandbox. Same port as Hermes, for the same reason.
 */
const OLLAMA_DEAD_URL = `http://127.0.0.1:${HERMES_DEAD_PORT}`;

/**
 * The skills.sh listing, frozen, as that site serves it.
 *
 * `/skills` renders "live from skills.sh" and means it: the names, the order
 * and the install counts all come off a third party at the moment of the run,
 * so that baseline drifted whenever the catalogue did. Measured twice in one
 * night: 3649 pixels, then 3598, with nothing in this repo having changed.
 *
 * Shaped as the page rather than as the parsed result on purpose. The main
 * process fetches `https://skills.sh/` and scrapes `initialSkills` out of the
 * HTML, so a stub that returned the finished list would skip the scraping and
 * the formatting, which are the parts that can break. This goes in where the
 * network does, and everything downstream of it is the real code.
 */
const SKILLS_ROWS = [
  ['find-skills', 'vercel-labs/skills', 12_400],
  ['grill-me', 'mattpocock/skills', 9_800],
  ['frontend-design', 'vercel-labs/skills', 8_100],
  ['improve-codebase-architecture', 'mattpocock/skills', 7_700],
  ['agent-browser', 'vercel-labs/agent-browser', 6_200],
  ['setup-matt-pocock-skills', 'mattpocock/skills', 5_900],
  ['handoff', 'mattpocock/skills', 5_100],
  ['good-react-best-practices', 'vercel-labs/skills', 4_700],
  ['prototype', 'mattpocock/skills', 4_300],
  ['web-design-guidelines', 'vercel-labs/skills', 3_800],
  ['superpowers', 'obra/superpowers', 3_200],
  ['remember', 'cooper-labs-tech/Tars', 940],
];

/** One line, because the scraper's regex does not cross a newline. */
const SKILLS_SH_PAGE = `<!doctype html><html><body><script>window.initialSkills = ${
  JSON.stringify(SKILLS_ROWS.map(([name, source, installs]) => ({ source, name, installs })))
}</script></body></html>`;

/**
 * The skills.sh listing, answered from here instead of from the network.
 *
 * Stubbed in the main process rather than in the page, because that is where
 * the call is: in Electron the renderer asks over IPC precisely to avoid CORS,
 * so `page.route` sees nothing and a stub written there passes while the real
 * request goes out behind it. Measured, after writing that one first.
 *
 * Every suite that opens a page reaching skills.sh calls this. The sweep did
 * and no-horizontal-scroll.spec.ts did not, so it kept fetching the real
 * catalogue: two requests per run, seen leaving the machine by lsof on
 * 2026-09-17. Hermes is the other third party and is handled in the seed, by
 * pointing it at a port nothing serves.
 */
export async function stubSkillsSh(app) {
  await app.evaluate(async (_electron, html) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const url = String(input?.url ?? input);
      if (url.includes('skills.sh')) {
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return realFetch(input, init);
    });
  }, SKILLS_SH_PAGE);
}

/**
 * The sidebar's unread-release dot, in the one state the design draws.
 *
 * It is shown when the latest release id is above what localStorage remembers,
 * and the What's New page writes that number as it opens. So every surface
 * visited before What's New carried the dot and every surface after it did not,
 * which made a picture depend on the order of the run: the references of
 * `settings-ai-providers` and `settings-cli-paths` were recorded one at a time,
 * with a filter, and carried a dot a full run does not show. Worse, one failing
 * surface used to take the next thirty with it: Playwright stops the worker
 * after a failure, the app relaunches into a new sandbox with an empty profile,
 * the dot comes back, and every surface after that differs by the 264 pixels it
 * costs. Measured on 2026-09-17, 33 failures where 5 were real.
 *
 * Marked as seen before anything is photographed, so the dot is in no
 * reference: the frames in design/tars-redesign.pen draw that sidebar entry
 * without it (`Agents · dark`, `Settings · Git`, and the rest).
 */
export async function markWhatsNewSeen(page, key, lastSeen) {
  await page.addInitScript(([storageKey, value]) => {
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      // A profile with storage blocked shows the dot; the surface then fails
      // on it, which is the right way round.
    }
  }, [key, lastSeen]);
}

/**
 * A fixed day in the documents loaded under `route`, and in those alone.
 *
 * The Usage page counts its window back from today and prints it: the span
 * under TOTAL COST, the TODAY tile, the day under each bar. So its reference
 * moved every day with nothing in the app changed. A clock fixed for the whole
 * run would move every page that says how long ago something happened, so
 * this shifts Date in the documents of one route: each surface is a goto, a
 * new document, and the script looks at where it loaded. Time runs on from the
 * fixed instant, so nothing that waits on a timer stalls.
 */
export async function pinDayOn(page, route, day) {
  await page.addInitScript(([prefix, target]) => {
    if (!location.pathname.startsWith(prefix)) return;
    const RealDate = Date;
    const offset = target - RealDate.now();
    class PinnedDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(RealDate.now() + offset);
        else super(...args);
      }
      static now() {
        return RealDate.now() + offset;
      }
    }
    globalThis.Date = PinnedDate;
  }, [route, day]);
}

/**
 * Everything the page says went wrong, in one list.
 *
 * `pageerror` is an uncaught exception, and until 2026-09-17 that was all three
 * screenshot specs listened to. A page that logs an error without throwing one
 * was invisible to them: React logs the `<script>` in the root layout and every
 * hydration mismatch that way, and the sweep reported none of it. What is
 * tolerated is declared in KNOWN_PAGE_ERRORS, the same list for both kinds.
 */
export function listenForErrors(page, sink) {
  page.on('pageerror', error => sink.push(String(error)));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    const at = message.location();
    const where = at?.url ? ` [${at.url}:${at.lineNumber}]` : '';
    sink.push(`console.error: ${message.text()}${where}`);
  });
}

/**
 * Three more projects, and the agents that make their rooms exist.
 *
 * A room is derived, not stored: `listRooms` builds one per project path any
 * agent holds, so a room per state needs an agent per state. These are behind
 * the `chatRooms` flag rather than in the shared seed because adding six agents
 * and three projects to the sweep would move every other baseline in the suite.
 */
const REL_ATLAS = 'projects/atlas';
const REL_MERCURY = 'projects/mercury';
const REL_ORION = 'projects/orion';

const CHAT_AGENTS = [
  { id: 'c1', name: 'Atlas Writer', provider: 'claude', model: 'claude-sonnet-5', status: 'idle', rel: REL_ATLAS, effort: 'medium' },
  { id: 'c2', name: 'Atlas Reviewer', provider: 'claude', model: 'claude-opus-5', status: 'completed', rel: REL_ATLAS, effort: 'low' },
  { id: 'c3', name: 'Mercury Caretaker', provider: 'claude', model: 'claude-sonnet-5', status: 'idle', rel: REL_MERCURY, effort: 'low' },
  { id: 'c4', name: 'Orion Lead', provider: 'claude', model: 'claude-opus-5', status: 'running', rel: REL_ORION, effort: 'high' },
  { id: 'c5', name: 'Orion Second', provider: 'claude', model: 'claude-sonnet-5', status: 'running', rel: REL_ORION, effort: 'medium' },
].map((a, i) => ({
  character: 'robot', role: 'worker', skills: [],
  createdAt: ISO(5 - i), lastActivity: ISO(0, 10 + i),
  ...a,
}));

/**
 * The journal behind the five room states, written the way the bus writes one.
 *
 * Every state the Chat room can render came from code nobody had seen on a
 * screen: `delivered`, `dropped`, `bounded` and `superseded` had no data that
 * produced them. Each one is here, on the room whose frame is meant to show it.
 * The counters agree with the log rather than being set to a round number: the
 * bounded thread really does carry its ten agent messages.
 */
function chatJournal(paths) {
  const room = project => `project:${project}`;
  const msg = (id, roomId, threadId, authorKind, authorId, authorName, text, createdAt, mentions = []) =>
    ({ id, roomId, threadId, authorKind, authorId, authorName, text, mentions, createdAt });
  const delivered = (messageId, targetAgentId, at) =>
    ({ messageId, targetAgentId, state: 'delivered', queuedAt: at, deliveredAt: at });

  const messages = [];
  const threads = [];
  const deliveries = [];

  // tars: an exchange still running. One row of each live delivery state.
  const tars = room(paths.tars);
  threads.push({ id: 't-tars', roomId: tars, anchorMessageId: 'm-tars-1', state: 'open', round: 2, agentMessageCount: 2, openedAt: ISO(0, 9) });
  messages.push(
    msg('m-tars-1', tars, 't-tars', 'human', 'human', 'User', 'The scroll lock drops a line when a panel is resized. Take it between you.', ISO(0, 9), ['a1', 'a2']),
    msg('m-tars-2', tars, 't-tars', 'agent', 'a1', 'Orchestrator', 'It is in the fit handler: the resize runs before the row count has settled.', ISO(0, 10), ['a2']),
    msg('m-tars-3', tars, 't-tars', 'agent', 'a2', 'Frontend Engineer', 'Then I hold the write until the fit resolves, and add the test that caught it.', ISO(0, 11)),
  );
  deliveries.push(
    delivered('m-tars-1', 'a1', ISO(0, 9)),
    delivered('m-tars-2', 'a2', ISO(0, 10)),
    { messageId: 'm-tars-3', targetAgentId: 'a1', state: 'queued', queuedAt: ISO(0, 11) },
    {
      messageId: 'm-tars-3', targetAgentId: 'a3', state: 'not_sent', queuedAt: ISO(0, 11), refusedAt: ISO(0, 11),
      reasonCode: 'no_end_of_turn',
      reason: 'codex stays running until its process exits, so nothing can be delivered to it at rest',
    },
  );

  // 1212-capital: the bound reached, ten agent messages and no human since.
  const capital = room(paths.capital);
  threads.push({ id: 't-cap', roomId: capital, anchorMessageId: 'm-cap-0', state: 'bounded', round: 5, agentMessageCount: 10, openedAt: ISO(1, 14) });
  messages.push(msg('m-cap-0', capital, 't-cap', 'human', 'human', 'User', 'Why is the migration refusing the connection? Work it out between you.', ISO(1, 14), ['a5', 'a6']));
  const capitalTurns = [
    ['a5', 'Database migration and schema review', 'The socket is refused at 5432, so nothing of mine ever opened.', 'a6'],
    ['a6', 'Audit', 'The port is right. Check whether the server is listening on the socket file instead.', 'a5'],
    ['a5', 'Database migration and schema review', 'It is a unix socket, and the path in the config is the Homebrew one.', 'a6'],
    ['a6', 'Audit', 'Then the server here is the Postgres.app build, which puts its socket elsewhere.', 'a5'],
    ['a5', 'Database migration and schema review', 'Confirmed, two servers installed and the config names the one that is not running.', 'a6'],
    ['a6', 'Audit', 'Point the config at the running one rather than starting the other.', 'a5'],
    ['a5', 'Database migration and schema review', 'Done locally, the connection opens. I have not touched the committed config.', 'a6'],
    ['a6', 'Audit', 'Leave it uncommitted: that path is this machine, not the project.', 'a5'],
    ['a5', 'Database migration and schema review', 'Agreed. The migration runs clean against the local server now.', 'a6'],
    ['a6', 'Audit', 'Nothing left on my side. This needs the user to say which server the project assumes.', 'a5'],
  ];
  capitalTurns.forEach(([id, name, text, to], i) => {
    messages.push(msg(`m-cap-${i + 1}`, capital, 't-cap', 'agent', id, name, text, ISO(1, 15 + i), [to]));
    deliveries.push(delivered(`m-cap-${i + 1}`, to, ISO(1, 15 + i)));
  });

  // atlas: a room whose agents have all finished. Nothing is pending.
  const atlas = room(paths.atlas);
  threads.push({ id: 't-atlas', roomId: atlas, anchorMessageId: 'm-atlas-1', state: 'open', round: 1, agentMessageCount: 1, openedAt: ISO(2, 11) });
  messages.push(
    msg('m-atlas-1', atlas, 't-atlas', 'human', 'human', 'User', 'Read the onboarding copy and tell me what a new reader would not understand.', ISO(2, 11), ['c1']),
    msg('m-atlas-2', atlas, 't-atlas', 'agent', 'c1', 'Atlas Writer', 'Three paragraphs assume the reader already has an account. I have marked them.', ISO(2, 12)),
  );
  deliveries.push(delivered('m-atlas-1', 'c1', ISO(2, 11)));

  // orion: JeanBrasse stepped in. The old anchor is superseded and what it was still
  // holding was dropped, which is the pair of states nothing had produced.
  const orion = room(paths.orion);
  threads.push(
    { id: 't-orion-old', roomId: orion, anchorMessageId: 'm-orion-1', state: 'superseded', round: 1, agentMessageCount: 2, openedAt: ISO(0, 13) },
    { id: 't-orion-new', roomId: orion, anchorMessageId: 'm-orion-4', state: 'open', round: 1, agentMessageCount: 0, openedAt: ISO(0, 16) },
  );
  messages.push(
    msg('m-orion-1', orion, 't-orion-old', 'human', 'human', 'User', 'Pick the cache strategy for the feed and tell me which one you took.', ISO(0, 13), ['c4', 'c5']),
    msg('m-orion-2', orion, 't-orion-old', 'agent', 'c4', 'Orion Lead', 'I would cache per user, since the feed differs for everyone who reads it.', ISO(0, 14), ['c5']),
    msg('m-orion-3', orion, 't-orion-old', 'agent', 'c5', 'Orion Second', 'Per user multiplies the store by the user count. I would cache the parts instead.', ISO(0, 15), ['c4']),
    msg('m-orion-4', orion, 't-orion-new', 'human', 'human', 'User', 'Stop there, both of you. Cache the parts, and measure it before you tune it.', ISO(0, 16), ['c4', 'c5']),
  );
  deliveries.push(
    delivered('m-orion-2', 'c5', ISO(0, 14)),
    {
      messageId: 'm-orion-3', targetAgentId: 'c4', state: 'dropped', queuedAt: ISO(0, 15), refusedAt: ISO(0, 16),
      reasonCode: 'thread_replaced', reason: 'a newer message from the user replaced the exchange this was queued for',
    },
    { messageId: 'm-orion-4', targetAgentId: 'c4', state: 'queued', queuedAt: ISO(0, 16) },
    { messageId: 'm-orion-4', targetAgentId: 'c5', state: 'queued', queuedAt: ISO(0, 16) },
  );

  return {
    savedAt: ISO(0, 16),
    // mercury keeps its room and loses its members, which is the only way to
    // reach the empty room: the room exists because an agent names the project.
    memberOverrides: { [room(paths.mercury)]: [] },
    threads,
    messages,
    deliveries,
  };
}

/** Written before Electron starts, into the throwaway HOME the suite creates. */
export function seedSandbox(home, { chatRooms = false } = {}) {
  PROJECT = path.join(home, REL_PROJECT);
  SECOND = path.join(home, REL_SECOND);
  const dir = path.join(home, '.dorothy');
  fs.mkdirSync(dir, { recursive: true });

  const chatPaths = {
    tars: PROJECT,
    capital: SECOND,
    atlas: path.join(home, REL_ATLAS),
    mercury: path.join(home, REL_MERCURY),
    orion: path.join(home, REL_ORION),
  };

  const fakeCli = writeFakeCli(home);
  const agents = AGENTS.map(a => ({
    // Autostart runs these, and the machine's own claude, codex or gemini was
    // what it ran until 2026-09-23: an agent read `running` or `idle` in a
    // screenshot depending on what that CLI had done by then, and on which
    // version the machine had installed. See writeFakeCli.
    cliPath: fakeCli,
    ...a,
    projectPath: a.projectPath === REL_PROJECT ? PROJECT : SECOND,
    ...(a.worktreePath ? { worktreePath: path.join(PROJECT, '.worktrees', a.branchName) } : {}),
    // loadAgents clears currentSessionId on every launch and keeps this one,
    // so it is exactly what a panel reads right after a restart.
  }));
  if (chatRooms) {
    for (const a of CHAT_AGENTS) {
      const { rel, ...rest } = a;
      agents.push({ cliPath: fakeCli, ...rest, projectPath: path.join(home, rel) });
    }
  }
  fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(agents, null, 2));

  // Paths, as the app keeps them. It reads this file with
  // `parsed.filter(p => typeof p === 'string')` and writes back a plain array
  // of paths (readCustomProjects and writeCustomProjects, ipc-handlers.ts, and
  // listKnownProjectRoots in window-manager.ts reads it the same way), so the
  // `{ path, name }` objects seeded here until 2026-09-17 were dropped as they
  // were read: the Projects page said "No projects yet" in every run of the
  // suite, and the pickers on the other surfaces had nothing to offer either.
  const projects = [PROJECT, SECOND];
  if (chatRooms) projects.push(chatPaths.atlas, chatPaths.mercury, chatPaths.orion);
  fs.writeFileSync(path.join(dir, 'projects.json'), JSON.stringify(projects, null, 2));

  // Written for every sandbox, the chat rooms included: whatever
  // a suite photographs, none of it should depend on what happens to be
  // listening on this machine. loadAppSettings spreads this file over its
  // defaults, so naming two keys leaves every other default alone.
  fs.writeFileSync(
    path.join(dir, 'hermes-connection.json'),
    JSON.stringify({ mode: 'local', localPort: HERMES_DEAD_PORT, authMode: 'token' }, null, 2),
  );
  fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({
    ollamaBaseUrl: OLLAMA_DEAD_URL,
    // Nothing starts in the chat rooms sandbox, so the statuses on screen are
    // the ones seeded above: `all stopped` is a room
    // whose agents are idle, and autostart would run every one of them as a
    // real CLI and make that frame impossible. The sweep leaves it on, since a
    // Dashboard with no CLI running in it photographs nothing of what it is.
    ...(chatRooms ? { autoStartAgentsOnLaunch: false } : {}),
  }, null, 2));

  // The project directories have to exist: several handlers check before they
  // will show a project at all, and loadAgents marks an agent `pathMissing` -
  // which disables its Start button and prints "Path not found" on the card -
  // if its working directory is absent. Worktrees included, since that is the
  // path a worktree agent actually runs in.
  for (const dir of [PROJECT, SECOND]) fs.mkdirSync(dir, { recursive: true });
  for (const branch of ['feat/frontend', 'feat/backend']) {
    fs.mkdirSync(path.join(PROJECT, '.worktrees', branch), { recursive: true });
  }

  if (chatRooms) {
    for (const p of [chatPaths.atlas, chatPaths.mercury, chatPaths.orion]) fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bus.json'), JSON.stringify(chatJournal(chatPaths), null, 2));
  }
}

/** Where Electron keeps what it writes on its own, each asked of the running app. */
const ELECTRON_PATHS = ['home', 'appData', 'userData', 'sessionData', 'cache', 'logs', 'crashDumps'];

/**
 * The one way a spec starts the app: inside its sandbox, Chromium profile
 * included, or not at all.
 *
 * HOME moves ~/.dorothy and ~/.claude and nothing else. Electron finds its own
 * folders through macOS, which answers with the account's home whatever HOME
 * says, so a launch with HOME alone opened ~/Library/Application Support/tars.
 * On a case-insensitive disk that is the installed Tars's own profile, the same
 * inode as .../Tars. Measured on 2026-09-16 while JeanBrasse's app was running: a
 * probe launched with HOME alone reported every path under the account's own home, and
 * DevToolsActivePort in that profile was rewritten during an e2e run by the
 * debugging port Playwright opens. Every run until then could read and write
 * that app's local storage, cookies and IndexedDB.
 *
 * `--user-data-dir` moves the Chromium profile, and CFFIXED_USER_HOME moves
 * what macOS calls home, so application support, caches and logs follow. Then
 * the app is asked where each of those landed, and one outside the sandbox
 * closes it and fails the spec before a page is opened.
 *
 * DOROTHY_TAILSCALE_BIN names the sandbox's own `tailscale` (writeFakeTailscale),
 * unless the spec's env names another, or none with ''.
 */
export async function launchSandboxed(electron, sandboxHome, { env = {}, ...options } = {}) {
  const app = await electron.launch({
    ...options,
    args: ['.', `--user-data-dir=${path.join(sandboxHome, 'electron-profile')}`],
    env: { ...inheritable(process.env), DOROTHY_TAILSCALE_BIN: writeFakeTailscale(sandboxHome), ...env, HOME: sandboxHome, CFFIXED_USER_HOME: sandboxHome },
  });
  // What the app inherited, checked the way its folders are below: a run
  // started by an agent inside Tars carries that agent's CLAUDE_MGR_API_URL
  // (the live Tars, 31415) and its token, and handed them to the app until
  // 2026-09-23. Anything of that family the app holds now came from the spec,
  // or is the fixture's own DOROTHY_TAILSCALE_BIN.
  const leaked = await app.evaluate((_electron, { allowed, pattern }) => Object.keys(process.env)
    .filter(name => new RegExp(pattern).test(name) && !allowed.includes(name)), { allowed: [...Object.keys(env), 'DOROTHY_TAILSCALE_BIN'], pattern: LEAKY.source });
  if (leaked.length > 0) {
    await app.close();
    throw new Error(`the app inherited the caller's ${leaked.join(', ')}; launchSandboxed hands it nothing of that family`);
  }
  if (process.env.E2E_TRACE === 'on') await traceApp(app);
  const landed = await app.evaluate(({ app: running }, names) => Object.fromEntries(
    names.map(name => {
      try {
        return [name, running.getPath(name)];
      } catch (error) {
        return [name, `unavailable: ${error}`];
      }
    }),
  ), ELECTRON_PATHS);
  const roots = [sandboxHome, fs.realpathSync(sandboxHome)];
  const outside = Object.entries(landed)
    .filter(([, where]) => !roots.some(root => where === root || where.startsWith(root + path.sep)));
  if (outside.length > 0) {
    await app.close();
    throw new Error(
      `the app would have run outside its sandbox ${sandboxHome}:\n`
      + outside.map(([name, where]) => `  ${name}: ${where}`).join('\n'),
    );
  }
  return app;
}

/**
 * The environment the app is handed: the caller's, less what belongs to a Tars
 * that may be running the suite. An agent inside Tars carries CLAUDE_AGENT_ID,
 * CLAUDE_MGR_API_URL (the live Tars on 31415) and CLAUDE_MGR_API_TOKEN, and a
 * shell may carry DOROTHY_* or ANTHROPIC_* of its own; a spec that wants one
 * sets it in its env.
 */
const LEAKY = /^(CLAUDE|DOROTHY|ANTHROPIC)|^CLAUDECODE$/;
function inheritable(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !LEAKY.test(name)));
}

/**
 * The CLI the seeded agents run: it draws one fixed screen and holds the
 * terminal, with no model, no network and no hook, so an agent's status is
 * whatever the suite set and stays so. The machine's own claude, which the
 * sweep ran until 2026-09-23, registered its session within seconds and ran
 * the seeded task on whatever login the sandbox lacked: the Logs page, the
 * tray and Brain's project order came out `running` in one run and `idle`
 * in the next.
 */
function writeFakeCli(home) {
  const dir = path.join(home, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'fake-cli.cjs');
  fs.writeFileSync(file, [
    `#!${process.execPath}`,
    "process.stdout.write('\\x1b[2J\\x1b[Ha CLI of the E2E sandbox: no model, no network, no hook\\r\\n> ');",
    'process.stdin.resume();',
    '',
  ].join('\n'), { mode: 0o755 });
  return file;
}

/** The tailnet the sandbox's `tailscale` reports: a name no machine has, and the first address of the tailnet range. */
const FAKE_TAILNET = { name: 'tars-sandbox.example.ts.net', ip: '100.64.0.1' };

/**
 * The `tailscale` the Hermes page asks in the sandbox (DOROTHY_TAILSCALE_BIN,
 * #226): a running tailnet with `tailscale serve` on, the same answer every
 * run. Left to itself the page asked the Mac's own Tailscale, from PATH and
 * from two absolute paths no sandbox HOME hides, and settings-hermes.png
 * showed the MagicDNS name of the machine recording until a mask hid it.
 *
 * Running rather than none: with no tailnet, the Incoming webhook row shows
 * the local URL instead, and its port moves with E2E_PORT_OFFSET. A shell
 * script rather than node, so it answers well inside the page's 4 s timeout
 * on a loaded machine.
 */
function writeFakeTailscale(home) {
  const dir = path.join(home, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'fake-tailscale');
  const status = JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${FAKE_TAILNET.name}.`, TailscaleIPs: [FAKE_TAILNET.ip] } });
  fs.writeFileSync(file, [
    '#!/bin/sh',
    'case "$1" in',
    `  status) printf '%s\\n' '${status}' ;;`,
    `  serve) printf '%s\\n' 'https://${FAKE_TAILNET.name} (tailnet only)' ;;`,
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  return file;
}

/**
 * The statuses the sweep photographs: the four agents of the tars project
 * that the Dashboard starts are running, the two of 1212-capital idle. It is
 * what the references were recorded with, and loadAgents sets every agent
 * idle on launch, so the suite sets them once their CLIs hold their terminals.
 */
export const SWEEP_STATUSES = { a1: 'running', a2: 'running', a3: 'running', a4: 'running', a5: 'idle', a6: 'idle' };

/**
 * The folders a spec makes its sandbox in: os.tmpdir(), an agent's own TMPDIR
 * included; /tmp, where the chat rooms make theirs for the length of the path
 * their heads print; and macOS's own temporary folder, where the surfaces make
 * theirs for the same reason (#368).
 */
function sandboxRoots() {
  const roots = [os.tmpdir()];
  if (process.platform !== 'win32') roots.push('/tmp');
  if (process.platform === 'darwin') {
    try {
      roots.push(execFileSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).trim());
    } catch { /* not this Mac's: os.tmpdir() and /tmp stay */ }
  }
  return roots;
}

/**
 * Where a path lands, its links and its `..` resolved as the system does: for
 * a path that does not exist, where its nearest existing parent lands, and the
 * rest of the path.
 */
function landing(p) {
  try {
    return fs.realpathSync.native(p);
  } catch (error) {
    const parent = path.dirname(p);
    if (error.code !== 'ENOENT' || parent === p) throw error;
    return path.join(landing(parent), path.basename(p));
  }
}

/**
 * Removes a spec's sandbox HOME once its app has closed. A process the app
 * started can still be writing there: `amp --version`'s log, a hook's, and
 * until #383 a `claude auth status` that outlived the quit and wrote
 * .claude.json and its lock (QA, 2026-10-12). rmSync then meets ENOTEMPTY,
 * and its maxRetries do not help, since Node lists the folder once. This
 * removes again from a fresh listing, for up to 5 s, and says so on the run's
 * output when it had to: a writer that outlives the app is still a finding,
 * only no longer a red cleanup. The loop two specs and #382 each had a copy of.
 *
 * It removes only what lies strictly under one of `roots`, judged by where the
 * path lands through its links and its `..`, and refuses anything else, a root
 * included, before touching it: a wrong path fails its spec instead of
 * deleting (the Audit's L1 on #385). Tests: __tests__/e2e-remove-home.test.ts.
 */
export async function removeHome(dir, roots = sandboxRoots()) {
  const where = landing(dir);
  const real = roots.flatMap((root) => {
    try {
      return [fs.realpathSync.native(root)];
    } catch {
      return [];
    }
  });
  if (!real.some((root) => where.startsWith(root + path.sep))) {
    throw new Error(`removeHome: ${dir} is not inside a folder the specs make their sandboxes in (${real.join(', ')}): nothing was removed`);
  }
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (attempt > 1) console.warn(`[removeHome] ${dir} was written after its app closed: removed at try ${attempt}`);
      return;
    } catch (error) {
      if ((error.code !== 'ENOTEMPTY' && error.code !== 'EBUSY') || attempt === 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

/**
 * Waits until every agent to be shown running has its CLI in its terminal,
 * which is when autostart has done writing its status, then sets the
 * statuses on the app's own agent map and pushes a tick, as a hook would.
 */
export async function settleFleet(app, { cwd = process.cwd(), statuses = SWEEP_STATUSES, timeout = 90_000 } = {}) {
  const dist = path.resolve(cwd, 'electron', 'dist');
  const started = Object.keys(statuses).filter(id => statuses[id] === 'running');
  const deadline = Date.now() + timeout;
  for (;;) {
    const waiting = await app.evaluate((_electron, { dist, ids }) => {
      const req = process.mainModule.require;
      const { agents } = req(`${dist}/core/agent-manager.js`);
      const { ptyProcesses } = req(`${dist}/core/pty-manager.js`);
      const { cliRunningIn } = req(`${dist}/core/agent-pty.js`);
      return ids.filter(id => {
        const agent = agents.get(id);
        return !(agent?.ptyId && cliRunningIn(ptyProcesses.get(agent.ptyId)));
      });
    }, { dist, ids: started });
    if (waiting.length === 0) break;
    if (Date.now() > deadline) throw new Error(`no CLI in the terminal of ${waiting.join(', ')} after ${timeout} ms`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await app.evaluate((_electron, { dist, statuses }) => {
    const req = process.mainModule.require;
    const { agents } = req(`${dist}/core/agent-manager.js`);
    for (const [id, status] of Object.entries(statuses)) {
      const agent = agents.get(id);
      if (agent) agent.status = status;
    }
    req(`${dist}/utils/agents-tick.js`).scheduleTick();
  }, { dist, statuses });
}

/**
 * The artefact of an E2E run, beside Playwright's own: the values a test
 * asserted, merged into values.json, and a screenshot per step, both in the
 * test's output folder, which is inside the run directory.
 */
export function recordValues(values) {
  const file = test.info().outputPath('values.json');
  const kept = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  fs.writeFileSync(file, JSON.stringify({ ...kept, ...values }, null, 2));
}

export async function stepShot(page, name) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

/**
 * With E2E_TRACE=on, the app's own trace: its pages, clicks, DOM snapshots and
 * screenshots, saved as app-trace.zip in the test's output folder when the app
 * closes. Playwright's --trace records the runner's steps only: for an app
 * started by _electron.launch its trace.zip held "Launch electron" and the
 * hooks, 14 KB, and nothing of what the app did (measured 2026-09-23).
 */
async function traceApp(app) {
  // A script that launches the app outside a test (e2e/new-interface-pictures.mjs) has no test, so no output folder
  // to save a trace in: test.info() threw at its close, before the trace was even stopped. No trace there.
  if (!inTest()) return;
  const context = app.context();
  await context.tracing.start({ screenshots: true, snapshots: true });
  const close = app.close.bind(app);
  app.close = async () => {
    try {
      await context.tracing.stop({ path: test.info().outputPath('app-trace.zip') });
    } catch (error) {
      // A spec that keeps its own trace (left-fullscreen.live.spec.ts) stops the context's tracing first and saves
      // it where it wants: there is nothing left to save here, and nothing was lost (#366's Info).
      if (!/Must start tracing before stopping/.test(String(error))) console.warn('[e2e] the app trace could not be saved:', error);
    }
    return close();
  };
}

/** Whether a Playwright test is running: test.info() throws outside one. */
function inTest() {
  try {
    test.info();
    return true;
  } catch {
    return false;
  }
}
