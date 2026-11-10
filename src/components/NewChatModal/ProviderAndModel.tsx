'use client';

import { useEffect, useState } from 'react';
import type { AgentProvider } from '@/types/electron';
import { PROVIDER_REGISTRY } from '@/lib/providers';
import { ProviderIconRenderer } from '@/components/ui/ProviderBadge';
import { Button, Dropdown, PanelCaption, StatusSquare } from '@/components/ui';
import { ClaudeAccountLoginModal } from '@/components/Settings/ClaudeAccountLoginModal';
import { useClaudeAccounts } from '@/hooks/useClaudeAccounts';
import type { DropdownOption } from '@/components/ui';

interface ProviderModel {
  id: string;
  name: string;
  description: string;
}

/** The four everyday CLIs the frame draws as one row of tiles. */
const CORE_PROVIDER_IDS = ['claude', 'codex', 'gemini', 'grok'];

const PROVIDER_MODELS: Record<string, ProviderModel[]> = Object.fromEntries(
  PROVIDER_REGISTRY.map((p) => [p.id, p.models]),
);
const PROVIDER_DEFAULT_MODEL: Record<string, string> = Object.fromEntries(
  PROVIDER_REGISTRY.map((p) => [p.id, p.defaultModel]),
);

/** The model row's right-aligned hint: context window, price, release date. */
function describe(m: {
  contextWindow?: number;
  cost?: { input?: number };
  releaseDate?: string;
  alias?: boolean;
}): string {
  return [
    // An undated id follows the newest build of its family. Saying so is the
    // point: models.dev calls those "(latest)", which read in the picker as a
    // claim that 4.5 was the newest model when Opus 5 was two rows above it.
    m.alias ? 'tracks the newest of its family' : '',
    m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K context` : '',
    m.cost?.input != null ? `$${m.cost.input}/M in` : '',
    m.releaseDate || '',
  ].filter(Boolean).join(' · ');
}

async function fetchProviderModels(providerId: string): Promise<ProviderModel[] | null> {
  try {
    // Qwen Code's models are the user's own, read from the CLI's settings
    // (models.ofCli), never the catalogue's: none there, none offered.
    if (providerId === 'qwen-code') {
      const own = await window.electronAPI?.models?.ofCli(providerId);
      return (own?.models ?? []).map(m => ({ id: m.id, name: m.name || m.id, description: m.description }));
    }
    const res = await window.electronAPI?.models?.list(providerId);
    if (!res?.models?.length) return null;
    return res.models.map(m => ({ id: m.id, name: m.name || m.id, description: describe(m) }));
  } catch {
    return null;
  }
}

function modelOption(m: ProviderModel): DropdownOption {
  return { value: m.id, label: m.name, hint: m.description || undefined };
}

/**
 * "WHAT IT RUNS": the four provider tiles plus the model row underneath -
 * everything the old Model step held except the effort ladder, which moved
 * into Options since it modifies the task, not the model.
 */
export function ProviderAndModel({
  provider,
  onProviderChange,
  model,
  onModelChange,
  installedProviders,
}: {
  provider: AgentProvider;
  onProviderChange: (provider: AgentProvider) => void;
  model: string;
  onModelChange: (model: string) => void;
  installedProviders?: Record<string, boolean>;
}) {
  const [dynamicModels, setDynamicModels] = useState<ProviderModel[] | null>(null);
  // Account 1's `claude auth status`: an installed Claude Code that is signed out is not ready (QA's B3).
  const { view } = useClaudeAccounts();
  const claudeSignedOut = view?.accounts.find(a => a.id === 'default')?.signedIn === false;
  const [signingIn, setSigningIn] = useState(false);

  // Switching provider twice quickly could land the first catalogue after the
  // second, leaving the model list describing a provider the user had already
  // moved off. The flag drops any answer that arrives after its effect is torn
  // down, and it is also what keeps the state update out of the effect body.
  useEffect(() => {
    let cancelled = false;
    setDynamicModels(null);
    fetchProviderModels(provider).then(models => {
      if (!cancelled) setDynamicModels(models);
    });
    return () => { cancelled = true; };
  }, [provider]);

  const resolvedModels = dynamicModels || PROVIDER_MODELS[provider] || PROVIDER_MODELS.claude;

  // The tile row only ever shows the everyday CLIs, plus whichever provider
  // is actually selected, so editing an agent on e.g. openrouter still shows its
  // own tile, disabled if it is no longer installed.
  //
  // The other thirteen are NOT reachable through the CLI binary override, which
  // an earlier comment here claimed: that setting picks a binary, while the
  // provider is what decides ANTHROPIC_BASE_URL and which API key is used. With
  // only the four tiles there was no way to create an agent on DeepSeek, Ollama
  // or Venice at all. They get one compact row of their own below the tiles,
  // which keeps the frame's single row of four intact and still honours the
  // rule that nothing works only for Claude.
  const tiles = PROVIDER_REGISTRY.filter(
    (p) => p.id === provider || CORE_PROVIDER_IDS.includes(p.id),
  );

  // Everything the tiles do not show. Ready ones first, because a provider with
  // no key is a thing to go and fix rather than a thing to pick.
  const others = PROVIDER_REGISTRY
    .filter((p) => !tiles.some((t) => t.id === p.id))
    .map((p) => {
      const installed = installedProviders?.[p.id] === true;
      return {
        value: p.id,
        label: p.label,
        hint: installed ? (p.requiresCli ? 'ready · cli' : 'ready · api') : (p.requiresCli ? 'not installed' : 'no api key'),
        disabled: !installed,
        installed,
      };
    })
    .sort((a, b) => Number(b.installed) - Number(a.installed) || a.label.localeCompare(b.label));

  const readyOthers = others.filter((o) => o.installed).length;

  return (
    <div className="space-y-2.5">
      <PanelCaption>What it runs</PanelCaption>
      <div className="grid gap-2 grid-cols-4">
        {tiles.map(({ id, label, icon, requiresCli }) => {
          const installed = installedProviders?.[id] === true;
          const selected = provider === id;
          return (
            <button
              key={id}
              type="button"
              disabled={!installed}
              onClick={() => {
                if (!installed) return;
                onProviderChange(id);
                onModelChange(PROVIDER_DEFAULT_MODEL[id]);
              }}
              title={!installed ? (requiresCli ? 'Not installed' : 'Add API key in Settings > AI Providers') : undefined}
              className={`h-[52px] px-2.5 border transition-colors text-left flex flex-col justify-center gap-0.5 ${
                !installed
                  ? 'opacity-40 cursor-not-allowed border-border'
                  : selected
                    ? 'border-primary bg-secondary'
                    : 'border-border hover:bg-secondary'
              }`}
            >
              <div className="flex items-center gap-1.5">
                <ProviderIconRenderer icon={icon} className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs font-medium text-foreground truncate">{label}</span>
              </div>
              <span data-provider-state={id} className="font-mono text-[10px] text-muted-foreground truncate">
                {installed && id === 'claude' && claudeSignedOut ? (
                  <><span className="text-status-waiting">signed out</span>{' · cli'}</>
                ) : installed ? (
                  <><span className="text-status-running">ready</span>{` · ${requiresCli ? 'cli' : 'api'}`}</>
                ) : requiresCli ? 'not installed' : 'no api key'}
              </span>
            </button>
          );
        })}
      </div>

      {/* Claude Code signed out, as `claude auth status` says it (frame `First run (2.0.7) · states`, its New agent row). */}
      {claudeSignedOut && installedProviders?.claude === true && (
        <div data-claude-signed-out className="flex items-center gap-2">
          <StatusSquare tone="waiting" />
          <span className="flex-1 min-w-0 text-[11px] text-text-secondary">Claude Code is signed out: an agent on it cannot work until it is signed in.</span>
          <Button size="sm" className="font-mono lowercase" onClick={() => setSigningIn(true)}>sign in</Button>
        </div>
      )}
      {signingIn && <ClaudeAccountLoginModal accountId="default" onClose={() => setSigningIn(false)} />}

      {others.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">or</span>
          <Dropdown
            className="flex-1"
            size="sm"
            ariaLabel="Another provider"
            placeholder={`another provider (${readyOthers} ready of ${others.length})`}
            searchable={others.length > 12}
            searchPlaceholder={`filter ${others.length} providers`}
            value=""
            options={others.map(({ value, label, hint, disabled }) => ({ value, label, hint, disabled }))}
            onChange={(id) => {
              onProviderChange(id as typeof provider);
              onModelChange(PROVIDER_DEFAULT_MODEL[id]);
            }}
          />
        </div>
      )}

      <Dropdown
        mono
        ariaLabel="Model"
        searchable={resolvedModels.length > 12}
        searchPlaceholder={`filter ${resolvedModels.length} models`}
        value={model}
        options={resolvedModels.map(modelOption)}
        onChange={onModelChange}
      />
    </div>
  );
}
