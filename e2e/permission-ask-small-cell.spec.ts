import { test, expect, _electron as electron, type Locator, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchSandboxed, recordValues, removeHome, seedSandbox, stepShot, writeNodeCli } from './fixture.mjs';
import { DEV_URL, apiPort } from './ports.mjs';

/**
 * A permission question opened whole (show all) in the smallest cell of the
 * Dashboard's grid, outside full screen: its answers stay in the cell and its
 * details scroll inside it (JeanBrasse's report of 2026-10-22, on 2.0.3: with
 * six to eight CLIs on the board, show all pushed allow and deny out of the
 * panel, which clips what it cannot hold, and only full screen reached them).
 * Frame: `Permission asked of Tars`, its `smallest cell` row.
 *
 * Eight agents on one project make the board a 3x3 grid, in the window at the
 * size it opens at. Each runs a stand-in for claude with the state mod: seven
 * register and wait; the asker asks Tars about two Bash calls whose command no
 * line holds (POST /api/hooks/permission, with its own token, again while Tars
 * answers `pending`), each with Claude Code's reason and its rule, and writes
 * each decision it is handed to its file. The person opens each with show all,
 * finds allow and deny inside the panel and on top at their own point, scrolls
 * the details to the rule, denies the first from its reason field and allows
 * the second, each by a click at the button's own point: a locator's click
 * would scroll the panel it is clipped in and reach a button no person can.
 * In the shell as it was and in the new interface.
 *
 * The artefact: the window and cell sizes, each button's box against its
 * panel's, the details' scroll, and the decisions, in values.json, and a
 * screenshot of each step.
 */

const ASKER = 'asker';
const NAMES = ['Frontend Engineer', 'Backend Engineer', 'QA Engineer', 'Audit Engineer', 'Database Engineer', 'Docs Writer', 'Release Manager', 'Designer'];
const LONG = (n: number) => `rm -rf build && ${'npm run build && npm test && '.repeat(n)}cp -R coverage ~/reports`;
const CALLS = [
  { tool_use_id: 'toolu_deny', command: LONG(24) },
  { tool_use_id: 'toolu_allow', command: LONG(30) },
];
const RULE = 'Bash(rm:*)';
const WHY = `Permission rule ${RULE} requires confirmation`;
const DENY_REASON = 'build it once, not thirty times';

function standIn(home: string): string {
  const calls = CALLS.map(c => ({ tool_use_id: c.tool_use_id, tool: 'Bash', input: { command: c.command, description: 'Build and test' }, reason: WHY, rule: RULE }));
  return writeNodeCli(path.join(home, 'stand-in.cjs'), [
    "const fs = require('fs'); const crypto = require('crypto');",
    "if (process.argv.includes('--version')) { console.log('2.1.289 (Claude Code)'); process.exit(0); }",
    "const session = crypto.randomUUID();",
    `const answers = ${JSON.stringify(path.join(home, 'answers.jsonl'))};`,
    `const CALLS = ${JSON.stringify(calls)};`,
    "const post = (route, body) => fetch(process.env.CLAUDE_MGR_API_URL + route, {",
    "  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLAUDE_MGR_API_TOKEN },",
    "  body: JSON.stringify({ agent_id: process.env.CLAUDE_AGENT_ID, session_id: session, ...body }),",
    "}).then(r => r.json());",
    "const pause = ms => new Promise(r => setTimeout(r, ms));",
    "(async () => {",
    "  process.stdout.write('stand-in ready\\r\\n');",
    "  await post('/api/hooks/status', { status: 'idle', source: 'startup' });",
    `  if (process.env.CLAUDE_AGENT_ID !== ${JSON.stringify(ASKER)}) return;`,
    "  await post('/api/hooks/status', { status: 'running', event: 'UserPromptSubmit', current_task: 'Build it and run the tests before the PR' });",
    "  for (const call of CALLS) {",
    "    process.stdout.write('* Bash, asking Tars\\r\\n');",
    "    let answer;",
    "    do answer = await post('/api/hooks/permission', { tool: call.tool, input: call.input, tool_use_id: call.tool_use_id, reason: call.reason, rule: call.rule });",
    "    while (answer.decision === 'pending');",
    "    fs.appendFileSync(answers, JSON.stringify({ call: call.tool_use_id, ...answer }) + '\\n');",
    "    process.stdout.write('* Bash: ' + answer.decision + '\\r\\n');",
    "    await pause(1500);",
    "  }",
    "})();",
    "process.stdin.resume();",
    '',
  ].join('\n'));
}

