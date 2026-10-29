import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GUIDE_TOPICS, TOOL_TOPIC, toolsNamedIn, guideIndex, guideTopic, identitySection,
} from '../../../electron/services/agent-guide';

/**
 * The guide every agent reads about Tars (services/agent-guide.ts), and the
 * section of its identity block written from it.
 *
 * How this can fail, written before the code:
 * 1. a bundled MCP server gains a tool and the guide never says what it is for:
 *    agents see a tool nobody explained (the kanban tools were in every CLI, and
 *    no agent had ever filed a task);
 * 2. the guide names a tool no server has (renamed, removed, misspelt): an agent
 *    calls it and fails;
 * 3. a tool points at a topic that does not exist;
 * 4. tars_guide itself is not in the guide;
 * 5. the identity section tells a worker what only an orchestrator can do
 *    (delegate_task, ask_user), or leaves an orchestrator without delegation and
 *    the way to follow a long run (task_status);
 * 6. the section grows past what every session can afford to carry (15 lines);
 * 7. the section does not name the agent's own project folder, or names a
 *    placeholder when there is one, or invents one when there is none;
 * 8. the section points at a topic tars_guide does not have;
 * 9. a topic is not stamped with the version of the Tars that answers, or an
 *    unknown topic answers something instead of nothing;
 * 10. an em or en dash reaches what agents read (CLAUDE.md, "No em dashes").
 *
 * Added at the Audit of #448, before their fixes:
 * 11. a folder Tars could not make is blamed on the project's path ("not
 *     absolute"), and the agent is told something false about its project (L6);
 * 12. the guide says a delegated run of an hour is fine while delegate_task's
 *     default cuts it at 300 s, and never names timeoutSeconds nor its ceiling (M2):
 *     the default and the ceiling it states must be the code's. Since 2.0.4
 *     timeoutSeconds is the tool's wait and no task is stopped at it: the guide
 *     must say so, and no ceiling be left in run-task;
 * 13. the guide says ask_user waits for the answer (it returns at once, and the
 *     answer is typed into the terminal later), offers it to a delegated run (which
 *     is refused) or without the relay, offers the Telegram file tools the relay
 *     takes away (L1), and says memory_read reads one note (it returns the
 *     project's whole digest) (L2);
 *     (13's Telegram file tools went with Tars's own Telegram bot in 2.0.5: no
 *     server has them, which 2 already holds against the guide.)
 * 14. the guide lets an agent make folders at the top of the home folder, or keep
 *     durable files anywhere but the project folder (the maintainer, 2026-10-18).
 *
 * Added with update_agent (2.0.4, 2026-10-19), before it:
 * 15. an orchestrator is never told it can change an agent after creating it, or
 *     is told it can change the role, or that a change of CLI applies to a CLI
 *     at work: update_agent waits for the agent to be stopped (cli_running).
 */

const ROOT = path.resolve(__dirname, '..', '..', '..');

/** Every tool the bundled servers register, read from their sources as tools/list would give it. */
function serverTools(): Map<string, string> {
  const found = new Map<string, string>();
  const servers = fs.readdirSync(ROOT).filter(d => d.startsWith('mcp-') && d !== 'mcp-shared');
  const walk = (dir: string, server: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p, server);
      else if (/\.ts$/.test(entry.name)) {
        const src = fs.readFileSync(p, 'utf8');
        // A row of a registerTools table, and the SDK's registerTool("name", ...).
        for (const m of src.matchAll(/^\s+name: "([a-z]+(?:_[a-z]+)*)",?\s*$/gm)) found.set(m[1], server);
        for (const m of src.matchAll(/registerTool\(\s*"([a-z_]+)"/g)) found.set(m[1], server);
      }
    }
  };
  for (const server of servers) {
    const src = path.join(ROOT, server, 'src');
    if (fs.existsSync(src)) walk(src, server);
  }
  return found;
}

describe('the guide knows every tool an agent can see, and names no other', () => {
  const tools = serverTools();

  it('reads the servers it guards (a reader that finds nothing would pass anything)', () => {
    expect(tools.size).toBeGreaterThan(40);
    expect(tools.get('delegate_task')).toBe('mcp-orchestrator');
    expect(tools.get('create_task')).toBe('mcp-kanban');
    expect(tools.get('memory_search')).toBe('mcp-memory');
  });

  it('has a topic for every tool (1)', () => {
    const missing = [...tools.keys()].filter(t => !(t in TOOL_TOPIC));
    expect(missing).toEqual([]);
  });

  it('lists no tool that no server has (2)', () => {
    expect(Object.keys(TOOL_TOPIC).filter(t => !tools.has(t))).toEqual([]);
    const named = GUIDE_TOPICS.flatMap(t => toolsNamedIn(t.text));
    expect(named.length).toBeGreaterThan(20);
    expect([...new Set(named)].filter(t => !tools.has(t))).toEqual([]);
  });

  it('points every tool at a topic that exists (3), and has tars_guide (4)', () => {
    const ids = new Set(GUIDE_TOPICS.map(t => t.id));
    expect(Object.entries(TOOL_TOPIC).filter(([, topic]) => !ids.has(topic))).toEqual([]);
    expect(tools.get('tars_guide')).toBe('mcp-orchestrator');
    expect(ids.size).toBe(GUIDE_TOPICS.length);
  });
});

