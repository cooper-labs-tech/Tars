import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Every place the main process and the MCP servers read the role, classified
 * (ORCHESTRATOR-PER-CHAT.md v2.2, 4.2, "Roles: runners are workers with
 * powers", PR D of 2.0.0).
 *
 * A chat's runner is stored as a worker with `kind: 'chat'`. It gets the
 * orchestrator's powers, through hasOrchestratorPowers in core/agent-role.ts:
 * the orchestration instructions, the editing tools taken away (the PTY's
 * --disallowed-tools, the ACP deny list), the right to write to and to ask
 * the user, and a worker's message to it being a report. It never gets the
 * orchestrator's identity: THE project's orchestrator, the one assignRole
 * keeps unique, which never sleeps, is the bots' target and gets the Telegram
 * reply, is told a stalled worker and the kanban notes, and wears the crown in
 * the bots' listings. One predicate read in the wrong place gives a runner the
 * one or takes the other from it, and nothing else in the suite would notice,
 * so the sites are listed here from the source, each with what it decides.
 * The design's table counted 24; the source has more (the bots' own listings,
 * the chats' migration, the bus's global room, the routing of a message that
 * names no project, the wiring), all below.
 *
 * How it fails, written before the code (2026-10-12):
 * 1. A powers site still reads the role (isSuperAgent, or a role held against
 *    'orchestrator'): a runner starts without the orchestrator's instructions,
 *    edits files itself, is refused the user, or a worker's report to it is
 *    queued as a request to it.
 * 2. An identity site reads hasOrchestratorPowers: runners never sleep, take
 *    the bots' messages and the Telegram reply, wear the crown, are told the
 *    stalls and the kanban notes, or the one orchestrator per project is
 *    counted among them.
 * 3. A powers site reads the predicate and the role beside it, and whichever
 *    comes first decides.
 * 4. A new site appears that nobody classified: whichever predicate it reads
 *    was chosen without this table.
 * 5. A classified site disappears, moves or changes shape, and the table goes
 *    on vouching for a line that is not there.
 * 6. A site is copied, and the copy passes as the one classified.
 * 7. The role is read without a call (`.filter(isSuperAgent)`), with double
 *    quotes, other spacing, or the other way round, and the scan misses it.
 * 8. A definition changes under its sites: isSuperAgent comes to read the
 *    kind, getSuperAgent to return a runner, or hasOrchestratorPowers stops
 *    reading one of the two.
 * 9. The scan reads nothing, or not the MCP servers, or electron/dist besides,
 *    and every check passes on a list that is empty or wrong.
 *
 * Comments are read too: one that says what the role is equal to is part of
 * the role's contract, and a reader takes its word for it.
 */

type Category =
  /** A power a chat's runner shares with the orchestrator: reads hasOrchestratorPowers and nothing else. */
  | 'powers'
  /** THE project's orchestrator: never reads hasOrchestratorPowers. */
  | 'identity'
  /** How the bots' listings show THE orchestrator (the crown, the order, the team): never hasOrchestratorPowers. */
  | 'team-list'
  /** Where a predicate is defined or handed on: written out in full. */
  | 'definition'
  /** What a type's documentation says the role is: written out in full. */
  | 'type';

interface Site {
  /** From the repository's root. */
  file: string;
  /**
   * The line, trimmed, or a piece of it no other site of the file has. `…`
   * stands for the role read the line makes, whichever it is, so that a site
   * is found before and after it changes predicate and the check below, not
   * the match, says whether it reads the right one. A definition or a type is
   * written out in full, without `…`: its words are what it guarantees.
   */
  line: string;
  is: Category;
  /** What the site decides. */
  why: string;
  /** How many lines of the file it is, when it is more than one. */
  times?: number;
}

