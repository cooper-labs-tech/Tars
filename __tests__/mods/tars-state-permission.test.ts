/**
 * The state mod's permission questions (mods/tars-state/hooks/register.ts, mods
 * step 2): when Claude Code would put a tool call to its permission dialog, the
 * mod asks the Tars that started it, and Tars's allow or deny is the decision.
 * Measured on 2.1.289 (ETUDE-MODS-CLAUDE-CODE.md §2): a hook may await Tars past
 * the 10 s budget, a `$` call in flight is not counted, and a deny's reason is
 * what the model reads.
 *
 * How it fails, written before the code (2026-10-05):
 * 1. Tars is asked about calls the engine would allow or deny by itself: every
 *    Read, every call of a bypass-mode agent, a question for nothing.
 * 2. The engine's decision is replaced when Tars hands the question back
 *    (`ask`), does not answer, answers garbage or cannot be reached: the
 *    dialog must then show, as before the mod.
 * 3. An AskUserQuestion, which is a question to the person and not a
 *    permission, is answered by Tars.
 * 4. The mod asks a Tars that did not prove it started this CLI, or before its
 *    session is known, so the token goes to whoever answers on the port.
 * 5. The question does not carry what Tars needs to hold the right agent and
 *    say what is asked (agent, session, tool, call id, the command or path),
 *    or carries a whole file's content.
 * 6. An allow or a deny from Tars is not the decision, or the deny loses the
 *    reason the model should read.
 * And from the live measure (2026-10-05): past about 30 s the request ended
 * and the dialog showed while Tars still held the question. Tars now answers
 * `pending` within 20 s:
 * 7. A pending is taken for the decision, or the mod stops asking: it asks
 *    again for the same call until Tars decides, and gives up to the engine
 *    after a bounded number of asks.
 * And from a second live measure at load ~300: the dialog once showed 20 s
 * in, at Tars's first `pending`, and not in the next run.
 * 8. One request that fails while Tars holds the question sends the call to
 *    the dialog: the mod asks again, telling Tars why, and gives up after
 *    three failures in a row.
 * And from the gate of #318 (GATE-PR318-320.md):
 * 9. (Medium 1) An allow is taken for whatever call it came back to: an
 *    answer to a question about other fields (a post the agent's own shell
 *    made for the same call id) allows this one. The mod takes an answer only
 *    when it names the fingerprint of its own call: sha256 of the tool and
 *    the asked fields, sorted by name.
 * 10. (Medium 2) A field is cut to the mod's cap and the cut text is asked
 *    about while the whole call runs: a field past 2,000 characters is not
 *    asked of Tars, the terminal's dialog shows it whole.
 * 11. (Low) Claude Code's rule is not sent: in bypass it is the only reason
 *    Tars is asked.
 * And from the Audit's recheck (GATE-PR318-320-RECHECK.md), agreed by JeanBrasse
 * on 05/10:
 * 12. A tool that carries content (Edit, Write, NotebookEdit) is asked of
 *    Tars, which shows its path and never its content: an allow there would
 *    approve what nobody saw. (Since 28/10, item 15: asked by its path alone and
 *    marked withheld; anything but Tars's deny keeps the dialog.)
 * And from the Audit's second recheck (GATE-PR318-320-RECHECK2.md, proof
 * gate-318/mcp-content.test.ts): a call whose input held a field Tars did not
 * show reached it with `fields: {}`: a tweet's text, a message, a delegated
 * task, a subagent's prompt.
 * 13. A call with a field Tars does not send reaches it as if it had none.
 *    (Since 10/11, item 22: every field is sent whole within the cap, and a
 *    field past it makes the question withheld, never silently empty.)
 * And from the night of 27/10 (fix-permission-dialogs-2810.md): Tars now holds
 * a question up to the owner's delay, 1 to 60 minutes, and refuses it then.
 * 14. The mod gives up first (40 asks, about 13 minutes) and the dialog shows,
 *    where nobody answers at night: it must keep asking past 60 minutes of
 *    `pending`, and still stop in the end, should Tars never decide.
 * And from the orchestrator's decision of 28/10 (#538's re-check):
 * 15. A file tool's call (Write, Edit, MultiEdit, NotebookEdit) reaches Tars
 *    with its content: it is asked by its other fields alone, marked
 *    `withheld`, and only Tars's deny is taken.
 * And from the Audit's fourth gate of #538 (M1 at ff0e3f2d):
 * 16. A question the mod cannot show whole is left to the dialog without a word
 *    to Tars: it must be posted marked `withheld`, with the fields Tars shows
 *    and why the rest is withheld, the withheld value never sent.
 * 17. Bash's `timeout`, `run_in_background` and `dangerouslyDisableSandbox`
 *    make a common call withheld. (Since 10/11, item 22: any field that is not
 *    text is shown as its JSON.)
 * 18. A withheld question takes Tars's allow: the window never saw it whole,
 *    so only a deny is taken, anything else keeps the dialog.
 * And from the Audit's fifth gate of #538 (its Low):
 * 19. An AskUserQuestion is not put to Tars, which alone knows the agent's role
 *    and mode: Tars's refusal (ask your orchestrator) must be taken, anything
 *    else keeps it with the person.
 * And from the owner's report of 10/11 (chrome-and-permissions-general.md):
 * every Claude in Chrome call of a bypass agent was held for the window and
 * refused at the delay, and "ask in terminal" seemed to do nothing. Measured on
 * claude 2.1.321: an `ask` at tool.check is not the dialog. Under the server's
 * Chrome flag, Claude Code takes Chrome's calls out of bypass and hands their
 * ask to the auto mode classifier after tool.check; the classifier allowed
 * them, and from 27/09 to 10/11 not one Chrome dialog opened in a terminal
 * (hooks.log). `classic.PermissionRequest` runs when the dialog would show,
 * after the mode, the rules and the classifier; a module may hold it past 60 s
 * with `$` calls in flight, the dialog does not show meanwhile, its allow and
 * deny are the decision, and the shell hooks beneath it do not run.
 * Written before the code:
 * 20. Tars is asked at tool.check, before Claude Code's later steps decide: a
 *    call the classifier would allow is held for the window. tool.check must
 *    return the engine's verdict and post nothing; Tars is asked at
 *    classic.PermissionRequest only, and the mod's own answer is
 *    `{ decision: { behavior } }`, or the event handed on (`next`) for the
 *    dialog.
 * 21. classic.PermissionRequest carries no call id and no reason: the question
 *    loses them. The mod takes both from the tool.check that asked about the
 *    same call (the same tool and input, else the latest of that tool), and a
 *    call none asked about still gets an id of its own, stable across its asks.
 * 22. A field that is a number, a boolean, null, an array or an object, or a
 *    key the window did not know, makes the question withheld, and the window
 *    can never allow it: each is sent whole within the cap, a field that is not
 *    text as its JSON, named in `json_fields`, which the fingerprint includes so
 *    that `true` never binds as `"true"`.
 * 23. A file's new content is sent: Write's content, Edit's old and new
 *    strings, MultiEdit's edits, NotebookEdit's new source are never sent,
 *    whatever their size; the file tool's other fields are.
 * 24. The route refuses a question with more than 16 fields or a field name
 *    past 64 characters, and the dialog shows: the mod withholds those instead,
 *    so the mod and the route agree.
 * 25. A refusal from Tars reaches the model as nothing: the deny's message is
 *    Tars's reason.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

type Hook = ($: unknown, e: unknown, next: (e: unknown) => Promise<unknown>) => unknown;

const ENV: Record<string, string> = {
  CLAUDE_AGENT_ID: 'a1', CLAUDE_MGR_API_URL: 'http://127.0.0.1:1', CLAUDE_MGR_API_TOKEN: 'tok', TARS_INSTANCE_ID: 'inst',
};
const SESSION = '11111111-1111-4111-8111-111111111111';

let hooks: Map<string, Hook>;
let posts: Array<{ url: string; body: Record<string, unknown> }>;
let answer: () => Promise<{ text: string }>;
let rawAnswers = false;
/** Tars's fingerprint (permission-asks.ts questionFingerprint): the json list only when there is one. */
const fingerprint = (tool: string, fields: Record<string, string>, json: string[] = []) => {
  const entries = Object.keys(fields).sort().map(k => [k, fields[k]]);
  const canonical = json.length ? [tool, entries, [...json].sort()] : [tool, entries];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
};
let proof: 'right' | 'wrong';

