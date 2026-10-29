import { RouteApp, RouteContext } from './types';
import { registerHealthRoutes } from './health-routes';
import { registerHooksRoutes } from './hooks-routes';
import { registerAgentRoutes } from './agent-routes';
import { registerTelegramRoutes } from './telegram-routes';
import { registerIntegrationRoutes } from './integration-routes';
import { registerChatReadRoutes } from './chat-read-routes';
import { registerSlackRoutes } from './slack-routes';
import { registerDiscordRoutes } from './discord-routes';
import { registerKanbanRoutes } from './kanban-routes';
import { registerVaultRoutes } from './vault-routes';
import { registerMemoryRoutes } from './memory-routes';
import { registerWebhookRoutes } from './webhook-routes';
import { registerBusRoutes } from './bus-routes';
import { registerAskUserRoutes } from './ask-user-routes';
import { registerTaskRoutes } from './task-routes';
import { registerHeavySlotRoutes } from './heavy-slot-routes';
import { registerMcpRoutes } from './mcp-routes';
import { registerJanitorRoutes } from './janitor-routes';
import { registerOwnerWordsRoutes } from './owner-words-routes';

export function registerAllRoutes(app: RouteApp, ctx: RouteContext): void {
  registerBusRoutes(app);
  registerHealthRoutes(app, ctx);
  registerHooksRoutes(app, ctx);
  registerAgentRoutes(app, ctx);
  registerTelegramRoutes(app, ctx);
  registerIntegrationRoutes(app, ctx);
  registerChatReadRoutes(app, ctx);
  registerSlackRoutes(app, ctx);
  registerDiscordRoutes(app, ctx);
  registerKanbanRoutes(app, ctx);
  registerVaultRoutes(app, ctx);
  registerMemoryRoutes(app, ctx);
  registerWebhookRoutes(app, ctx);
  registerAskUserRoutes(app, ctx);
  registerTaskRoutes(app);
  registerHeavySlotRoutes(app);
  // Tars's shared MCP servers, reached by each agent's CLI as itself (services/mcp-shared.ts).
  registerMcpRoutes(app);
  // The disk janitor's scan, for an agent that asks: read only (services/disk-janitor.ts).
  registerJanitorRoutes(app);
  // The owner's words, relayed under Tars's mark (services/owner-words.ts, SECURITY.md §8).
  registerOwnerWordsRoutes(app, ctx);
}

export type { RouteApp, RouteContext, RouteRequest, SendJson, RouteHandler, RouteDefinition } from './types';