const SITES: Site[] = [
  // core/
  { file: 'electron/core/agent-manager.ts', line: 'const conversing = …;', is: 'powers', why: 'no desktop notification for the turns of the user\'s own conversations' },
  { file: 'electron/core/agent-manager.ts', line: 'const isSuper = …;', is: 'identity', why: 'the reply sent back to Telegram: the bots\' target' },
  { file: 'electron/core/agent-manager.ts', line: 'if (superAgentTelegramTask && …) {', is: 'identity', why: 'the output kept for the Telegram reply' },
  { file: 'electron/core/agent-restart.ts', line: 'orchestrator: …,', is: 'powers', why: 'the launch flag a restart compares: the instructions and the denied tools' },
  { file: 'electron/services/api-routes/heavy-slot-routes.ts', line: 'orchestrator: …, terminalPid: terminal?.pid,', is: 'powers', why: 'the heavy-run slot: who may ask for a release gate, ahead of ordinary work' },
  { file: 'electron/core/agent-update.ts', line: 'const demoted = assignRole(agent, role ?? (… ? \'orchestrator\' : \'worker\'), agents.values());', is: 'identity', why: 'agent:update and update_agent keep the role, and one orchestrator per project' },
  { file: 'electron/core/agent-role.ts', line: 'if (… || params.role === \'worker\') return params.role;', is: 'identity', why: 'requestedRole: the role a create or an update names' },
  { file: 'electron/core/agent-role.ts', line: 'agent.orchestratorMode = …;', is: 'identity', why: 'the toggle\'s old field follows the role' },
  { file: 'electron/core/agent-role.ts', line: 'if (…) return [];', is: 'identity', why: 'assignRole: only a new orchestrator takes the role from another' },
  { file: 'electron/core/agent-role.ts', line: 'if (other.id === agent.id || … || other.projectPath !== agent.projectPath) continue;', is: 'identity', why: 'assignRole: one orchestrator per project' },
  { file: 'electron/core/agent-role.ts', line: 'if (… || agent.role === \'worker\') return agent.role;', is: 'identity', why: 'the migration of a version 2 agents.json' },
  { file: 'electron/core/agent-role.ts', line: '* (getSuperAgent). Returns the agents that lost it.', is: 'identity', why: 'rolesOnLoad keeps the orchestrator getSuperAgent finds first' },
  { file: 'electron/core/agent-role.ts', line: ': … ? \'orchestrator\' : \'worker\');', is: 'identity', why: 'rolesOnLoad: the stored role' },
  { file: 'electron/core/agent-role.ts', line: 'if (…) continue;', is: 'identity', why: 'rolesOnLoad: one orchestrator per project' },
  { file: 'electron/core/agent-role.ts', line: 'export function hasOrchestratorPowers(agent: { role?: string; kind?: string }): boolean {', is: 'definition', why: 'the powers' },
  { file: 'electron/core/agent-role.ts', line: 'return agent.role === \'orchestrator\' || agent.kind === \'chat\';', is: 'definition', why: 'the powers: the orchestrator and a chat\'s runner' },
  { file: 'electron/core/chat-slots.ts', line: '? … && agent.kind !== \'chat\'', is: 'identity', why: 'the Audit\'s Info on #361: Main\'s record runs on the project\'s orchestrator, never on another agent it names' },
  { file: 'electron/core/reply-target.ts', line: 'const lead = [...fleet.values()].find((a) => … && a.kind !== \'chat\' && a.projectPath === caller.projectPath);', is: 'identity', why: 'R5: the project\'s orchestrator a reply to "orchestrator" falls back to' },
  { file: 'electron/core/reply-target.ts', line: 'if (asker && asker.projectPath === caller.projectPath && (toRequester || …)) {', is: 'powers', why: 'R5: an asker with the orchestrator\'s powers takes a reply to "orchestrator", a chat\'s runner included' },
  { file: 'electron/core/one-task.ts', line: "return caller.kind === 'tars' || caller.agent.id === target.id || …;", is: 'powers', why: 'a worker never orders work from another agent, nor stops one: who hands an agent work and stops it' },
  { file: 'electron/core/one-task.ts', line: 'return caller.requestedBy?.agentId === target.id || (… && target.projectPath === caller.projectPath);', is: 'powers', why: 'a worker writing to whoever leads it reports: not a note' },
  { file: 'electron/core/task-cancel.ts', line: 'if (caller && … && caller.kind !== \'chat\' && caller.projectPath === workerProject) {', is: 'identity', why: 'R6: the project\'s persistent orchestrator may cancel any chat\'s task, with a reason: a request and a task waiting its turn alike (the Audit\'s L2 on #449)' },

  // handlers/
  { file: 'electron/handlers/chat-handlers.ts', line: 'const orchestrators = (): OrchestratorFacts[] => [...agents.values()].filter((a) => … && a.kind !== \'chat\').map((a) => ({', is: 'identity', why: 'the orchestrators whose conversation is their project\'s chat #1, Main' },
  { file: 'electron/handlers/ipc-handlers.ts', line: 'isSuperAgent,', is: 'definition', why: 'handed in by main.ts, for the Telegram buffer' },
  { file: 'electron/handlers/ipc-handlers.ts', line: 'if (getSuperAgentTelegramTask() && …) {', is: 'identity', why: 'the output kept for the Telegram reply', times: 2 },
  { file: 'electron/handlers/ipc-handlers.ts', line: 'const isSuperAgentCheck = …;', is: 'powers', why: 'agent:start: the instructions, the skills prefix, the denied tools' },
  { file: 'electron/handlers/team-template-handlers.ts', line: 'if (… || member.role === \'worker\') return member;', is: 'identity', why: 'a template\'s orchestrator member' },
  { file: 'electron/handlers/team-template-handlers.ts', line: 'return { ...member, role, orchestratorMode: … || undefined };', is: 'identity', why: 'a template\'s orchestrator member' },
  { file: 'electron/handlers/team-template-handlers.ts', line: 'orchestratorMode: … || undefined,', is: 'identity', why: 'a template\'s orchestrator member' },

  // main.ts
  { file: 'electron/main.ts', line: '() => getSuperAgent(agents),', is: 'identity', why: 'the Telegram bot\'s orchestrator' },
  { file: 'electron/main.ts', line: 'isSuperAgent,', is: 'definition', why: 'handed to the IPC handlers' },

  // services/
  { file: 'electron/core/chat-inbox.ts', line: 'return [...fleet].find((a) => … && a.kind !== \'chat\' && sameProject(a.projectPath, projectPath));', is: 'identity', why: 'the project\'s orchestrator: Main\'s agent, and whom every sender reaches when the project has no chats (PR F)' },
  { file: 'electron/services/chat-runners.ts', line: 'return [...agents.values()].find((a) => … && a.kind !== \'chat\' && a.projectPath === projectPath);', is: 'identity', why: 'the project\'s orchestrator a runner is launched like' },
  { file: 'electron/services/chat-runners.ts', line: 'if (!lead || …) return;', is: 'identity', why: 'only the project\'s orchestrator passes its configuration to the runners' },
  { file: 'electron/services/acp/delegate.ts', line: 'denyTools: … ? ORCHESTRATOR_DENY : undefined,', is: 'powers', why: 'the tools an ACP run is denied' },
  { file: 'electron/services/agent-guide.ts', line: 'const role: GuideRole = … ? \'orchestrator\' : \'worker\';', is: 'powers', why: 'the identity\'s How Tars works section: what an orchestrator uses, a chat\'s runner included' },
  { file: 'electron/services/agent-guide.ts', line: 'if (…) {', is: 'definition', why: 'identitySection: the role handed in by agentGuideSection, read from hasOrchestratorPowers' },
  { file: 'electron/services/agent-sleep.ts', line: 'orchestrator: …,', is: 'identity', why: 'the sleep rule: the orchestrator never sleeps' },
  { file: 'electron/services/agent-sleep.ts', line: '.filter((a) => atRest(a) && !… && a.ptyId);', is: 'identity', why: 'who may be put to sleep' },
  { file: 'electron/services/api-routes/agent-routes.ts', line: 'const isSuperAgentApi = …;', is: 'powers', why: 'spawnAgentSession: the instructions, the denied tools' },
  { file: 'electron/services/api-routes/agent-routes.ts', line: '|| (… && agent.projectPath === caller.projectPath))) return undefined;', is: 'powers', why: 'a worker writing to it reports, and asks nothing' },
  { file: 'electron/services/api-routes/agent-routes.ts', line: 'if (!caller || … || isReportTo(caller, agent)) return undefined;', is: 'powers', why: 'what a worker sends another worker is a note, typed once its turn ends' },
  { file: 'electron/services/api-routes/agent-routes.ts', line: 'return caller && !… && isReportTo(caller, agent) ? caller : undefined;', is: 'powers', why: 'a worker writing to whoever leads it reports: information, never a task in that agent\'s queue' },
  { file: 'electron/services/api-routes/agent-routes.ts', line: 'const isOrchestrator = …;', is: 'powers', why: 'the bootstrap\'s orchestration rules' },
  { file: 'electron/services/api-routes/agent-routes.ts', line: 'if (…) {', is: 'identity', why: 'POST /api/agents never makes an orchestrator' },
  { file: 'electron/services/api-routes/agent-routes.ts', line: 'if (driver.kind === \'agent\' && !…) {', is: 'powers', why: 'update_agent: who changes an agent\'s settings, as who hands it work' },
  { file: 'electron/services/api-routes/agent-routes.ts', line: 'const withPowers = …;', is: 'powers', why: 'update_agent: an agent with the orchestrator\'s powers is changed in the window only' },
  { file: 'electron/services/api-routes/telegram-routes.ts', line: 'if (!caller || !…) {', is: 'powers', why: 'who writes to the user through the relay' },
  { file: 'electron/services/bot-core.ts', line: 'group = [...group].sort((a, b) => (… ? 1 : 0) - (… ? 1 : 0));', is: 'team-list', why: 'the orchestrator first in each group of the status' },
  { file: 'electron/services/bot-core.ts', line: 'if (…) continue;', is: 'team-list', why: 'the orchestrators left out of each project\'s agents' },
  { file: 'electron/services/bot-core.ts', line: 'systemPromptFile: … && fs.existsSync(getSuperAgentInstructionsPath())', is: 'powers', why: 'a start from a bot: the instructions' },
  { file: 'electron/services/bot-core.ts', line: 'isSuperAgent: …,', is: 'powers', why: 'a start from a bot: the skills prefix' },
  { file: 'electron/services/bot-core.ts', line: 'orchestratorMode: …,', is: 'powers', why: 'a start from a bot: the denied tools' },
  { file: 'electron/services/bot-core.ts', line: 'typeLaunchTask(provider, cli, { prompt: withGuide(agent, provider, task), skills: [...new Set(agent.skills || [])], isSuperAgent: … });', is: 'powers', why: 'a start from a bot on amp: the skills prefix of the task typed in' },
  { file: 'electron/core/typed-task.ts', line: "params: Pick<InteractiveCommandParams, 'prompt' | 'skills' | 'isSuperAgent'>,", is: 'definition', why: 'handed on to the provider, for the skills prefix of a typed task' },
  { file: 'electron/providers/amp-provider.ts', line: "typedTask(params: Pick<InteractiveCommandParams, 'prompt' | 'skills' | 'isSuperAgent'>): string {", is: 'definition', why: 'the skills prefix of the task typed into amp' },
  { file: 'electron/providers/cli-provider.ts', line: "typedTask?(params: Pick<InteractiveCommandParams, 'prompt' | 'skills' | 'isSuperAgent'>): string;", is: 'type', why: 'the task a launch types in' },
  { file: 'electron/services/bus-store.ts', line: 'return all.filter(…).map(a => a.id);', is: 'identity', why: 'the global room\'s members: the projects\' orchestrators' },
  { file: 'electron/services/discord-bot.ts', line: 'const faceOrCrown = (a: AgentStatus) => … ?', is: 'team-list', why: 'the crown' },
  { file: 'electron/services/discord-bot.ts', line: 'if (!…) line += ', is: 'team-list', why: 'no project line for the orchestrator' },
  { file: 'electron/services/orchestrator-routing.ts', line: 'return [...agents.values()].find(a => … && a.projectPath === projectPath);', is: 'identity', why: 'orchestratorOf: where a bot message for a project goes' },
  { file: 'electron/services/orchestrator-routing.ts', line: 'const orchestrators = [...agents.values()].filter(…);', is: 'identity', why: 'a message that names no project goes to the only orchestrator' },
  { file: 'electron/services/slack-bot.ts', line: 'const emoji = … ? \':crown:\' : face(agent);', is: 'identity', why: 'the crown on the answer to a start' },
  { file: 'electron/services/task-watch.ts', line: '|| (… && receiver.projectPath === sender.projectPath);', is: 'powers', why: 'the task ledger: a message to it is a report' },
  { file: 'electron/services/telegram-bot.ts', line: 'const faceOrCrown = (a: AgentStatus) => … ?', is: 'team-list', why: 'the crown' },
  { file: 'electron/services/telegram-bot.ts', line: 'const isSuper = …;', is: 'team-list', why: 'the status line: the crown, and no project' },
  { file: 'electron/services/user-questions.ts', line: 'if (!…) {', is: 'powers', why: 'who asks the user' },

  // types/
  { file: 'electron/types/index.ts', line: "/** The Orchestrator toggle's old field, kept equal to `role === 'orchestrator'`", is: 'type', why: 'orchestratorMode' },
  { file: 'electron/types/index.ts', line: "* it has the orchestrator's powers through hasOrchestratorPowers().", is: 'type', why: 'kind' },
  { file: 'electron/types/team-template.ts', line: "/** The toggle's old name, equal to `role === 'orchestrator'`, for the", is: 'type', why: 'a member\'s orchestratorMode' },

  // utils/
  { file: 'electron/utils/index.ts', line: 'export function isSuperAgent(agent: AgentStatus): boolean {', is: 'definition', why: 'the project\'s orchestrator' },
  { file: 'electron/utils/index.ts', line: 'return agent.role === \'orchestrator\';', is: 'definition', why: 'the project\'s orchestrator: the role and nothing else' },
  { file: 'electron/utils/index.ts', line: 'export function getSuperAgent(agents: Map<string, AgentStatus>, projectPath?: string): AgentStatus | undefined {', is: 'definition', why: 'an orchestrator, first found' },
  { file: 'electron/utils/index.ts', line: 'const orchestrators = Array.from(agents.values()).filter(a => isSuperAgent(a) && a.kind !== \'chat\');', is: 'definition', why: 'an orchestrator, never a chat\'s runner' },
  { file: 'electron/utils/index.ts', line: 'const isSuper = …;', is: 'team-list', why: 'the crown and the project line of Telegram\'s /agents and Slack\'s lists', times: 2 },
];

