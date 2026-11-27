import { memo } from 'react';
import { lastPathPart } from '@/lib/display-path';
import { X, FolderOpen, FolderPlus } from 'lucide-react';
import type { AgentStatus } from '@/types/electron';

interface AgentDialogSecondaryProjectProps {
  agent: AgentStatus;
  availableProjects: { path: string; name: string }[];
  customSecondaryPath: string;
  onCustomPathChange: (value: string) => void;
  onSetSecondaryProject: (path: string | null) => void;
  /** Why the last folder was not set, under the field (frame `Agent window · a secondary folder refused · states`). */
  error?: string | null;
  /** What becomes of the last folder taken, in the window's words, from main's appliesAt. */
  note?: string | null;
  onBrowseFolder?: () => Promise<string | null>;
}

export const AgentDialogSecondaryProject = memo(function AgentDialogSecondaryProject({
  agent,
  availableProjects,
  customSecondaryPath,
  onCustomPathChange,
  onSetSecondaryProject,
  error,
  note,
  onBrowseFolder,
}: AgentDialogSecondaryProjectProps) {
  const selectedProjectName = lastPathPart(agent.secondaryProjectPath ?? '');
  const unselectedProjects = availableProjects.filter(p => p.path !== agent.secondaryProjectPath);

  return (
    <div className="p-3 space-y-3">
      {agent.secondaryProjectPath && (
        <div>
          <p className="text-[10px] text-text-muted mb-1.5 uppercase tracking-wide">Active Context</p>
          <button
            onClick={() => onSetSecondaryProject(null)}
            className="w-full text-left px-2 py-1.5 rounded-none text-xs transition-colors flex items-center justify-between bg-warning/20 text-warning border border-warning/30 hover:bg-warning/30"
          >
            <div className="flex items-center gap-2 min-w-0">
              <FolderPlus className="w-3 h-3 shrink-0" />
              <span className="truncate">{selectedProjectName}</span>
            </div>
            <X className="w-3 h-3 shrink-0 opacity-60 hover:opacity-100" />
          </button>
        </div>
      )}

      {unselectedProjects.length > 0 && (
        <div>
          <p className="text-[10px] text-text-muted mb-1.5 uppercase tracking-wide">Available Projects</p>
          <div className="space-y-1">
            {unselectedProjects.slice(0, 6).map((project) => (
              <div
                key={project.path}
                className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-none text-xs hover:bg-bg-tertiary/50"
              >
                <div className="flex items-center gap-2 min-w-0 text-text-secondary">
                  <FolderPlus className="w-3 h-3 shrink-0" />
                  <span className="truncate">{project.name}</span>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSetSecondaryProject(project.path);
                  }}
                  className="px-2 py-0.5 rounded bg-warning/20 text-warning text-[10px] font-medium hover:bg-warning/30 shrink-0"
                >
                  Add
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <p className="text-[10px] text-text-muted mb-1.5 uppercase tracking-wide">Custom Path</p>
        <div className="flex gap-1.5">
          <input
            type="text"
            value={customSecondaryPath}
            onChange={(e) => onCustomPathChange(e.target.value)}
            placeholder="/path/to/project..."
            className="flex-1 px-2 py-1 rounded text-xs bg-bg-primary border border-border-primary focus:border-warning focus:outline-none font-mono"
          />
          {onBrowseFolder && (
            <button
              onClick={async () => {
                const path = await onBrowseFolder();
                if (path) onCustomPathChange(path);
              }}
              className="p-1 rounded bg-bg-tertiary border border-border-primary hover:border-warning/50"
              title="Browse"
            >
              <FolderOpen className="w-3.5 h-3.5 text-warning" />
            </button>
          )}
          <button
            onClick={() => customSecondaryPath.trim() && onSetSecondaryProject(customSecondaryPath.trim())}
            disabled={!customSecondaryPath.trim()}
            className="px-2 py-1 rounded bg-warning/20 text-warning text-xs font-medium hover:bg-warning/30 disabled:opacity-50"
          >
            Add
          </button>
        </div>
        {error && <p data-secondary-project-error className="mt-1.5 text-[11px] leading-snug text-danger break-words">{error}</p>}
        {!error && note && <p data-secondary-project-note className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{note}</p>}
      </div>
    </div>
  );
});
