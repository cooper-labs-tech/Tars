import { EventEmitter } from 'events';

/**
 * When an agent's status moves, and who is told. Its own module, since not
 * every listener is HTTP (the overseer watches the fleet), and reaching it
 * through `api-server` would drag in both bots and the route table. Two
 * channels, one call: `status:<id>` for a caller waiting on one agent,
 * `fleet-change` for anything watching the fleet, emitted together here so no
 * call site can emit one and forget the other.
 */
export const agentStatusEmitter = new EventEmitter();
// One `/wait` listener per agent in flight, plus the overseer.
agentStatusEmitter.setMaxListeners(50);

export function emitAgentStatus(agentId: string): void {
  agentStatusEmitter.emit(`status:${agentId}`);
  agentStatusEmitter.emit('fleet-change', agentId);
}