// ── The scan ───────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, '../../..');

const NAMES = '(?:isSuperAgent|getSuperAgent|hasOrchestratorPowers)';
/** A call, a definition included: `isSuperAgent(agent)`, `function isSuperAgent(`. */
const CALL = new RegExp(`\\b(${NAMES})\\s*\\(`, 'g');
/** A role held against 'orchestrator': either quote, any spacing, either way round. */
const COMPARISON = /\brole\s*[!=]==?\s*(['"])orchestrator\1|(['"])orchestrator\2\s*[!=]==?\s*[\w$.]*\brole\b/g;
/**
 * A predicate handed on uncalled (`.filter(isSuperAgent)`, `{ isSuperAgent }`),
 * and not a property that has its name (`params.isSuperAgent`, `isSuperAgent: true`,
 * `isSuperAgent?: boolean`).
 */
const REFERENCE = new RegExp(`(?<![\\w$.])(${NAMES})\\b(?!\\s*[(:?])`, 'g');
/**
 * An import or a re-export: naming a function there reads nothing. Only its
 * own clause (a name, `{ ... }`, `* as name`) before the `from`, so that it
 * never runs on into the code after an `export`.
 */
const IMPORT = /^[ \t]*(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+)\s+from\s*(['"])[^'"\n]*\1;?/gm;

/** What `…` stands for in a site: a call or a reference of a predicate, or a role held against 'orchestrator'. */
const ROLE_READ = `(?:(?:isSuperAgent|hasOrchestratorPowers)(?:\\s*\\([^()]*\\))?|[\\w$.]*\\brole\\s*[!=]==?\\s*['"]orchestrator['"])`;

type Read = { predicate: 'isSuperAgent' | 'getSuperAgent' | 'hasOrchestratorPowers' | 'role'; text: string };

/** The role reads of one line of code, in the order they come. */
function readsOf(code: string): Read[] {
  const found: Array<Read & { at: number }> = [];
  for (const m of code.matchAll(CALL)) found.push({ predicate: m[1] as Read['predicate'], text: m[0], at: m.index });
  for (const m of code.matchAll(COMPARISON)) found.push({ predicate: 'role', text: m[0], at: m.index });
  for (const m of code.matchAll(REFERENCE)) found.push({ predicate: m[1] as Read['predicate'], text: m[0], at: m.index });
  return found.sort((a, b) => a.at - b.at).map(({ predicate, text }) => ({ predicate, text }));
}

type Occurrence = { file: string; n: number; line: string; reads: Read[] };

function sourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (rel === 'electron/dist' || entry.name === 'node_modules') continue;
        walk(rel);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(rel);
      }
    }
  };
  walk('electron');
  for (const dir of fs.readdirSync(ROOT).filter(d => d.startsWith('mcp-')).sort()) {
    if (fs.existsSync(path.join(ROOT, dir, 'src'))) walk(`${dir}/src`);
  }
  return files.sort();
}

