import * as path from 'path';
import type { AgentStatus } from '../types';
import { isSuperAgent } from '../utils';

/**
 * Which orchestrator a message from the user is for (point E of DESIGN-RELAIS-HERMES-V2.md).
 *
 * The bots gave a free message to the first orchestrator found, all projects considered: on JeanBrasse's machine an
 * orchestrator of a project at rest, so his messages never reached the one he was writing to. Now a message names its
 * project with "@project text", the same prefix the relay's plugin reads on Telegram; without one, it goes to the
 * fleet's orchestrator only when there is exactly one. Otherwise nobody gets it, and the sender gets the list.
 *
 * A project's name is its folder's, in any case, written as one word: a space, an @, a colon or a comma in it becomes
 * a dash ("o'neil project" is "@o'neil-project"), the form the relay sends and registers too, since nothing can be
 * written after "@" past a space. Two projects with the same name share it, and a message to that name is answered
 * with the list rather than guessed.
 */

export type OrchestratorTarget =
  | { kind: 'found'; orchestrator: AgentStatus; projectPath: string; text: string }
  | { kind: 'no-orchestrator'; projectPath: string; text: string }
  | { kind: 'unknown'; name: string; projects: string[] }
  | { kind: 'ambiguous'; name: string | null; projects: string[] }
  | { kind: 'none'; projects: string[] };

/** "@name text": the name one word glued to the @, some text after it (as hermes-plugins/tars-relay reads it). */
const PREFIX = /^@([^\s@:,]{1,64})(?:[:,]\s*|\s+)(\S[\s\S]*)$/;

/** A project's name, as the user writes it after "@". */
export function projectName(projectPath: string): string {
  return path.basename(projectPath) || projectPath;
}

/** A project's name as the user writes it after "@": its folder's, a dash for each space, @, colon or comma. */
export function projectWord(projectPath: string): string {
  return projectName(projectPath).replace(/[\s@:,]/g, '-').slice(0, 64);
}

/** The names of the fleet's projects as the user writes them, sorted, once each path. */
export function projectNames(agents: Map<string, AgentStatus>): string[] {
  const paths = new Set([...agents.values()].map(a => a.projectPath).filter(Boolean));
  return [...paths].map(projectWord).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/** The orchestrator of a project, never another project's. */
export function orchestratorOf(agents: Map<string, AgentStatus>, projectPath: string): AgentStatus | undefined {
  return [...agents.values()].find(a => isSuperAgent(a) && a.projectPath === projectPath);
}

/** The project the user names: its path, nothing when no project or several have that name. */
function projectsNamed(agents: Map<string, AgentStatus>, name: string): string[] {
  const wanted = name.toLowerCase();
  const paths = new Set([...agents.values()].map(a => a.projectPath).filter(Boolean));
  return [...paths].filter(p => projectWord(p).toLowerCase() === wanted);
}

/** The orchestrator a project's name designates, for a message whose project is already parsed (the relay's). */
export function orchestratorForProject(agents: Map<string, AgentStatus>, name: string, text: string): OrchestratorTarget {
  const named = projectsNamed(agents, name);
  if (named.length === 0) return { kind: 'unknown', name, projects: projectNames(agents) };
  if (named.length > 1) return { kind: 'ambiguous', name, projects: named.map(projectWord).sort() };
  const orchestrator = orchestratorOf(agents, named[0]);
  return orchestrator
    ? { kind: 'found', orchestrator, projectPath: named[0], text }
    : { kind: 'no-orchestrator', projectPath: named[0], text };
}

/** The orchestrator a chat message is for, and its text without the "@project" that named it. */
export function orchestratorForMessage(agents: Map<string, AgentStatus>, message: string): OrchestratorTarget {
  const prefixed = PREFIX.exec(message.trim());
  if (prefixed) return orchestratorForProject(agents, prefixed[1], prefixed[2].trim());
  const orchestrators = [...agents.values()].filter(isSuperAgent);
  if (orchestrators.length === 1) {
    return { kind: 'found', orchestrator: orchestrators[0], projectPath: orchestrators[0].projectPath, text: message.trim() };
  }
  const projects = projectNames(agents);
  return orchestrators.length === 0 ? { kind: 'none', projects } : { kind: 'ambiguous', name: null, projects };
}

/** What the sender is told when a message reaches nobody: which projects exist and how to name one. */
export function whereToWrite(target: Exclude<OrchestratorTarget, { kind: 'found' }>): string {
  const list = 'projects' in target && target.projects.length > 0
    ? `Projects: ${target.projects.map(p => `@${p}`).join(', ')}.`
    : 'Tars has no project yet.';
  switch (target.kind) {
    case 'no-orchestrator':
      return `Project ${projectName(target.projectPath)} has no orchestrator in Tars, so your message reached nobody. Give one of its agents the orchestrator role, then write again.`;
    case 'unknown':
      return `No project is named ${target.name}, so your message reached nobody. Start it with the project's name, as in "@name your message". ${list}`;
    case 'ambiguous':
      return target.name
        ? `More than one project is named ${target.name}, so your message reached nobody. Rename one of their folders to tell them apart. ${list}`
        : `More than one project has an orchestrator, so your message reached nobody. Start it with the project's name, as in "@name your message". ${list}`;
    case 'none':
      return `No project has an orchestrator in Tars, so your message reached nobody. ${list}`;
  }
}
