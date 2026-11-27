'use client';

import { useMemo, useState } from 'react';
import { lastPathPart } from '@/lib/display-path';
import type { AgentTemplate } from '@/types/electron';
import { useElectronAgents, useElectronFS } from '@/hooks/useElectron';
import { Button, DialogShell, Dropdown, Input, Label } from '@/components/ui';
import type { DropdownOption } from '@/components/ui';
import { Toggle } from '@/components/Settings/Toggle';
import { createAgentWithRole } from '@/lib/agent-role';
import { revealLine, startsWithPromptByDefault, templateFacts } from '@/lib/template-review';
import { PromptBlock, TemplateFactRows } from './TemplateReview';

interface InstantiateDialogProps {
  template: AgentTemplate;
  onClose: () => void;
  onCreated?: (agentId: string) => void;
}

/**
 * Overlay · Instantiate template · prompt. A template's prompt is the new
 * agent's first message: it is shown whole, with what the template sets, and
 * sent only while "Start it with this prompt" is on. The switch starts on for
 * a built-in template and off for any other, since an imported template looks
 * just like one you made; off, the agent is created and not started.
 */
export function InstantiateDialog({ template, onClose, onCreated }: InstantiateDialogProps) {
  const { createAgent, updateAgent, startAgent } = useElectronAgents();
  const { projects, openFolderDialog } = useElectronFS();

  const [projectPath, setProjectPath] = useState<string | null>(null);
  // Written out like everything else the template says: an agent's name is
  // shown all over the app, and a direction override in it turns the text around.
  const [name, setName] = useState(() => revealLine(template.displayName).text);
  const [sendPrompt, setSendPrompt] = useState(() => startsWithPromptByDefault(template));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The agent is made: a second Create would make another one.
  const [made, setMade] = useState(false);

  const facts = useMemo(() => templateFacts(template), [template]);
  const starts = sendPrompt && facts.prompt !== null;

  // One control instead of a search field over a 224px scrolling list: the
  // remembered projects, plus whatever folder was just picked through the OS
  // dialog (it is not in the list yet but still has to be selectable here).
  const projectOptions = useMemo<DropdownOption[]>(() => {
    const options = projects.map(p => ({ value: p.path, label: p.name }));
    if (projectPath && !projects.some(p => p.path === projectPath)) {
      options.unshift({ value: projectPath, label: lastPathPart(projectPath) || projectPath });
    }
    return options;
  }, [projects, projectPath]);

  async function handlePickFolder() {
    try {
      const picked = await openFolderDialog();
      if (typeof picked === 'string' && picked) setProjectPath(picked);
    } catch (err) {
      console.error('openFolderDialog failed:', err);
    }
  }

  async function handleCreate() {
    if (made) return;
    if (!projectPath) {
      setError('Please pick a project first.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const resolvedModel = template.provider !== 'local' && template.model && template.model !== 'default'
        ? template.model
        : undefined;
      // The template's prompt is the agent's role, which main puts in every session's bootstrap ("## Your role"). Saved
      // on it as it is made, under the same switch as the start: an imported or edited template's prompt may carry
      // what the user did not write, and saved as the role it would run at every start, unread (the Audit's gate of #204).
      const { agent, roleNotSaved } = await createAgentWithRole({ createAgent, updateAgent }, {
        projectPath,
        skills: template.skills,
        character: template.character,
        name: name.trim() || facts.name,
        permissionMode: template.permissionMode,
        effort: template.effort,
        provider: template.provider,
        model: resolvedModel,
        localModel: template.localModel,
        obsidianVaultPaths: template.obsidianVaultPaths,
      }, sendPrompt ? template.savedPrompt : undefined);
      const prompt = template.savedPrompt?.trim() ?? '';
      if (prompt && sendPrompt) {
        await startAgent(agent.id, prompt, {
          model: resolvedModel,
          provider: template.provider,
          localModel: template.localModel,
        });
      }
      onCreated?.(agent.id);
      if (roleNotSaved) {
        // Made, and started as asked, but without its role: said here, and Create stays off so no second agent is made.
        setMade(true);
        setError(`Created, but its role was not saved: ${roleNotSaved}`);
        setSubmitting(false);
        return;
      }
      onClose();
    } catch (err) {
      console.error('Failed to create agent from template:', err);
      setError(err instanceof Error ? err.message : 'Failed to create agent');
      setSubmitting(false);
    }
  }

  return (
    <DialogShell
      onClose={onClose}
      title={`Use ${facts.name}`}
      subtitle="Pick a project, name your agent, and we'll set the rest up."
      footerRight={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleCreate} disabled={!projectPath || submitting || made}>
            {submitting ? 'Creating…' : starts ? 'Create and start' : 'Create agent'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label>Agent name</Label>
          <Input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={40}
            placeholder={facts.name}
          />
        </div>

        <div>
          <div className="flex items-center justify-between gap-3 mb-1">
            <Label>Project</Label>
            <Button size="sm" variant="ghost" onClick={handlePickFolder}>
              Pick another folder…
            </Button>
          </div>
          <Dropdown
            value={projectPath ?? ''}
            options={projectOptions}
            onChange={setProjectPath}
            placeholder={projectOptions.length ? 'Select a project…' : 'No projects yet: pick a folder'}
          />
          {projectPath && (
            <p className="mt-1.5 font-mono text-[11px] text-muted-foreground truncate">{projectPath}</p>
          )}
        </div>

        <div>
          <Label>What it sets</Label>
          <dl className="space-y-1.5">
            <TemplateFactRows facts={facts} />
          </dl>
        </div>

        {facts.prompt && (
          <div>
            <Label>Prompt</Label>
            <div className="space-y-1">
              <PromptBlock prompt={facts.prompt} />
            </div>
            <div className="mt-2 space-y-1">
              <label className="flex w-fit items-center gap-2 cursor-pointer">
                <Toggle enabled={sendPrompt} onChange={() => setSendPrompt(on => !on)} label="Start it with this prompt" />
                <span className="text-xs text-foreground">Start it with this prompt</span>
              </label>
              {!startsWithPromptByDefault(template) && (
                <p className="text-[11px] leading-4 text-muted-foreground">
                  This starts off unless the template is built in and unedited: an imported or edited one may carry a prompt you did not write.
                </p>
              )}
              {/* The switch decides the role too (the Audit's L1 on PR 581; frame `Overlay · Instantiate template · prompt`). */}
              <p className="text-[11px] leading-4 text-muted-foreground">
                On, it starts with this prompt and keeps it as its role, which it reads at every start. Off, it is created idle, with no role.
              </p>
            </div>
          </div>
        )}

        {error && (
          <p className="text-xs text-destructive bg-destructive/10 border border-destructive/30 px-2 py-1.5">{error}</p>
        )}
      </div>
    </DialogShell>
  );
}
