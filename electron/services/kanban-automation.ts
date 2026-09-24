/**
 * When a task moves to "planned": the agent for it (an idle one on its project
 * with the required skills, else any idle one on its project, else a new one
 * with those skills), started on it.
 */

import { v4 as uuidv4 } from 'uuid';
import type { AgentStatus, AgentCharacter } from '../types';
import { launchAgent } from '../core/agent-launch';
import type { KanbanTask } from '../handlers/kanban-handlers';
import * as os from 'os';

// Dependencies interface
export interface KanbanAutomationDependencies {
  agents: Map<string, AgentStatus>;
  createAgent: (config: {
    projectPath: string;
    skills: string[];
    character?: AgentCharacter;
    name?: string;
    permissionMode?: 'normal' | 'auto' | 'bypass';
  }) => Promise<AgentStatus>;
  saveAgents: () => void;
}

let deps: KanbanAutomationDependencies | null = null;

/**
 * Initialize the kanban automation service with dependencies
 */
export function initKanbanAutomation(dependencies: KanbanAutomationDependencies): void {
  deps = dependencies;
}

/** An idle agent on the project holding every required skill, else any idle one on it: its id, or null. */
export async function findMatchingAgent(
  projectPath: string,
  requiredSkills: string[]
): Promise<string | null> {
  if (!deps) {
    console.error('Kanban automation not initialized');
    return null;
  }

  const agents = Array.from(deps.agents.values());

  const normalizedProjectPath = normalizePath(projectPath);

  const idleAgents = agents.filter(a => a.status === 'idle');

  if (idleAgents.length === 0) {
    console.log('No idle agents available');
    return null;
  }

  // Priority 1: Idle agent with same project AND has required skills
  if (requiredSkills.length > 0) {
    const matchingWithSkills = idleAgents.find(agent => {
      const agentPath = normalizePath(agent.projectPath);
      const hasMatchingProject = agentPath === normalizedProjectPath;
      const hasRequiredSkills = requiredSkills.every(skill =>
        agent.skills.some(s => s.toLowerCase().includes(skill.toLowerCase()))
      );
      return hasMatchingProject && hasRequiredSkills;
    });

    if (matchingWithSkills) {
      console.log(`Found agent with matching project and skills: ${matchingWithSkills.id}`);
      return matchingWithSkills.id;
    }
  }

  // Priority 2: Idle agent with same project (any skills)
  const matchingProject = idleAgents.find(agent => {
    const agentPath = normalizePath(agent.projectPath);
    return agentPath === normalizedProjectPath;
  });

  if (matchingProject) {
    console.log(`Found agent with matching project: ${matchingProject.id}`);
    return matchingProject.id;
  }

  console.log(`No matching agent found for project: ${projectPath}`);
  return null;
}

/** A new agent for a kanban task, named after it, with its required skills, in 'auto' mode: its id. */
export async function createAgentForTask(task: KanbanTask): Promise<string> {
  if (!deps) {
    throw new Error('Kanban automation not initialized');
  }

  const shortTitle = task.title.length > 20
    ? task.title.substring(0, 20) + '...'
    : task.title;

  const agentName = `Task: ${shortTitle}`;

  const character = selectCharacterForTask(task);

  console.log(`Creating new agent for task: ${task.title}`);

  const agent = await deps.createAgent({
    projectPath: task.projectPath,
    skills: task.requiredSkills,
    character,
    name: agentName,
    permissionMode: 'auto', // Kanban tasks run autonomously
  });

  console.log(`Created agent ${agent.id} for task ${task.id}`);

  return agent.id;
}

/**
 * Start an agent with a task prompt, through the one launch every window uses
 * (core/agent-launch.ts): its own model, effort, MCP servers and provider, where
 * a bare `claude --dangerously-skip-permissions` used to run on the CLI's
 * defaults. The permission it imposed is kept: board tasks run unattended.
 */
export async function startAgentForTask(agentId: string, prompt: string): Promise<void> {
  const result = await launchAgent(agentId, prompt, { permissionMode: 'bypass' });
  if (!result.success) throw new Error(result.error);
}

/**
 * Select an appropriate character based on task characteristics
 */
function selectCharacterForTask(task: KanbanTask): AgentCharacter {
  const labels = task.labels.map(l => l.toLowerCase());
  const title = task.title.toLowerCase();
  const desc = task.description.toLowerCase();

  // Match labels/content to characters
  if (labels.includes('test') || labels.includes('testing') || title.includes('test') || desc.includes('test')) {
    return 'knight'; // Knight for testing/quality
  }

  if (labels.includes('bug') || labels.includes('fix') || title.includes('fix') || title.includes('bug')) {
    return 'ninja'; // Ninja for bug fixes
  }

  if (labels.includes('feature') || title.includes('feature') || title.includes('add') || title.includes('implement')) {
    return 'wizard'; // Wizard for new features
  }

  if (labels.includes('refactor') || title.includes('refactor') || title.includes('cleanup')) {
    return 'robot'; // Robot for refactoring
  }

  if (labels.includes('docs') || labels.includes('documentation') || title.includes('document')) {
    return 'astronaut'; // Astronaut for documentation
  }

  if (labels.includes('security') || title.includes('security') || title.includes('auth')) {
    return 'viking'; // Viking for security
  }

  // Default characters based on priority
  switch (task.priority) {
    case 'high':
      return 'knight';
    case 'low':
      return 'alien';
    default:
      return 'robot';
  }
}

/**
 * Normalize a file path for comparison
 */
function normalizePath(p: string): string {
  // Remove trailing slashes and resolve home directory
  let normalized = p.replace(/\/+$/, '');

  // Expand ~ to home directory
  if (normalized.startsWith('~')) {
    normalized = normalized.replace(/^~/, os.homedir());
  }

  return normalized;
}

// Export for use in handlers
export {
  findMatchingAgent as findAgent,
  createAgentForTask as createAgent,
  startAgentForTask as startAgent,
};
