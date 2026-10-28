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
  // The new shell's chats page, photographed here with the switch off, as
  // everything in this sweep: the seed's orchestrator makes the tars project's
  // chat #1, Main, which the page opens on its conversation, read from its
  // transcripts (Chat · chats · from its transcripts, in chat-redesign-a.pen).
  // e2e/new-interface-shell.spec.ts, e2e/new-interface-chats.spec.ts and
  // e2e/new-interface-chat-page.spec.ts walk it with the switch on.
  { name: 'chats', route: '/chats' },
  // A project's page in the new shell (Shell · chats · project page, from the
  // records), without ?path=: the first project by name. With the switch off,
  // as `chats`; e2e/new-interface-chats.spec.ts walks it with the switch on.
  { name: 'project', route: '/project' },
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
  // This computer's own figures (free disk, memory, swap, load) are marked data-volatile and masked below.
  { name: 'resources', route: '/resources' },
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

// Les 19 sections de Settings. Depuis le regroupement, chaque section est un
// groupe cliqué puis son enfant : le nom de surface reste celui d'avant pour
// que les baselines et l'inventaire ne bougent pas.
const SETTINGS_TREE = [
  ['terminal', 'General', 'Terminal'],
  ['ai-providers', 'AI & Providers', 'Providers'],
  ['claude-accounts', 'AI & Providers', 'Claude accounts'],
  ['cli-paths', 'AI & Providers', 'CLI Paths'],
  ['permissions', 'AI & Providers', 'Permissions'],
  ['hermes', 'Hermes', 'Connection'],
  ['hermes-gateways', 'Hermes', 'Gateways'],
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

// Claude accounts is not offered on a Windows build until it is ported
// (src/lib/claude-accounts-offered.ts): no surface to photograph there.
const SETTINGS_SHOWN = process.platform === 'win32'
  ? SETTINGS_TREE.filter(([name]) => name !== 'claude-accounts')
  : SETTINGS_TREE;

export const SETTINGS_SECTIONS = SETTINGS_SHOWN.map(([name, group, child]) => ({
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
    // this mask, and a slow machine is exactly when it earns its place. Since
    // 2.0.5 the Resources page marks its live figures of the machine too (free
    // disk, memory, swap, load), which differ between any two runs.
    sometimes: true,
  },
  'sandbox-paths': {
    surfaces: 'all',
    // The smallest element whose text names the sandbox's home, but not a CLI's
    // path (data-cli-path): cli-paths masks that one with its row's whole left
    // column, a fixed box, where this mask drew the path's own span at the
    // path's width, past its column once the path is long (#498's witness: a
    // home 40 characters longer turned settings-cli-paths red by 13,614 px).
    selector: ':not([data-cli-path]):text-matches("dorothy-e2e")',
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
  'disk-space': {
    surfaces: ['settings-system'],
    // The Disk row's hint and its 300px control column, boxes whose size the
    // numbers do not move: masking the "N GB free" text itself gave a box one
    // digit wider or narrower when the disk crossed 10 or 100 GB free, about
    // 100 pixels (QA's gate of #336).
    selector: '[data-settings-row]:has([data-settings-label]:text-is("Disk")) [data-settings-hint], [data-settings-row]:has([data-settings-label]:text-is("Disk")) > div:nth-child(2)',
    why: 'the free and total space of the disk the run is on, which moves with everything written to it',
  },
  'cli-versions': {
    surfaces: ['settings-ai-providers'],
    // A version is its number alone in an element of its own (2.0.4, the Audit's
    // L5 on #460): under each CLI of the list, after its command (`claude
    // 2.1.302`), and in the picked CLI's chip. The mask covers the number and
    // nothing around it, so a reworded line is still compared.
    // Not on Windows: the app gets a PATH without the user's folders there
    // (windowsSystemPath in e2e/fixture.mjs), finds no CLI and prints no version.
    platforms: ['darwin', 'linux'],
    selector: '[data-cli-version]',
    why: 'the version of each CLI installed on the machine recording; Claude Code updates itself weekly, codex and amp as often',
  },
  'cli-paths': {
    surfaces: ['settings-ai-providers', 'settings-cli-paths'],
    // Where the one detection found each CLI (2.0.4): CLI Paths shows it as it
    // opens, and Providers' Command row names it. Masked with the row's left
    // column (its name and the line that holds the path), a box as wide as the
    // column whatever the path: the sandbox's stand-in CLIs (main's b422b1cd)
    // sit under its mkdtemp home, whose length moves with the run's TMPDIR, and
    // a mask the path's own width moved with it (6,091 and 23,655 pixels on
    // 0b171098). Not the line alone: sandbox-paths masks the path's span too,
    // and the span's box stands about 1 px above its line, so a 1-px row at the
    // path's width was left above the line's box (the Audit on #498).
    selector: '[data-settings-row]:has([data-cli-path]) > div:first-child',
    why: 'where the CLIs are installed on the machine recording, which moves with each install and each Node version',
  },
  'local-api-port': {
    surfaces: ['settings-hermes-gateways'],
    // A gateway's address on this machine carries the local API's port, which
    // each run's E2E_PORT_OFFSET moves (e2e/ports.mjs). The field alone is
    // masked: its row's words stay compared.
    selector: '[data-settings-row]:has([data-settings-label]:text-is("On this machine")) input',
    why: "the local API's port, which moves with the run's E2E_PORT_OFFSET",
  },
  'log-chunk-counts': {
    surfaces: ['logs'],
    selector: 'text=/· \\d+ chunks$/',
    why: 'how much a live CLI has printed by the time the page is photographed',
  },
  'changelog-body': {
    surfaces: ['whats-new'],
    selector: 'div.space-y-2:has(ul li)',
    why: 'every changelog entry, which is new text on this page at every release; the page frame stays compared',
  },
  // Windows only (`platforms`), so the darwin pictures, recorded without them,
  // compare as they always have. The Hermes webhook row reads the recording
  // machine's own Tailscale: its state and its tailnet name on one line, the
  // tailnet URL in the field. Measured on 2026-09-26: `tailscale serve active ·
  // <host>.<tailnet>.ts.net` on the Windows machine recording, where a clean
  // runner reads `no tailscale · a VPS cannot reach this machine`. The line is
  // masked in every state, so it is the same picture on any machine.
  'tailscale-state': {
    surfaces: ['settings-hermes'],
    platforms: ['win32'],
    selector: 'text=/tailscale/',
    why: "the recording machine's Tailscale state and tailnet host name",
  },
  'webhook-url': {
    surfaces: ['settings-hermes'],
    platforms: ['win32'],
    selector: 'input[value*="/api/webhooks/hermes"]',
    why: "the webhook URL, on the recording machine's tailnet when it has one",
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

/** Whether a VOLATILE entry masks on this platform: every platform unless it lists some. */
export function maskApplies(entry, platform = process.platform) {
  return !entry.platforms || entry.platforms.includes(platform);
}

/** The masks for one surface, and the keys that actually matched something. */
export async function volatileMasks(page, surface) {
  const masks = [];
  const used = [];
  for (const [key, entry] of Object.entries(VOLATILE)) {
    if (entry.surfaces !== 'all' && !entry.surfaces.includes(surface)) continue;
    if (!maskApplies(entry)) continue;
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

// The Chat room in six states of the page rather than overlays, first
// specified in `design/chat-design.pen` and drawn since #165 from
// `design/chat-redesign-a.pen`. One room per state, because a room is
// derived from a project and a journal can only put a given one in a single
// state at a time.
//
// Deliberately not in ALL: they need a sandbox whose agents do not start, whose projects are five rather than two,
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
};
