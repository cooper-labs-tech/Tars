// Manifeste exécutable des surfaces de l'app — la contrepartie vivante de
// design/UI-INVENTORY.md. Chaque entrée est ouverte dans la VRAIE app Electron
// par e2e/surfaces.spec.ts, photographiée, et comparée à sa référence.
// `check-coverage.mjs` échoue si une page de l'inventaire manque ici.

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * @typedef {Object} Surface
 * @property {string} name    identifiant stable (nom du screenshot)
 * @property {string} route   route Next à charger
 * @property {string=} clickText   texte d'un bouton à cliquer après chargement (ouvre un overlay)
 * @property {string=} clickText2  second clic (navigation dans l'overlay)
 * @property {string=} clickRole   rôle ARIA du premier clic : à préciser quand le même texte existe ailleurs dans la page (la barre latérale, par exemple)
 * @property {number=} settle      ms d'attente avant screenshot (défaut 900)
 * @property {string=} within      nom d'un panneau : clickText est cherché dans son en-tête
 * @property {string=} shows       texte que la vue doit afficher avant la capture
 */

/** @type {Surface[]} */
export const PAGES = [
  { name: 'dashboard', route: '/' },
  // The room list counts the agents the sweep launches as it starts, and chat
  // is the second surface visited: waiting lets those counts settle. Better
  // than masking the list: a masked panel is a pink rectangle in the baseline
  // and no coverage at all.
  { name: 'chat', route: '/chat', settle: 3000 },
  { name: 'agents', route: '/agents' },
  { name: 'kanban', route: '/kanban' },
  { name: 'vault', route: '/vault' },
  { name: 'projects', route: '/projects' },
  { name: 'extensions-skills', route: '/skills' },
  { name: 'extensions-plugins', route: '/skills', clickText: 'Plugins', settle: 1500 },
  { name: 'crons', route: '/crons' },
  { name: 'review', route: '/review' },
  { name: 'logs', route: '/logs', settle: 3000 },
  { name: 'usage', route: '/usage' },
  // The three tabs of Brain, clicked by role rather than by text. Measured on
  // 2026-09-17: `Projects` and `Agents` are sidebar links as well as tabs here,
  // the sidebar comes first in the DOM, and the click landed there. So
  // `brain-projects` photographed the Projects page, pixel for pixel the same
  // as the `projects` surface, and `brain-agents` had no click at all and
  // photographed whatever tab opens first, which is Projects. The Agents graph
  // was in the inventory, in this manifest and in no picture at all.
  { name: 'brain-agents', route: '/memory', clickText: 'Agents', clickRole: 'radio' },
  { name: 'brain-projects', route: '/memory', clickText: 'Projects', clickRole: 'radio' },
  { name: 'brain-backends', route: '/memory', clickText: 'Backends', clickRole: 'radio' },
  { name: 'whats-new', route: '/whats-new' },
  { name: 'settings-general', route: '/settings' },
  // The menu-bar popover, listed in the inventory since the redesign and
  // automated by nobody: the guard read its route list from a hand-written
  // copy, so this one sat outside every check. It carries a terminal, which
  // the sweep masks like any other.
  { name: 'tray-panel', route: '/tray-panel', settle: 2000 },
];

// Les 17 sections de Settings. Depuis le regroupement, chaque section est un
// groupe cliqué puis son enfant : le nom de surface reste celui d'avant pour
// que les baselines et l'inventaire ne bougent pas.
const SETTINGS_TREE = [
  ['terminal', 'General', 'Terminal'],
  ['ai-providers', 'AI & Providers', 'Providers'],
  ['cli-paths', 'AI & Providers', 'CLI Paths'],
  ['permissions', 'AI & Providers', 'Permissions'],
  ['hermes', 'Hermes', 'Connection'],
  ['notifications', 'General', 'Notifications'],
  ['system', 'General', 'System'],
  ['telegram', 'Integrations', 'Telegram'],
  ['slack', 'Integrations', 'Slack'],
  ['discord', 'Integrations', 'Discord'],
  ['x-twitter', 'Integrations', 'X (Twitter)'],
  ['google-workspace', 'Integrations', 'Google Workspace'],
  ['skills-plugins', 'Extensions', 'Skills & Plugins'],
  ['custom-mcp', 'Extensions', 'Custom MCP'],
  ['tasmania', 'Extensions', 'Tasmania'],
  ['git', 'Workspace', 'Git'],
  ['memory-backends', 'Workspace', 'Memory Backends'],
];

export const SETTINGS_SECTIONS = SETTINGS_TREE.map(([name, group, child]) => ({
  name: 'settings-' + name,
  route: '/settings',
  clickText: group,
  clickText2: child,
}));

// Overlays dont le déclencheur est connu et stable. Les autres entrées de
// l'inventaire sont ajoutées ici au fur et à mesure que le redesign les touche
// (check-coverage.mjs liste celles qui restent non automatisées).
//
// `overlay-new-agent` and `overlay-new-team` are the same `NewChatModal`,
// opened on either half of its "One agent | A team" switch - `+ Team` used to
// open the separate `DeployTeamDialog`, now folded into this component.
// `overlay-templates-manager` is back: the one-screen redesign dropped the
// template-chip row it used to open from, which left the manager unreachable
// rather than deleted. It has its own button on the Agents page now, so the
// surface is automated again.
export const OVERLAYS = [
  { name: 'overlay-templates-manager', route: '/agents', clickText: 'Templates' },
  { name: 'overlay-new-agent', route: '/agents', clickText: '+ Agent' },
  { name: 'overlay-new-team', route: '/agents', clickText: '+ Team' },
];

export const ALL = [...PAGES, ...SETTINGS_SECTIONS, ...OVERLAYS];

/**
 * e2e/screenshot.css, resolved from here.
 *
 * Playwright loads this manifest as CommonJS when a spec imports it, and
 * `import.meta` is a syntax error there (measured on 2026-09-17: every spec
 * failed to collect). Node loads it as a real module for check-coverage.mjs,
 * where `require` is the one that does not exist. Only a spec ever reads the
 * stylesheet, so the second way in just has to be harmless.
 */
function screenshotStyle() {
  try {
    return require.resolve('./screenshot.css');
  } catch {
    // No `require`, or one whose idea of `.` is elsewhere: `node -e` hands a
    // module a global require resolving from the eval, not from this file.
    return path.join(process.cwd(), 'e2e', 'screenshot.css');
  }
}

/**
 * How far a screenshot may drift from its reference before the surface fails.
 * One number, used by every spec that photographs the app.
 *
 * It was `maxDiffPixelRatio: 0.002`, which is 2,592 pixels of a 1440x900 page:
 * more than a row of content costs, and at the final sweep of 1.7.1 sixteen
 * surfaces differed from their references underneath it, `settings-system`
 * still showing version 1.6.3. A tolerance above what a real change costs
 * cannot fail on one.
 *
 * Measured on 2026-09-17, four full passes of the same tree (2f734fb), 45
 * captures each, every pair compared with Playwright's own comparator at its
 * default per-pixel threshold: **0 pixels** differ, on every surface but five,
 * and all five showed content that moves on its own (a random sandbox path, a
 * chunk count, a terminal line, two rooms named after a temp directory). Those
 * are masked below, by locator, so there is no measured noise left to tolerate.
 *
 * What a real change costs, measured against the references the same day:
 * **one character** of a page subtitle, 11 pixels; three characters of a
 * provider count, 18; three digits of a plugin count, 42; every dropdown's text
 * moved by four pixels, 152; a delete button added to six agent cards, 518.
 *
 * So: 10 pixels. Above the measured noise of zero, by room for a stray pixel,
 * and under the smallest change anybody can make to a page, by one pixel: a
 * single letter of `subtitle="Recurring jobs running in your Hermes gateway."`,
 * changed in a copy and never committed, failed `crons` at 11 pixels. A change
 * of one thin character could still come in under this, which is the honest
 * limit of a per-pixel count.
 *
 * The per-pixel threshold stays at Playwright's default, and that is where the
 * remaining blind spot is: pixelmatch does not count a colour change smaller
 * than it, so a scrollbar appearing inside a terminal is invisible here (1,977
 * pixels at a threshold of 0.1, 0 at 0.2). Lowering it would turn that same
 * scrollbar into run-to-run noise, since it depends on how much a live CLI has
 * printed; the terminal bodies are masked instead.
 */
export const SCREENSHOT_TOLERANCE = {
  maxDiffPixels: 10,
  threshold: 0.2,
  // Next's dev indicator is hidden for the picture: e2e/screenshot.css says why.
  stylePath: screenshotStyle(),
};

/**
 * Content that changes without anybody changing the app, masked by locator.
 *
 * A reference that carries a clock, a version number or a path made of a random
 * temp directory cannot match twice, and the answer used to be either a
 * tolerance wide enough to hide real changes or a re-record every release.
 * Each entry says what it covers and where, and specs pass the selector to
 * page.locator.
 *
 * `surfaces: 'all'` is everywhere, a list is those surfaces only: a selector
 * aimed at one page must not hide content on another. The keys are recorded as
 * they match, and e2e/known-errors.spec.ts fails a full run in which one of
 * them matched nothing anywhere, because a mask that stops matching hides
 * nothing and says nothing.
 *
 * A mask is painted magenta, and its shade is not fixed: (255, 0, 255) in the
 * references recorded before 1.8.0, (234, 51, 247) in those recorded on
 * Electron 44 for it (#173), and two runs a day apart have shown either. Mask
 * against mask stays under the per-pixel threshold, so Playwright counts none
 * of it; a count made by hand (the regions of the final runs of 1.8.0 and
 * 1.8.1) must skip a pixel that is magenta on both sides, red and blue above
 * 200 and green below 90, or it reports every mask as a change.
 */
export const VOLATILE = {
  'terminal-bodies': {
    surfaces: 'all',
    selector: '.xterm-screen',
    why: 'real PTY output and a blinking cursor, which differ between two frames of the same page',
  },
  'marked-counters': {
    surfaces: 'all',
    selector: '[data-volatile]',
    why: 'what the app itself marks as counting up while an agent runs',
    // The two marks in src are an agent detail panel that no surface opens and
    // the seconds a loading state counts once a read passes three seconds,
    // which a fast machine never shows: measured matching nothing at all in a
    // full run on 2026-09-17, the day the check below was written. Kept, and
    // declared as rare rather than deleted: the marks are in the product for
    // this mask, and a slow machine is exactly when it earns its place.
    sometimes: true,
  },
  'sandbox-paths': {
    surfaces: 'all',
    selector: 'text=/dorothy-e2e/',
    why: 'the sandbox HOME is a mkdtemp directory, so its name is different in every run',
  },
  'tars-version': {
    surfaces: ['settings-system'],
    selector: 'text=/^Version \\d+\\.\\d+\\.\\d+/',
    why: "Tars's own version, which changes at every release and is read from package.json",
  },
  'electron-node-versions': {
    surfaces: ['settings-system'],
    selector: 'text=/^\\d+\\.\\d+\\.\\d+ · Node /',
    why: 'the Electron and Node versions of the machine recording, which move with every dependency bump',
  },
  'cli-versions': {
    surfaces: ['settings-ai-providers'],
    selector: 'text=/^[a-z][a-z-]* · \\d+\\.\\d+/',
    why: 'the version of each CLI installed on the machine recording; Claude Code updates itself weekly',
  },
  'log-chunk-counts': {
    surfaces: ['logs'],
    selector: 'text=/· \\d+ chunks$/',
    why: 'how much a live CLI has printed by the time the page is photographed',
  },
  'tailnet-webhook': {
    surfaces: ['settings-hermes'],
    // The sandbox asks the Mac's own Tailscale: hermes-handlers.ts runs
    // `tailscale status` from PATH and from two absolute paths no fixture can
    // hide. So the Incoming webhook row shows the machine recording: its
    // MagicDNS name in the URL (`https://macbook-air-de-n...` in the 1.8.0 and
    // 1.9.0 references) and, once `tailscale serve` is on, in the line under it.
    // The row's input and its line only, by the row's own data hooks.
    selector: '[data-settings-row]:has([data-settings-label]:text-is("Incoming webhook")) :is(input, [data-settings-hint])',
    why: "the Mac's own Tailscale state and MagicDNS name, which name the machine recording",
  },
  'changelog-body': {
    surfaces: ['whats-new'],
    selector: 'div.space-y-2:has(ul li)',
    why: 'every changelog entry, which is new text on this page at every release; the page frame stays compared',
  },
  'marketplace-plugin-count': {
    surfaces: ['extensions-plugins'],
    selector: 'text=/\\d+ plugins/',
    why: 'how many plugins the marketplaces on GitHub are serving at the moment of the run',
  },
};

/**
 * The day the Usage page is photographed on, whatever day the run is: local
 * noon on 2026-09-16, far from midnight in any timezone the suite runs in. Its
 * window, the span under TOTAL COST, the TODAY tile and the day under each bar
 * all count back from it (e2e/fixture.mjs, pinDayOn). It replaces the mask the
 * fourteen day labels needed, so the three plot areas are compared again.
 */
export const USAGE_DAY = new Date(2026, 8, 16, 12).getTime();

/**
 * The masks for one surface, and the keys that actually matched something.
 *
 * `skip` is for a spec that masks the same thing more precisely: panel history
 * photographs a view drawn over a terminal, so masking every `.xterm-screen`
 * would paint over the very thing it is there to show.
 */
export async function volatileMasks(page, surface, skip = []) {
  const masks = [];
  const used = [];
  for (const [key, entry] of Object.entries(VOLATILE)) {
    if (skip.includes(key)) continue;
    if (entry.surfaces !== 'all' && !entry.surfaces.includes(surface)) continue;
    const locator = page.locator(entry.selector);
    masks.push(locator);
    if (await locator.count() > 0) used.push(key);
  }
  return { masks, used };
}

/**
 * Uncaught page errors the suite tolerates, each one reported and none of them
 * allowed to be forgotten.
 *
 * An allowance that only ever permits is how a known defect becomes permanent:
 * the day it is fixed, nothing says so and the entry stays for years. Every
 * spec in RECORDING_SUITES writes down which of these each of its surfaces
 * actually saw, and `e2e/known-errors.spec.ts` fails when one of them stops
 * happening. Removing the entry is then the way to make the suite green again,
 * which is the only order that keeps this list honest.
 *
 * Empty since 2026-09-18, and the two entries it held are the reason the rule
 * is written that way. `hydration` covered a class of mismatch that four pages
 * had, and the pages have it no longer: they decided at render whether the
 * preload bridge existed, so the pre-render and the first client render were
 * not the same page, and `useDesktopApi` answers the same thing in both now.
 * `overseer-model-options` covered an uncaught rejection from an unreachable
 * gateway, and that call is caught. Measured on the tree that fixed them: a
 * full run, every surface recording, and the main process probe reporting
 * **0 console errors of any kind**, against 48 on the tree before.
 *
 * The next allowance goes here with its `key`, its `match` and a `why` that
 * says which defect it covers and when it was reported.
 *
 * @type {Array<{ key: string, match: RegExp, why: string }>}
 */
export const KNOWN_PAGE_ERRORS = [];

/** Split page errors into what is known, what is not, and what was seen. */
export function splitPageErrors(errors) {
  const seen = new Set();
  const fatal = [];
  for (const error of errors) {
    const known = KNOWN_PAGE_ERRORS.find(k => k.match.test(error));
    if (known) seen.add(known.key);
    else fatal.push(error);
  }
  return { fatal, seen };
}

/**
 * The file this run's surfaces write to, in the directory e2e/global-setup.mjs
 * made for it. Missing means the run did not start from playwright.config.ts,
 * and recording nowhere would let the check skip every run without a word, so
 * that throws rather than passes.
 */
function pageErrorRecordsFile() {
  const dir = process.env.E2E_PAGE_ERRORS_DIR;
  if (!dir || !fs.existsSync(dir)) {
    throw new Error('E2E_PAGE_ERRORS_DIR is not set: run the suite through playwright.config.ts, whose global setup makes it');
  }
  return path.join(dir, 'records.jsonl');
}

/**
 * Split one surface's page errors, write down the tolerated ones it saw, and
 * return the ones nothing tolerates, which fail the surface.
 *
 * Written to disk rather than kept in the spec's module, because a module does
 * not outlive its worker: after any failure Playwright runs the rest of the
 * file in a new one, and a Set kept there forgot everything seen before it.
 */
export function recordPageErrors(testInfo, suite, surface, errors, masksUsed = []) {
  if (!RECORDING_SUITES[suite]?.some(s => s.name === surface)) {
    throw new Error(`${suite}: ${surface} is not in RECORDING_SUITES, so e2e/known-errors.spec.ts would never wait for it`);
  }
  const { fatal, seen } = splitPageErrors(errors);
  fs.appendFileSync(
    pageErrorRecordsFile(),
    // The masks each surface used are written down beside what it tolerated,
    // and judged the same way: see e2e/known-errors.spec.ts.
    JSON.stringify({ suite, surface, seen: [...seen], masks: masksUsed, fatal }) + '\n',
  );
  for (const key of seen) testInfo.annotations.push({ type: 'known-issue', description: key });
  if (masksUsed.length > 0) testInfo.annotations.push({ type: 'masked', description: masksUsed.join(', ') });
  return fatal;
}

/** Everything this run's surfaces have recorded so far. */
export function readPageErrorRecords() {
  const file = pageErrorRecordsFile();
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

// Panel history: two states of a Dashboard panel, reached through that panel's
// own live | history switch. The inventory's "Dashboard · panel history" and
// the no-transcript half of "Panel history · states". The skeleton half is a
// state that lasts as long as one small IPC read, so it is not photographed.
//
// Deliberately not in ALL. e2e/panel-history.spec.ts drives them in a sandbox
// of its own: the sweep above leaves auto start on, so every agent on the
// board is a real CLI, and what a claude panel's history shows would depend on
// how fast that CLI registers its session. There nothing starts, the
// Orchestrator reads a transcript seeded on disk, and the Backend Engineer
// runs codex, which writes none.
// The Chat room in six states of the page rather than overlays, first
// specified in `design/chat-design.pen` and drawn since #165 from
// `design/chat-redesign-a.pen`. One room per state, because a room is
// derived from a project and a journal can only put a given one in a single
// state at a time.
//
// Deliberately not in ALL, for the reason PANEL_HISTORY is not: they need a
// sandbox whose agents do not start, whose projects are five rather than two,
// and whose bus journal is seeded. e2e/chat-rooms.spec.ts drives them.
//
// `delivered`, `dropped`, `bounded` and `superseded` are rendered here for the
// first time. Every one of them was code that had never been on a screen.
export const CHAT_ROOMS = [
  {
    name: 'chat-hermes-with-rooms', route: '/chat',
    // Direction A (#165) no longer says `All projects`. The tars row's count
    // comes from the bus journal and the placeholder from the failed Hermes
    // connection, so the picture waits for both.
    shows: '1 not sent',
    placeholder: 'Fix the Hermes connection above',
  },
  {
    name: 'chat-room-agents-at-work', route: '/chat', clickText: 'tars',
    shows: 'Then I hold the write until the fit resolves, and add the test that caught it.',
  },
  {
    name: 'chat-room-you-step-in', route: '/chat', clickText: 'orion',
    shows: 'Stop there, both of you. Cache the parts, and measure it before you tune it.',
  },
  {
    name: 'chat-room-limit-reached', route: '/chat', clickText: '1212-capital',
    shows: 'Nobody was stopped: every agent finished its turn and is waiting for you.',
  },
  {
    // The room says this in the composer's placeholder rather than in the log,
    // which is the point of the frame: the room is readable and the box tells
    // you why nothing will move.
    name: 'chat-room-all-stopped', route: '/chat', clickText: 'atlas',
    // Since #124 the card says it in a strip above the field, and the field, off,
    // says what to do.
    placeholder: 'Start an agent to write here',
    shows: 'Three paragraphs assume the reader already has an account. I have marked them.',
  },
  {
    name: 'chat-room-no-agents', route: '/chat', clickText: 'mercury',
    shows: 'Nobody in this room yet',
  },
];

export const PANEL_HISTORY = [
  {
    name: 'dashboard-panel-history', route: '/', clickText: 'history', within: 'Orchestrator',
    shows: 'Ship it, with the test that caught it.',
  },
  {
    name: 'panel-history-no-transcript', route: '/', clickText: 'history', within: 'Backend Engineer',
    shows: 'Codex CLI does not write a transcript Tars can read.',
  },
];

/**
 * Every spec that tolerates KNOWN_PAGE_ERRORS, by the name it records under,
 * with the surfaces it records. e2e/known-errors.spec.ts only judges a run in
 * which each of these recorded, because an entry cannot be called stale on a
 * page that never opened. A spec that starts tolerating errors adds itself here,
 * or recordPageErrors refuses it.
 */
export const RECORDING_SUITES = {
  surfaces: ALL,
  'chat-rooms': CHAT_ROOMS,
  // Its two surfaces tolerated nothing and masked nothing until 2026-09-17:
  // they asserted no page error at all, and the Dashboard they photograph
  // prints the same hydration mismatch every other page does. Listening to the
  // console there without this would have failed them on a defect the suite
  // has declared and reported since 2026-09-16.
  'panel-history': PANEL_HISTORY,
};
