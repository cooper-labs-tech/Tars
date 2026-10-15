/**
 * The ceiling for delegated runs (ORCHESTRATOR-PER-CHAT.md v2.2, 4.4 item 2).
 *
 * A run over ACP is started by its asker and ends with its turn: it runs at
 * the narrower of the asker's mode and the target's own, in the order
 * plan < normal < auto < bypass. A persistent worker keeps the mode JeanBrasse gave
 * it, which is its configuration and not the asker's grant: a message to it
 * from a narrower asker is only marked as such, before the message. So this
 * is not a boundary: an asker in plan can have a worker in bypass do anything
 * that worker may do. SECURITY.md says so.
 */

export type PermissionLevel = 'plan' | 'normal' | 'auto' | 'bypass';

const ORDER: readonly PermissionLevel[] = ['plan', 'normal', 'auto', 'bypass'];

/** An agent's mode as its launch reads it (agent-routes.ts spawnAgentSession, agent-manager.ts load). */
export function levelOf(agent: { permissionMode?: string; skipPermissions?: boolean }): PermissionLevel {
  const mode = agent.permissionMode ?? (agent.skipPermissions ? 'auto' : 'normal');
  return (ORDER as readonly string[]).includes(mode) ? mode as PermissionLevel : 'normal';
}

/**
 * The mode a delegated run takes. `asker` undefined: nobody asked (Tars, the
 * window), the target's own mode. null: an asker named and not in the fleet,
 * the narrowest.
 */
export function ceilingOf(asker: PermissionLevel | null | undefined, target: PermissionLevel): PermissionLevel {
  if (asker === undefined) return target;
  if (asker === null) return 'plan';
  return ORDER[Math.min(ORDER.indexOf(asker), ORDER.indexOf(target))];
}

/** Typed after the sender line when the sender runs narrower than the worker, '' otherwise. */
export function modeGapMark(sender: PermissionLevel | undefined, receiver: PermissionLevel): string {
  if (!sender || ORDER.indexOf(sender) >= ORDER.indexOf(receiver)) return '';
  return `(sender in ${sender} mode, you in ${receiver} mode) `;
}