const $ = {
  env: { get: async (name: string) => ENV[name] },
  clock: { every: () => undefined },
  http: {
    fetch: async (url: string, init?: { body?: string }) => {
      if (url.includes('/api/health')) {
        const challenge = new URL(url).searchParams.get('challenge');
        const right = createHash('sha256').update(`inst:${challenge}`).digest('hex');
        return { text: JSON.stringify({ proof: proof === 'right' ? right : 'f'.repeat(64) }) };
      }
      const body = JSON.parse(init?.body ?? '{}');
      posts.push({ url, body });
      if (url.endsWith('/api/hooks/permission')) {
        const reply = await answer();
        // A Tars that does its part names the question's fingerprint on a
        // decision; a test that forges or drops it sets `rawAnswers`.
        if (rawAnswers) return reply;
        let said: Record<string, unknown>;
        try { said = JSON.parse(reply.text); } catch { return reply; }
        if ((said.decision === 'allow' || said.decision === 'deny') && !('fingerprint' in said)) {
          said.fingerprint = fingerprint(body.tool as string, body.input as Record<string, string>, (body.json_fields as string[] | undefined) ?? []);
        }
        return { text: JSON.stringify(said) };
      }
      return { text: '{}' };
    },
  },
};

async function load(): Promise<void> {
  vi.resetModules();
  hooks = new Map();
  const mod = await import('../../mods/tars-state/hooks/register');
  mod.register(((event: string, hook: Hook) => { hooks.set(event, hook); }) as never);
}

