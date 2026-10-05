import type { AgentStatus } from '@/types/electron';
import type { StatusTone } from '@/components/ui/StatusBadge';

// Status is ink only. The status token colours the raw status word.
// No background fill, no pill: consumers render the status key itself.
export const STATUS_COLORS: Record<AgentStatus['status'], { text: string }> = {
  idle: { text: 'text-status-idle' },
  running: { text: 'text-status-running' },
  completed: { text: 'text-status-idle' },
  error: { text: 'text-status-error' },
  waiting: { text: 'text-status-waiting' },
  // At rest, like idle, and in its ink: the word and its line say the rest.
  // Frame: `Agent stopped · who and why`.
  stopped: { text: 'text-status-idle' },
  // Asleep, in the idle ink. Frame: `Agent asleep · and how it wakes`.
  asleep: { text: 'text-status-idle' },
};

/**
 * Folds the runtime status set onto the design's four inks (R6). `completed`
 * is a real runtime state but not a design status: it reads as idle. A
 * stopped agent is at rest too, and takes the idle ink with its own word.
 */
export const statusTone = (status: AgentStatus['status']): StatusTone =>
  status === 'completed' || status === 'stopped' || status === 'asleep' ? 'idle' : status;

/** The word an agent's row prints, and the Agents page filters on. */
export type StatusWord = StatusTone | 'stopped' | 'asleep';

/**
 * The status as a word: the four tones, and `stopped`, which says an agent
 * was ended on purpose (by you, Tars, or another agent) and is not resumed
 * at launch, where `idle` is an agent at rest. `completed` reads idle.
 */
export const statusWord = (status: AgentStatus['status']): StatusWord =>
  status === 'completed' ? 'idle' : status;

/**
 * Why an agent is in error, in the words that put it there, or null.
 *
 * `error` holds the CLI's own sentence when a turn failed ("Not logged in ·
 * Please run /login"), or Tars's when a task never started. It can outlive
 * the error until the next turn clears it, so it is only a reason while the
 * status still says error: shown on a working agent, it would describe a
 * failure that is over. Frame: `Agent error · reason`.
 */
export const errorReason = (agent: Pick<AgentStatus, 'status' | 'error'>): string | null =>
  agent.status === 'error' ? agent.error?.trim() || null : null;

export const ORCHESTRATOR_PROMPT = `You are the Super Agent - an orchestrator that manages other agents using MCP tools.

AVAILABLE MCP TOOLS (from "claude-mgr-orchestrator"):
- list_agents: List all agents with status, project, ID
- get_agent_output: Read agent's terminal output (use to see responses!)
- start_agent: Start agent with a prompt (auto-sends to running agents too)
- send_message: Send message to agent (auto-starts idle agents)
- stop_agent: Stop a running agent
- create_agent: Create a new agent
- remove_agent: Delete an agent

WORKFLOW - When asked to talk to an agent:
1. Use start_agent or send_message with your question (both auto-handle idle/running states)
2. Wait 5-10 seconds for the agent to process
3. Use get_agent_output to read their response
4. Report the response back to the user

IMPORTANT:
- ALWAYS check get_agent_output after sending a message to see the response
- Keep responses concise
- NEVER explore codebases - you only manage agents

Say hello and list the current agents.`;

// The Orchestrator toggle, which is the role. The name decides nothing.
export const isSuperAgentCheck = (agent: AgentStatus) => agent.role === 'orchestrator';

export const getStatusPriority = (status: string) => {
  if (status === 'running') return 0;
  if (status === 'waiting') return 1;
  return 2;
};
