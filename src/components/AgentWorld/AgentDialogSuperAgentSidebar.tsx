import { memo } from 'react';
import { Users, Folder, Crown, AlertTriangle, Circle } from 'lucide-react';
import type { AgentStatus } from '@/types/electron';
import { AgentMark } from '@/components/ui';
import { isSuperAgent } from './AgentDialogTypes';
import { stopLine } from '@/lib/stop-line';
import { asleepLine } from '@/lib/asleep-line';

interface AgentDialogSuperAgentSidebarProps {
  /** The orchestrator whose window this is. Every other agent is listed. */
  agentId?: string;
  agents: AgentStatus[];
  projects: { path: string; name: string }[];
}

const STATUS_COLOR: Record<string, string> = {
  running: 'text-primary',
  waiting: 'text-status-waiting',
  completed: 'text-accent-green',
  error: 'text-accent-red',
};

const STATUS_BG_COLOR: Record<string, string> = {
  running: 'bg-primary/20',
  waiting: 'bg-status-waiting/20',
  completed: 'bg-accent-green/20',
  error: 'bg-accent-red/20',
};

export const AgentDialogSuperAgentSidebar = memo(function AgentDialogSuperAgentSidebar({
  agentId,
  agents,
  projects,
}: AgentDialogSuperAgentSidebarProps) {
  // Everyone but this window's own agent. Filtering on the role instead hid
  // every orchestrator: since a project has one each, the others are agents
  // this list owes a row, drawn with the orange mark like everywhere else.
  const otherAgents = agents.filter(a => a.id !== agentId);
  const runningAgents = otherAgents.filter(a => a.status === 'running');
  // Counted in the head and listed nowhere until #161's gate: orchestrators wait
  // most of the time. Frame: `Agent window · orchestrator rail`.
  const waitingAgents = otherAgents.filter(a => a.status === 'waiting');
  const idleAgents = otherAgents.filter(a => a.status === 'idle' || a.status === 'completed');
  const errorAgents = otherAgents.filter(a => a.status === 'error');
  // Counted in the head, so listed: after idle, each with who stopped it,
  // when and why. Frame: `Agent stopped · who and why`.
  const stoppedAgents = otherAgents.filter(a => a.status === 'stopped');
  // Counted in the head, so listed: after idle and before stopped, each with
  // since when. Frame: `Agent asleep · and how it wakes`.
  const asleepAgents = otherAgents.filter(a => a.status === 'asleep');

  return (
    <div className="h-full overflow-y-auto">
      {/* Agents Section */}
      <div className="border-b border-border-primary">
        <div className="px-3 py-2.5 flex items-center gap-2 bg-bg-tertiary/30">
          <Users className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium">Agents</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/20 text-primary">
            {otherAgents.length}
          </span>
        </div>
        <div className="p-3 space-y-3">
          {runningAgents.length > 0 && (
            <div>
              <p className="text-[10px] text-primary mb-1.5 uppercase tracking-wide flex items-center gap-1">
                <Circle className="w-2 h-2 fill-primary animate-pulse" />
                Running ({runningAgents.length})
              </p>
              <div className="space-y-1">
                {runningAgents.map((agent) => (
                  <div key={agent.id} className="flex items-center gap-2 px-2 py-1.5 rounded-none bg-primary/10 border border-primary/20">
                    <AgentMark name={agent.name || agent.id} orchestrator={isSuperAgent(agent)} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{agent.name}</p>
                      <p className="text-[10px] text-text-muted truncate">
                        {agent.currentTask?.slice(0, 40) || agent.projectPath.split('/').pop()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {waitingAgents.length > 0 && (
            <div>
              <p className="text-[10px] text-status-waiting mb-1.5 uppercase tracking-wide">
                Waiting ({waitingAgents.length})
              </p>
              <div className="space-y-1">
                {waitingAgents.map((agent) => (
                  <div key={agent.id} className="flex items-center gap-2 px-2 py-1.5 rounded-none hover:bg-bg-tertiary/50">
                    <AgentMark name={agent.name || agent.id} orchestrator={isSuperAgent(agent)} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-text-secondary truncate">{agent.name}</p>
                      <p className="text-[10px] text-text-muted truncate">{agent.projectPath.split('/').pop()}</p>
                    </div>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_BG_COLOR.waiting} ${STATUS_COLOR.waiting}`}>
                      waiting
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {errorAgents.length > 0 && (
            <div>
              <p className="text-[10px] text-accent-red mb-1.5 uppercase tracking-wide flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" />
                Error ({errorAgents.length})
              </p>
              <div className="space-y-1">
                {errorAgents.map((agent) => (
                  <div key={agent.id} className="flex items-center gap-2 px-2 py-1.5 rounded-none bg-accent-red/10 border border-accent-red/20">
                    <AgentMark name={agent.name || agent.id} orchestrator={isSuperAgent(agent)} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{agent.name}</p>
                      <p className="text-[10px] text-text-muted truncate">{agent.projectPath.split('/').pop()}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {idleAgents.length > 0 && (
            <div>
              <p className="text-[10px] text-text-muted mb-1.5 uppercase tracking-wide">
                Idle ({idleAgents.length})
              </p>
              <div className="space-y-1">
                {idleAgents.map((agent) => (
                  <div key={agent.id} className="flex items-center gap-2 px-2 py-1.5 rounded-none hover:bg-bg-tertiary/50">
                    <AgentMark name={agent.name || agent.id} orchestrator={isSuperAgent(agent)} className="opacity-60" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-text-secondary truncate">{agent.name}</p>
                      <p className="text-[10px] text-text-muted truncate">{agent.projectPath.split('/').pop()}</p>
                    </div>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_BG_COLOR[agent.status] || 'bg-text-muted/20'} ${STATUS_COLOR[agent.status] || 'text-text-muted'}`}>
                      {agent.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {asleepAgents.length > 0 && (
            <div>
              <p className="text-[10px] text-text-muted mb-1.5 uppercase tracking-wide">
                Asleep ({asleepAgents.length})
              </p>
              <div className="space-y-1">
                {asleepAgents.map((agent) => {
                  const line = asleepLine(agent);
                  return (
                    <div key={agent.id} className="flex items-center gap-2 px-2 py-1.5 rounded-none hover:bg-bg-tertiary/50">
                      <AgentMark name={agent.name || agent.id} orchestrator={isSuperAgent(agent)} className="opacity-60" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-text-secondary truncate">{agent.name}</p>
                        <p className="text-[10px] text-text-muted truncate" title={line ?? undefined}>{line}</p>
                      </div>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-text-muted/20 text-text-muted">
                        asleep
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {stoppedAgents.length > 0 && (
            <div>
              <p className="text-[10px] text-text-muted mb-1.5 uppercase tracking-wide">
                Stopped ({stoppedAgents.length})
              </p>
              <div className="space-y-1">
                {stoppedAgents.map((agent) => {
                  const stop = stopLine(agent);
                  return (
                    <div key={agent.id} className="flex items-center gap-2 px-2 py-1.5 rounded-none hover:bg-bg-tertiary/50">
                      <AgentMark name={agent.name || agent.id} orchestrator={isSuperAgent(agent)} className="opacity-60" />
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-text-secondary truncate">{agent.name}</p>
                        <p className="text-[10px] text-text-muted truncate" title={stop ?? undefined}>{stop}</p>
                      </div>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-text-muted/20 text-text-muted">
                        stopped
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {otherAgents.length === 0 && (
            <p className="text-xs text-text-muted text-center py-4">No agents created yet</p>
          )}
        </div>
      </div>

      {/* Projects Section */}
      <div className="border-b border-border-primary">
        <div className="px-3 py-2.5 flex items-center gap-2 bg-bg-tertiary/30">
          <Folder className="w-4 h-4 text-text-muted" />
          <span className="text-sm font-medium">Projects</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted">
            {projects.length}
          </span>
        </div>
        <div className="p-3">
          {projects.length > 0 ? (
            <div className="space-y-1">
              {projects.map((project) => {
                const projectAgents = otherAgents.filter(
                  a => a.projectPath === project.path || a.worktreePath?.startsWith(project.path)
                );
                const runningCount = projectAgents.filter(a => a.status === 'running').length;
                return (
                  <div key={project.path} className="flex items-center gap-2 px-2 py-1.5 rounded-none hover:bg-bg-tertiary/50">
                    <Folder className="w-4 h-4 text-text-muted shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{project.name}</p>
                      <p className="text-[10px] text-text-muted font-mono truncate">
                        {project.path.split('/').slice(-2).join('/')}
                      </p>
                    </div>
                    {projectAgents.length > 0 && (
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-tertiary text-text-muted">
                          {projectAgents.length} agent{projectAgents.length !== 1 ? 's' : ''}
                        </span>
                        {runningCount > 0 && <span className="w-2 h-2 bg-primary rounded-full animate-pulse" />}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-text-muted text-center py-4">No projects added yet</p>
          )}
        </div>
      </div>

      {/* Orchestrator info */}
      <div className="p-3">
        <div className="p-3 rounded-none border border-warning/30 bg-warning/5">
          <div className="flex items-start gap-2">
            <Crown className="w-4 h-4 text-warning shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-medium text-warning">Orchestrator Mode</p>
              <p className="text-[10px] text-text-muted mt-1">
                Use MCP tools to manage agents: create_agent, start_agent, stop_agent, list_agents, send_prompt
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});