const answersOf = (home: string) => {
  const file = path.join(home, 'answers.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
};

/**
 * Where a button is against the panel it is drawn in, and whether a click at
 * its own point lands on it: inside the panel's box and on top there, or a
 * person cannot reach it without full screen.
 */
const reach = (button: Locator) => button.evaluate((el) => {
  const box = el.getBoundingClientRect();
  const panel = el.closest('[data-agent-panel]')!.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const hit = document.elementFromPoint(x, y);
  const round = (r: DOMRect) => ({ top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) });
  return {
    x, y, box: round(box), panel: round(panel),
    inPanel: box.top >= panel.top - 0.5 && box.bottom <= panel.bottom + 0.5 && box.left >= panel.left - 0.5 && box.right <= panel.right + 0.5,
    onTop: !!hit && (hit === el || el.contains(hit)),
  };
});

/** How far each box between the ask and the grid was scrolled: a person scrolls none of them, the details aside. */
const clippedScroll = (ask: Locator) => ask.evaluate((el) => {
  const out: number[] = [];
  for (let n: HTMLElement | null = el; n && !n.matches('[data-board-layout]'); n = n.parentElement) out.push(n.scrollTop);
  return out.reduce((a, b) => a + b, 0);
});

/** Clicks a button at its own point, as a person does, once it is shown reachable. */
async function clickWhereItIs(page: Page, button: Locator, label: string, seen: Record<string, unknown>) {
  const at = await reach(button);
  seen[label] = at;
  expect(at.inPanel, `${label}: inside its panel (${JSON.stringify(at)})`).toBe(true);
  expect(at.onTop, `${label}: a click at its point lands on it`).toBe(true);
  await page.mouse.click(at.x, at.y);
}