async function start(): Promise<void> {
  await hooks.get('classic.SessionStart')!($, { session_id: SESSION, source: 'startup' }, async e => e);
}

type Call = { tool: string; input: unknown; tool_use_id?: string };

/** tool.check with the engine's own verdict: what the mod hands back. */
function check(e: Call, engine: Record<string, unknown>): Promise<unknown> {
  return Promise.resolve(hooks.get('tool.check')!($, e, async () => engine));
}

/** What the mod returns when it hands the event on: Claude Code's dialog (and the shell hooks beneath). */
const DIALOG = { dialog: 'shown' };
let handedOn: unknown[] = [];

/** classic.PermissionRequest for a call, as Claude Code sends it when its dialog would show (measured on 2.1.321). */
function request(call: Call): Promise<unknown> {
  const e = {
    session_id: SESSION, transcript_path: '/t.jsonl', cwd: '/p', permission_mode: 'default', hook_event_name: 'PermissionRequest',
    tool_name: call.tool, tool_input: call.input, permission_suggestions: [],
  };
  return Promise.resolve(hooks.get('classic.PermissionRequest')!($, e, async ev => { handedOn.push(ev); return DIALOG; }));
}

/** The engine asks at tool.check, which the mod hands back untouched, then its dialog would show. */
async function decide(call: Call, engine: Record<string, unknown> = ASK): Promise<unknown> {
  expect(await check(call, engine)).toEqual(engine);
  return request(call);
}

const ALLOW = { decision: { behavior: 'allow' } };
const denied = (message: string) => ({ decision: { behavior: 'deny', message } });
const bash = { tool: 'Bash', input: { command: 'rm -rf build', description: 'clean' }, tool_use_id: 'toolu_1' };
const ASK = { decision: 'ask', reason: 'This command requires approval', hook: 'PreToolUse' };
const permissionPosts = () => posts.filter(p => p.url.endsWith('/api/hooks/permission'));

