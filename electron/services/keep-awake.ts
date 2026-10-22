import type { AgentStatus, AppSettings, KeepAwakeMode } from '../types';

/**
 * Keeps the computer from sleeping while an agent works (2.0.5, taken from Orca): a Mac that sleeps in the middle
 * of a turn stops the agent with it. Electron's powerSaveBlocker with 'prevent-app-suspension', which keeps the
 * system awake and lets the screen go dark; 'prevent-display-sleep' would keep the screen on for nothing.
 *
 * The setting keepAwake: 'while-working' (the default, also for a missing or unknown value) while at least one
 * agent is `running`; 'always' while Tars runs; 'never'. Only `running` is work: a permission wait, an idle
 * prompt, a sleeping or a stopped agent needs nobody awake for it.
 *
 * One blocker for the whole fleet, started and stopped by sync(), which main.ts calls on every status change of
 * the fleet, on a change of the settings, and every 30 s (a status changed by a path that tells nobody is caught
 * there). A blocker the system ended on its own is started again while it is still wanted.
 */

export type { KeepAwakeMode };

export interface KeepAwakeState {
  mode: KeepAwakeMode;
  /** Whether Tars keeps the computer awake now. */
  active: boolean;
  /** ISO: since when, while active. */
  since?: string;
}

interface Blocker {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

export function keepAwakeMode(settings: Pick<AppSettings, 'keepAwake'> | undefined): KeepAwakeMode {
  const mode = settings?.keepAwake;
  return mode === 'always' || mode === 'never' ? mode : 'while-working';
}

export function createKeepAwake(deps: {
  blocker: Blocker;
  settings: () => Pick<AppSettings, 'keepAwake'> | undefined;
  agents: () => Iterable<Pick<AgentStatus, 'status'>>;
}) {
  let id: number | undefined;
  let since: string | undefined;

  const wanted = (mode: KeepAwakeMode): boolean => {
    if (mode !== 'while-working') return mode === 'always';
    for (const agent of deps.agents()) if (agent.status === 'running') return true;
    return false;
  };

  const state = (): KeepAwakeState => {
    const mode = keepAwakeMode(deps.settings());
    return id !== undefined ? { mode, active: true, since } : { mode, active: false };
  };

  const sync = (): KeepAwakeState => {
    const want = wanted(keepAwakeMode(deps.settings()));
    if (id !== undefined && !deps.blocker.isStarted(id)) {
      id = undefined;
      since = undefined;
    }
    if (want && id === undefined) {
      id = deps.blocker.start('prevent-app-suspension');
      since = new Date().toISOString();
    } else if (!want && id !== undefined) {
      deps.blocker.stop(id);
      id = undefined;
      since = undefined;
    }
    return state();
  };

  return { sync, state };
}