for (const newInterface of [false, true]) {
  test(`a question opened whole in the smallest cell of the board keeps allow and deny in reach, its details scrolling${newInterface ? ' (new interface)' : ''}`, async () => {
    test.setTimeout(240_000);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dorothy-e2e-ask-small-cell-'));
    seedSandbox(home);
    const project = path.join(home, 'projects', 'tars');
    const cli = standIn(home);
    const dir = path.join(home, '.tars');
    fs.writeFileSync(path.join(dir, 'agents.json'), JSON.stringify(NAMES.map((name, i) => ({
      id: i === 0 ? ASKER : `peer-${i}`, name, character: 'robot', provider: 'claude', status: 'idle', role: 'worker',
      projectPath: project, skills: [], cliPath: cli,
      createdAt: '2026-10-22T08:00:00.000Z', lastActivity: '2026-10-22T08:00:00.000Z',
    })), null, 2));
    fs.writeFileSync(path.join(dir, 'app-settings.json'), JSON.stringify({ ollamaBaseUrl: 'http://127.0.0.1:9', newInterface }, null, 2));

    const app = await launchSandboxed(electron, home, {
      env: { NODE_ENV: 'development', DOROTHY_DEV_URL: DEV_URL, DOROTHY_API_PORT: apiPort(newInterface ? 31542 : 31541), DOROTHY_E2E: '1' },
    });
    const seen: Record<string, unknown> = { newInterface };
    const tag = newInterface ? 'new' : 'old';
    const pageErrors: string[] = [];
    try {
      const page = await app.firstWindow();
      page.on('pageerror', (e) => pageErrors.push(e.message));
      await page.waitForLoadState('domcontentloaded');
      await page.goto(`${DEV_URL}/`, { waitUntil: 'domcontentloaded' });

      // The board: eight panels, in the window at the size it opens at.
      await expect(page.locator('[data-agent-panel]')).toHaveCount(8, { timeout: 90_000 });
      seen.window = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
      const panel = page.locator(`[data-agent-panel="${ASKER}"]`);
      const ask = page.locator(`[data-permission-ask="${ASKER}"]`);

      for (const [i, call] of CALLS.entries()) {
        const step = call.tool_use_id === 'toolu_deny' ? 'deny' : 'allow';
        // The line cuts the command: show all opens it whole, in the panel.
        await expect(ask).toContainText('Asks to use Bash:', { timeout: 60_000 });
        await expect(ask).toContainText(call.command.slice(0, 60));
        seen[`cell-${step}`] = await panel.evaluate((el) => { const r = el.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height) }; });
        await clickWhereItIs(page, ask.getByRole('button', { name: 'show all', exact: true }), `${step}-show-all`, seen);
        await expect(ask).toContainText(call.command);
        await stepShot(page, `${tag}-0${i + 1}a-shown-whole`);

        // Allow and deny, in the panel and on top at their own point.
        seen[`${step}-allow-reach`] = await reach(ask.getByRole('button', { name: 'allow', exact: true }));
        seen[`${step}-deny-reach`] = await reach(ask.getByRole('button', { name: 'deny', exact: true }));
        for (const name of ['allow', 'deny']) {
          const at = seen[`${step}-${name}-reach`] as Awaited<ReturnType<typeof reach>>;
          expect(at.inPanel, `${name} inside its panel, ${step} (${JSON.stringify(at)})`).toBe(true);
          expect(at.onTop, `${name} on top at its point, ${step}`).toBe(true);
        }

        // The details are taller than what the cell holds, and scroll inside
        // the ask to why Claude Code asks and the rule that asked.
        const details = ask.locator('[data-ask-details]');
        const before = await details.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop }));
        seen[`${step}-details`] = before;
        expect(before.scrollHeight, 'the details are taller than their box').toBeGreaterThan(before.clientHeight);
        const box = (await details.boundingBox())!;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, before.scrollHeight);
        await expect.poll(() => details.evaluate((el) => Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight - 1)).toBe(true);
        const rule = ask.getByRole('definition').last();
        await expect(rule).toHaveText(RULE);
        seen[`${step}-rule-reach`] = await rule.evaluate((el) => {
          const r = el.getBoundingClientRect(); const d = el.closest('[data-ask-details]')!.getBoundingClientRect();
          return { inDetails: r.top >= d.top - 0.5 && r.bottom <= d.bottom + 0.5 };
        });
        expect((seen[`${step}-rule-reach`] as { inDetails: boolean }).inDetails, 'the rule, scrolled to, is in view').toBe(true);
        expect(await clippedScroll(ask), 'no box but the details was scrolled').toBe(0);
        await stepShot(page, `${tag}-0${i + 1}b-details-scrolled`);

        if (step === 'deny') {
          // Deny opens its reason field in place; its own deny stays in reach.
          await clickWhereItIs(page, ask.getByRole('button', { name: 'deny', exact: true }), 'deny-open-reason', seen);
          await ask.getByRole('textbox').fill(DENY_REASON);
          await stepShot(page, `${tag}-01c-deny-reason`);
          await clickWhereItIs(page, ask.getByRole('button', { name: 'deny', exact: true }), 'deny-send', seen);
        } else {
          await clickWhereItIs(page, ask.getByRole('button', { name: 'allow', exact: true }), 'allow-send', seen);
        }
        await expect.poll(() => answersOf(home).length, { timeout: 15_000 }).toBe(i + 1);
      }
      await expect(ask).toHaveCount(0, { timeout: 15_000 });
      await stepShot(page, `${tag}-03-answered`);

      const answers = answersOf(home);
      recordValues({ ...seen, answers, pageErrors });
      expect(answers.map(({ call, decision, reason }) => ({ call, decision, reason }))).toEqual([
        { call: 'toolu_deny', decision: 'deny', reason: `the user refused it in Tars: ${DENY_REASON}` },
        { call: 'toolu_allow', decision: 'allow', reason: 'the user allowed it in Tars' },
      ]);
      expect(pageErrors).toEqual([]);
    } finally {
      recordValues(seen);
      await app.close();
      await removeHome(home);
    }
  });
}