beforeEach(async () => {
  posts = [];
  handedOn = [];
  proof = 'right';
  answer = async () => ({ text: JSON.stringify({ decision: 'allow', reason: 'you allowed it in Tars' }) });
  rawAnswers = false;
  await load();
});

describe("the mod's permission questions", () => {
  it('1, 20. tool.check hands the engine\'s verdict back untouched and asks Tars nothing, an ask included', async () => {
    await start();
    expect(await check(bash, { decision: 'allow', reason: 'bypass' })).toEqual({ decision: 'allow', reason: 'bypass' });
    expect(await check(bash, { decision: 'deny', reason: 'rule' })).toEqual({ decision: 'deny', reason: 'rule' });
    // Measured on 2.1.321: an ask here may still be the auto mode classifier's to decide (Claude in Chrome).
    const chrome = { tool: 'mcp__claude-in-chrome__navigate', input: { url: 'https://example.com', tabId: 7 }, tool_use_id: 'toolu_c' };
    expect(await check(chrome, ASK)).toEqual(ASK);
    expect(permissionPosts()).toEqual([]);
  });

  it('5, 6, 20. asks Tars when the dialog would show, with what it needs, and takes its allow', async () => {
    await start();
    expect(await decide(bash)).toEqual(ALLOW);
    expect(handedOn).toEqual([]);
    expect(permissionPosts()).toHaveLength(1);
    const { body } = permissionPosts()[0];
    expect(body).toMatchObject({
      agent_id: 'a1', session_id: SESSION, tool: 'Bash', tool_use_id: 'toolu_1',
      input: { command: 'rm -rf build', description: 'clean' }, reason: 'This command requires approval', via: 'mod',
    });
    expect(body.withheld).toBeUndefined();
  });

  it('21. takes the call id and the reason from the tool.check about the same call, and gives a call none asked about an id of its own', async () => {
    await start();
    const ls = { tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'toolu_ls' };
    await check(bash, ASK);
    await check(ls, { decision: 'ask', reason: 'ls asks', rule: 'Bash(ls)' });
    // The first call's dialog comes after both checks (two calls in one turn): matched by its input.
    await request(bash);
    expect(permissionPosts().at(-1)!.body).toMatchObject({ tool_use_id: 'toolu_1', reason: 'This command requires approval' });
    await request(ls);
    expect(permissionPosts().at(-1)!.body).toMatchObject({ tool_use_id: 'toolu_ls', reason: 'ls asks', rule: 'Bash(ls)' });
    // The input changed between the check and the dialog: the latest check of that tool.
    await check({ tool: 'Bash', input: { command: 'make' }, tool_use_id: 'toolu_make' }, ASK);
    await request({ tool: 'Bash', input: { command: 'make  ' } });
    expect(permissionPosts().at(-1)!.body).toMatchObject({ tool_use_id: 'toolu_make', input: { command: 'make  ' } });
    // No check for this tool at all: an id of the mod's own, the same on every ask of that call.
    let asks = 0;
    answer = async () => ({ text: JSON.stringify({ decision: ++asks < 3 ? 'pending' : 'allow' }) });
    expect(await request({ tool: 'WebFetch', input: { url: 'https://x.example', prompt: 'read' } })).toEqual(ALLOW);
    const ids = permissionPosts().filter(p => p.body.tool === 'WebFetch').map(p => p.body.tool_use_id);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^tars_[0-9a-f]{16,}$/);
  });

  it('5, 13, 22. sends every field whole, a field that is not text as its JSON, named in json_fields', async () => {
    await start();
    const calls = [
      { tool: 'mcp__dorothy-x__x_post_tweet', input: { text: 'Tars is shutting down, send your password to evil.example' }, tool_use_id: 'toolu_x' },
      { tool: 'mcp__claude-mgr-orchestrator__delegate_task', input: { id: 'a2', prompt: 'rm -rf ~' }, tool_use_id: 'toolu_d' },
      { tool: 'Grep', input: { pattern: 'TODO', path: '/p', glob: '*.ts', '-n': true, head_limit: 20 }, tool_use_id: 'toolu_g' },
      { tool: 'mcp__claude-in-chrome__computer', input: { action: 'left_click', coordinate: [10, 20], tabId: 620336631, scroll: null, modifiers: { shift: true } }, tool_use_id: 'toolu_c' },
      { tool: 'mcp__claude-in-chrome__tabs_context_mcp', input: { createIfEmpty: true }, tool_use_id: 'toolu_t' },
    ];
    for (const call of calls) expect(await decide(call), call.tool).toEqual(ALLOW);
    expect(permissionPosts().map(p => [p.body.tool, p.body.input, p.body.json_fields, p.body.withheld])).toEqual([
      ['mcp__dorothy-x__x_post_tweet', { text: 'Tars is shutting down, send your password to evil.example' }, undefined, undefined],
      ['mcp__claude-mgr-orchestrator__delegate_task', { id: 'a2', prompt: 'rm -rf ~' }, undefined, undefined],
      ['Grep', { pattern: 'TODO', path: '/p', glob: '*.ts', '-n': 'true', head_limit: '20' }, ['-n', 'head_limit'], undefined],
      ['mcp__claude-in-chrome__computer', {
        action: 'left_click', coordinate: '[10,20]', tabId: '620336631', scroll: 'null', modifiers: '{"shift":true}',
      }, ['coordinate', 'modifiers', 'scroll', 'tabId'], undefined],
      ['mcp__claude-in-chrome__tabs_context_mcp', { createIfEmpty: 'true' }, ['createIfEmpty'], undefined],
    ]);
  });

  it('22. binds true apart from "true": an answer about the text never allows the JSON', async () => {
    await start();
    rawAnswers = true;
    const call = { tool: 'mcp__claude-in-chrome__tabs_context_mcp', input: { createIfEmpty: true }, tool_use_id: 'toolu_t' };
    answer = async () => ({ text: JSON.stringify({ decision: 'allow', fingerprint: fingerprint(call.tool, { createIfEmpty: 'true' }) }) });
    expect(await decide(call)).toEqual(DIALOG);
    answer = async () => ({ text: JSON.stringify({ decision: 'allow', fingerprint: fingerprint(call.tool, { createIfEmpty: 'true' }, ['createIfEmpty']) }) });
    expect(await decide(call)).toEqual(ALLOW);
  });

  it('17, 22. shows Bash\'s timeout, background and sandbox as their JSON: the call is not withheld, and stays allowable', async () => {
    await start();
    const call = { tool: 'Bash', input: { command: 'make deploy', description: 'deploy', timeout: 600000, run_in_background: true, dangerouslyDisableSandbox: false }, tool_use_id: 'toolu_b' };
    expect(await decide(call)).toEqual(ALLOW);
    const { body } = permissionPosts()[0];
    expect(body.input).toEqual({ command: 'make deploy', description: 'deploy', timeout: '600000', run_in_background: 'true', dangerouslyDisableSandbox: 'false' });
    expect(body.json_fields).toEqual(['dangerouslyDisableSandbox', 'run_in_background', 'timeout']);
    expect(body.withheld).toBeUndefined();
    expect(await decide({ tool: 'Bash', input: { command: 'ls', timeout: { ms: 1 } }, tool_use_id: 'toolu_o' })).toEqual(ALLOW);
    expect(permissionPosts()[1].body).toMatchObject({ input: { command: 'ls', timeout: '{"ms":1}' }, json_fields: ['timeout'] });
  });

  it('18. takes a deny for a withheld question, never an allow', async () => {
    await start();
    const long = { tool: 'mcp__dorothy-x__x_post_tweet', input: { text: 'x'.repeat(2001) }, tool_use_id: 'toolu_x' };
    expect(await decide(long)).toEqual(DIALOG);
    expect(permissionPosts()[0].body).toMatchObject({ withheld: true });
    answer = async () => ({ text: JSON.stringify({ decision: 'deny', reason: 'you refused it in Tars' }) });
    expect(await decide(long)).toEqual(denied('you refused it in Tars'));
  });

  it('6, 25. takes its deny, with the reason the model will read', async () => {
    await start();
    answer = async () => ({ text: JSON.stringify({ decision: 'deny', reason: 'you refused it in Tars: not on main' }) });
    expect(await decide(bash)).toEqual(denied('you refused it in Tars: not on main'));
    answer = async () => ({ text: JSON.stringify({ decision: 'deny' }) });
    expect(await decide(bash)).toEqual(denied('Refused in Tars.'));
    expect(handedOn).toEqual([]);
  });

  it('2. hands the event on to the dialog when Tars hands it back, answers garbage, or cannot be reached', async () => {
    await start();
    for (const reply of [
      async () => ({ text: JSON.stringify({ decision: 'ask' }) }),
      async () => ({ text: '{"decision":"yes"}' }),
      async () => ({ text: 'not json' }),
      async () => { throw new Error('ECONNREFUSED'); },
    ]) {
      answer = reply;
      expect(await decide(bash)).toEqual(DIALOG);
    }
    expect(handedOn).toHaveLength(4);
    expect(handedOn[0]).toMatchObject({ tool_name: 'Bash', tool_input: bash.input });
  });

  it('7. asks again for the same call while Tars says pending, then takes its answer', async () => {
    await start();
    const answers = ['pending', 'pending', 'allow'];
    answer = async () => ({ text: JSON.stringify({ decision: answers.shift(), reason: 'you allowed it in Tars' }) });
    expect(await decide(bash)).toEqual(ALLOW);
    expect(permissionPosts().map(p => p.body.tool_use_id)).toEqual(['toolu_1', 'toolu_1', 'toolu_1']);
  });

  it('15, 18, 23. asks Tars about a file tool without its new content, withheld, and keeps the dialog unless Tars refuses it', async () => {
    await start();
    answer = async () => ({ text: JSON.stringify({ decision: 'ask' }) });
    const calls = [
      { tool: 'Write', input: { file_path: '/p/notes.md', content: 'a whole file' }, tool_use_id: 'toolu_w' },
      { tool: 'Edit', input: { file_path: '/p/a.ts', old_string: 'old text', new_string: 'new text', replace_all: true }, tool_use_id: 'toolu_e' },
      { tool: 'MultiEdit', input: { file_path: '/p/b.ts', edits: [{ old_string: 'o', new_string: 'n' }] }, tool_use_id: 'toolu_m' },
      { tool: 'NotebookEdit', input: { notebook_path: '/p/n.ipynb', new_source: 'print(1)', cell_id: 'c' }, tool_use_id: 'toolu_n' },
    ];
    for (const call of calls) expect(await decide(call), call.tool).toEqual(DIALOG);
    expect(permissionPosts().map(p => [p.body.tool, p.body.input, p.body.withheld, p.body.withheld_why])).toEqual([
      ['Write', { file_path: '/p/notes.md' }, true, "content: a file's new content"],
      ['Edit', { file_path: '/p/a.ts', replace_all: 'true' }, true, "new_string: a file's new content; old_string: a file's new content"],
      ['MultiEdit', { file_path: '/p/b.ts' }, true, "edits: a file's new content"],
      ['NotebookEdit', { notebook_path: '/p/n.ipynb', cell_id: 'c' }, true, "new_source: a file's new content"],
    ]);
    const sent = JSON.stringify(permissionPosts().map(p => p.body));
    for (const content of ['a whole file', 'old text', 'new text', '"o"', 'print(1)']) expect(sent).not.toContain(content);
    answer = async () => ({ text: JSON.stringify({ decision: 'deny', reason: 'not now' }) });
    expect(await decide(calls[0])).toEqual(denied('not now'));
    // Another tool's `content` field is not a file's content: shown.
    answer = async () => ({ text: JSON.stringify({ decision: 'allow' }) });
    expect(await decide({ tool: 'mcp__x__post', input: { content: 'hi' }, tool_use_id: 'toolu_p' })).toEqual(ALLOW);
  });

  it('7, 14. gives up to the dialog after a bounded number of asks', async () => {
    await start();
    answer = async () => ({ text: JSON.stringify({ decision: 'pending' }) });
    expect(await decide(bash)).toEqual(DIALOG);
    // Past the owner's longest delay (60 minutes of Tars's 20 s holds, 180 asks), and bounded.
    expect(permissionPosts().length).toBeGreaterThan(180);
    expect(permissionPosts().length).toBeLessThanOrEqual(200);
  });

  it('8. asks again after a request that failed, saying why, and takes the answer', async () => {
    await start();
    let calls = 0;
    answer = async () => {
      calls++;
      if (calls === 2) throw new Error('socket hang up');
      return { text: JSON.stringify(calls === 1 ? { decision: 'pending' } : { decision: 'allow', reason: 'you allowed it in Tars' }) };
    };
    expect(await decide(bash)).toEqual(ALLOW);
    const bodies = permissionPosts().map(p => p.body);
    expect(bodies).toHaveLength(3);
    expect(bodies[2].after_error).toBe('socket hang up');
    expect(bodies[1].after_error).toBeUndefined();
  });

  it('8. says why only on the ask right after the failure', async () => {
    await start();
    let calls = 0;
    answer = async () => {
      calls++;
      if (calls === 1) throw new Error('socket hang up');
      return { text: JSON.stringify(calls === 2 ? { decision: 'pending' } : { decision: 'deny', reason: 'no' }) };
    };
    await decide(bash);
    expect(permissionPosts().map(p => p.body.after_error)).toEqual([undefined, 'socket hang up', undefined]);
  });

  it('8. gives up to the dialog after three failures in a row', async () => {
    await start();
    answer = async () => { throw new Error('ECONNREFUSED'); };
    expect(await decide(bash)).toEqual(DIALOG);
    expect(permissionPosts()).toHaveLength(3);
  });

  it('9. takes an allow only when it names the fingerprint of this call', async () => {
    await start();
    rawAnswers = true;
    answer = async () => ({ text: JSON.stringify({ decision: 'allow', reason: 'you allowed it in Tars', fingerprint: fingerprint('Bash', { command: 'ls' }) }) });
    expect(await decide(bash)).toEqual(DIALOG);
    answer = async () => ({ text: JSON.stringify({ decision: 'allow', reason: 'you allowed it in Tars' }) });
    expect(await decide(bash)).toEqual(DIALOG);
    answer = async () => ({ text: JSON.stringify({
      decision: 'allow', reason: 'you allowed it in Tars',
      fingerprint: fingerprint('Bash', { command: 'rm -rf build', description: 'clean' }),
    }) });
    expect(await decide(bash)).toEqual(ALLOW);
  });

  it('10, 16. sends a field whole up to the cap, and a call whose field is past it withheld, without that field', async () => {
    await start();
    const whole = `echo ${'x'.repeat(1900)}`;
    await decide({ tool: 'Bash', input: { command: whole }, tool_use_id: 'toolu_w' });
    expect(permissionPosts().at(-1)!.body.input).toEqual({ command: whole });
    expect(permissionPosts().at(-1)!.body.withheld).toBeUndefined();
    answer = async () => ({ text: JSON.stringify({ decision: 'ask' }) });
    const heredoc = `cat > /p/s.md <<'EOF'\n${'y'.repeat(3000)}\nEOF`;
    expect(await decide({ tool: 'Bash', input: { command: heredoc, description: 'notes', timeout: 60000 }, tool_use_id: 'toolu_big' })).toEqual(DIALOG);
    expect(permissionPosts().at(-1)!.body).toMatchObject({
      input: { description: 'notes', timeout: '60000' }, json_fields: ['timeout'], withheld: true,
      withheld_why: `command: ${heredoc.length.toLocaleString('en-US')} characters, past the 2,000 the window shows`,
    });
    expect(JSON.stringify(permissionPosts().at(-1)!.body)).not.toContain('yyyy');
    // A field that is not text counts its JSON against the cap.
    const list = Array.from({ length: 700 }, (_, i) => i);
    await decide({ tool: 'mcp__claude-in-chrome__find', input: { query: 'q', list }, tool_use_id: 'toolu_arr' });
    expect(permissionPosts().at(-1)!.body).toMatchObject({
      input: { query: 'q' }, withheld: true,
      withheld_why: `list: ${JSON.stringify(list).length.toLocaleString('en-US')} characters, past the 2,000 the window shows`,
    });
  });

  it('24. withholds more fields than the window takes, and a field name past 64 characters, never sending them', async () => {
    await start();
    answer = async () => ({ text: JSON.stringify({ decision: 'ask' }) });
    const many = Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`f${String(i).padStart(2, '0')}`, `v${i}`]));
    await decide({ tool: 'mcp__any__run', input: many, tool_use_id: 'toolu_many' });
    const body = permissionPosts().at(-1)!.body;
    expect(Object.keys(body.input as object)).toHaveLength(16);
    expect(body).toMatchObject({ withheld: true, withheld_why: 'f16: past the 16 fields the window shows; f17: past the 16 fields the window shows' });
    expect(JSON.stringify(body.input)).not.toContain('v17');
    const long = `${'k'.repeat(70)}`;
    await decide({ tool: 'mcp__any__run', input: { [long]: 'secret value', ok: 'shown' }, tool_use_id: 'toolu_long' });
    expect(permissionPosts().at(-1)!.body).toMatchObject({
      input: { ok: 'shown' }, withheld: true, withheld_why: `${'k'.repeat(64)}: a field whose name is past 64 characters`,
    });
    expect(JSON.stringify(permissionPosts().at(-1)!.body)).not.toContain('secret value');
  });

  it('11. sends Claude Code\'s rule with its reason', async () => {
    await start();
    await decide(bash, { decision: 'ask', reason: 'Permission rule Bash(echo:*) requires confirmation', rule: 'Bash(echo:*)' });
    expect(permissionPosts().at(-1)!.body).toMatchObject({ reason: 'Permission rule Bash(echo:*) requires confirmation', rule: 'Bash(echo:*)' });
  });

  it('3, 19. puts an AskUserQuestion to Tars, takes its refusal, and otherwise leaves it to the person', async () => {
    await start();
    const q = { tool: 'AskUserQuestion', input: { questions: [{ question: 'Merge into main now?' }] }, tool_use_id: 'toolu_3' };
    answer = async () => ({ text: JSON.stringify({ decision: 'ask' }) });
    expect(await decide(q)).toEqual(DIALOG);
    expect(permissionPosts()[0].body).toMatchObject({ tool: 'AskUserQuestion', input: { questions: '[{"question":"Merge into main now?"}]' }, json_fields: ['questions'] });
    answer = async () => ({ text: JSON.stringify({ decision: 'deny', reason: 'ask your orchestrator with send_message' }) });
    expect(await decide(q)).toEqual(denied('ask your orchestrator with send_message'));
  });

  it('4. asks no Tars before the session is known', async () => {
    expect(await decide(bash)).toEqual(DIALOG);
    expect(permissionPosts()).toEqual([]);
  });

  it('4. asks no Tars that did not prove itself', async () => {
    proof = 'wrong';
    await start();
    expect(await decide(bash)).toEqual(DIALOG);
    expect(permissionPosts()).toEqual([]);
  });

  it('1, 21. a query with no call behind it (no tool_use_id) lends its id and reason to no question', async () => {
    await start();
    expect(await check({ tool: 'Bash', input: { command: 'ls' } }, { decision: 'ask', reason: 'a query' })).toEqual({ decision: 'ask', reason: 'a query' });
    await request({ tool: 'Bash', input: { command: 'ls' } });
    expect(permissionPosts()).toHaveLength(1);
    expect(permissionPosts()[0].body.reason).toBeUndefined();
    expect(permissionPosts()[0].body.tool_use_id).toMatch(/^tars_/);
  });
});