/** A file's lines with its imports blanked, each where it was. */
const codeLines = (text: string) => text.replace(IMPORT, statement => statement.replace(/[^\n]/g, ' ')).split('\n');

function occurrencesIn(file: string): Occurrence[] {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const code = codeLines(text);
  const out: Occurrence[] = [];
  text.split('\n').forEach((line, i) => {
    const reads = readsOf(code[i]);
    if (reads.length > 0) out.push({ file, n: i + 1, line: line.trim(), reads });
  });
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patternOf = (site: Site) => new RegExp(site.line.split('…').map(escape).join(ROLE_READ));
const where = (o: Occurrence) => `${o.file}:${o.n} ${o.line}`;
const named = (site: Site) => `${site.file}: "${site.line}" (${site.is}, ${site.why})`;

const files = sourceFiles();
const occurrences = files.flatMap(occurrencesIn);
const patterns = new Map(SITES.map(site => [site, patternOf(site)]));
/** Each line that reads the role, with the sites of its file that match it. */
const classified = occurrences.map(o => ({
  o,
  sites: SITES.filter(site => site.file === o.file && patterns.get(site)!.test(o.line)),
}));

describe('the sites that read the role (ORCHESTRATOR-PER-CHAT.md 4.2)', () => {
  it('scans electron and every MCP server, not the build, and sees every way of reading the role', () => {
    expect(files).toContain('electron/core/agent-role.ts');
    expect(files.filter(f => f.startsWith('electron/dist/'))).toEqual([]);
    const mcpServers = fs.readdirSync(ROOT).filter(d => d.startsWith('mcp-') && fs.existsSync(path.join(ROOT, d, 'src')));
    expect(mcpServers.length).toBeGreaterThanOrEqual(7);
    for (const server of mcpServers) expect(files.some(f => f.startsWith(`${server}/src/`)), server).toBe(true);

    // Spellings no site uses today, so only this says the scan would see them.
    const predicates = (code: string) => readsOf(code).map(r => r.predicate);
    expect(predicates('if (!isSuperAgent(a) || b.role !== "orchestrator") list.filter(hasOrchestratorPowers);'))
      .toEqual(['isSuperAgent', 'role', 'hasOrchestratorPowers']);
    expect(predicates("const lead = 'orchestrator' === agent.role, x = role==='orchestrator';")).toEqual(['role', 'role']);
    expect(predicates('agents.find(getSuperAgent); const { isSuperAgent } = deps;')).toEqual(['getSuperAgent', 'isSuperAgent']);
    // A property that has the predicate's name, and a longer name, read nothing.
    expect(predicates('params.isSuperAgent && getSuperAgentInstructionsPath(); x = { isSuperAgent: true }; isSuperAgent?: boolean;')).toEqual([]);
    // Nor does an import, however it is written; the code after it still does.
    const sample = [
      'import {', '  isSuperAgent,', '  getSuperAgent,', "} from './utils';",
      "import type { AgentStatus } from './types';", "export { hasOrchestratorPowers } from './core/agent-role';",
      'export interface Deps { /** taken from \'deps\' */', '  isSuperAgent,', '}',
    ].join('\n');
    expect(codeLines(sample).map(line => readsOf(line).length)).toEqual([0, 0, 0, 0, 0, 0, 0, 1, 0]);
  });

  it('finds no site the table does not classify', () => {
    const unclassified = classified.filter(c => c.sites.length === 0).map(c => where(c.o));
    const ambiguous = classified.filter(c => c.sites.length > 1).map(c => `${where(c.o)}: matched by ${c.sites.map(named).join(' and ')}`);
    expect(unclassified, 'a site that reads the role without being classified: add it to SITES, as powers, identity, team-list, definition or type').toEqual([]);
    expect(ambiguous, 'a line two sites match: make one of them longer').toEqual([]);
  });

  it('finds every site the table names, as many times as it says', () => {
    const wrong = SITES.flatMap(site => {
      const lines = classified.filter(c => c.sites.length === 1 && c.sites[0] === site);
      const times = site.times ?? 1;
      return lines.length === times ? [] : [`${named(site)}: ${lines.length} line(s), the table says ${times}${lines.length ? `: ${lines.map(c => c.o.n).join(', ')}` : ''}`];
    });
    expect(wrong, 'a site that moved, changed or went: the table follows the code').toEqual([]);
  });

  it('gives the powers sites hasOrchestratorPowers and nothing else, and the identity and team-list sites never', () => {
    const wrong = classified.filter(c => c.sites.length === 1).flatMap(({ o, sites: [site] }) => {
      const read = o.reads.map(r => r.text.trim()).join(', ');
      if (site.is === 'powers' && !o.reads.every(r => r.predicate === 'hasOrchestratorPowers')) {
        return [`${where(o)}: a powers site (${site.why}) reads ${read}, where it reads hasOrchestratorPowers alone`];
      }
      if ((site.is === 'identity' || site.is === 'team-list') && o.reads.some(r => r.predicate === 'hasOrchestratorPowers')) {
        return [`${where(o)}: ${site.is === 'identity' ? 'an' : 'a'} ${site.is} site (${site.why}) reads ${read}: a chat's runner is not its project's orchestrator`];
      }
      return [];
    });
    expect(wrong).toEqual([]);
  });
});