describe('the identity section, by role', () => {
  const folder = '/home/u/.tars/project-files/demo-0123456789';

  it('gives an orchestrator delegation, the long run and the user, and a worker none of it (5)', () => {
    const lead = identitySection('orchestrator', folder).join('\n');
    const worker = identitySection('worker', folder).join('\n');
    for (const word of ['delegate_task', 'task_status', 'create_task', 'ask_user', 'tars_guide']) expect(lead).toContain(word);
    for (const word of ['requester', 'assign_task', 'mark_task_done', 'create_task', 'tars_guide']) expect(worker).toContain(word);
    for (const word of ['delegate_task', 'ask_user', 'task_status']) expect(worker).not.toContain(word);
  });

  it('stays within 15 lines (6)', () => {
    expect(identitySection('orchestrator', folder).length).toBeLessThanOrEqual(15);
    expect(identitySection('worker', folder).length).toBeLessThanOrEqual(15);
  });

  it('names the project folder, and says so when there is none (7)', () => {
    expect(identitySection('worker', folder).join('\n')).toContain(folder);
    const none = identitySection('worker', null).join('\n');
    expect(none).not.toContain('project-files');
    expect(none).not.toMatch(/\{folder\}|null|undefined/);
  });

  it('points only at topics tars_guide has (8)', () => {
    const line = identitySection('worker', folder).find(l => l.includes('tars_guide'))!;
    const listed = line.split(':').slice(1).join(':').replace(/\.$/, '').split(',').map(s => s.trim());
    expect(listed.length).toBeGreaterThan(3);
    for (const id of listed) expect(guideTopic(id, '1.0.0', folder)).not.toBeNull();
  });
});

describe('tars_guide answers', () => {
  it('stamps the index and a topic with the version, and an unknown topic with nothing (9)', () => {
    expect(guideIndex('2.0.4')).toMatch(/^Tars 2\.0\.4/);
    for (const t of GUIDE_TOPICS) expect(guideIndex('2.0.4')).toContain(`- ${t.id}: `);
    const topic = guideTopic('project-folder', '2.0.4', '/x/.tars/project-files/demo-0123456789')!;
    expect(topic).toMatch(/^Tars 2\.0\.4, /);
    expect(topic).toContain('/x/.tars/project-files/demo-0123456789');
    expect(topic).not.toContain('{folder}');
    expect(guideTopic('KANBAN ', '2.0.4', null)).toContain('assign_task');
    expect(guideTopic('nope', '2.0.4', null)).toBeNull();
  });

  it('writes no em or en dash anywhere an agent reads it (10)', () => {
    const all = [
      ...GUIDE_TOPICS.flatMap(t => [t.title, t.text]),
      ...identitySection('orchestrator', '/f').concat(identitySection('worker', null)),
      guideIndex('2.0.4'),
    ].join('\n');
    expect(all).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('what the guide says is what the code does (the Audit of #448)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const topic = (id: string) => GUIDE_TOPICS.find(t => t.id === id)!.text;
  const lead = identitySection('orchestrator', '/f').join('\n');

  it('names the reason a folder could not be made, not the path (11)', () => {
    const why = 'Tars could not make /h/.tars/project-files/demo-0123456789: ENOSPC: no space left on device';
    const none = identitySection('worker', null, why).join('\n');
    expect(none).toContain('ENOSPC');
    expect(none).not.toMatch(/absolute/);
    expect(guideTopic('project-folder', '2.0.4', null, why)).toContain('ENOSPC');
    // Without a reason given, the one there is: the path.
    expect(identitySection('worker', null).join('\n')).toMatch(/not absolute/);
  });

  it('states how long delegate_task waits, as the code has it, and that the task is never stopped there (12)', () => {
    // 2.0.4: timeoutSeconds bounds the tool's wait, never the task, which goes on in the agent's terminal.
    const fallback = Number(/prompt, model, timeoutSeconds = (\d+)/.exec(read('mcp-orchestrator/src/tools/agents.ts'))?.[1]);
    expect(fallback, 'the default was not found in delegate_task').toBeGreaterThan(0);
    expect(read('electron/services/api-routes/agent-routes.ts')).not.toMatch(/timeoutSeconds/);
    for (const text of [topic('delegation'), lead]) {
      expect(text).toContain('timeoutSeconds');
      expect(text).toContain(`${fallback} s`);
      expect(text).toMatch(/never stopped there/);
    }
  });

  it('says ask_user returns at once, from a terminal, through the relay; and what memory_read returns (13)', () => {
    const asking = topic('asking-the-user');
    expect(asking).not.toMatch(/waits for the answer/);
    expect(asking).toMatch(/returns at once/);
    // A delegated task runs in the agent's own terminal since 2.0.4: it may ask.
    expect(asking).not.toMatch(/delegated run cannot ask/);
    expect(asking).toMatch(/relay/);
    expect(lead).toMatch(/ask_user.*returns at once/);
    const memory = topic('memory-and-vault');
    expect(memory).not.toMatch(/memory_read` reads one note/);
    expect(memory).toMatch(/memory_read` returns the project's whole digest/);
  });

  it('keeps durable files in the project folder, and no folder at the top of the home folder (14)', () => {
    for (const text of [topic('project-folder'), identitySection('worker', '/f').join('\n')]) {
      expect(text).toMatch(/top of (the|your) home folder/);
    }
  });

  it('tells an orchestrator it changes its agents with update_agent, and what stays the user\'s (15)', () => {
    const delegation = topic('delegation');
    expect(TOOL_TOPIC.update_agent).toBe('delegation');
    expect(delegation).toContain('`update_agent`');
    expect(delegation).toMatch(/update_agent`[^\n]*role[^\n]*Agents page/);
    expect(delegation).toMatch(/update_agent`[^\n]*stop_agent/);
    expect(delegation).toMatch(/update_agent`[^\n]*new conversation/);
  });
});
