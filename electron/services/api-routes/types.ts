import * as http from 'http';
import { BrowserWindow } from 'electron';
import TelegramBot from 'node-telegram-bot-api';
import { App as SlackApp } from '@slack/bolt';
import { EventEmitter } from 'events';
import { AgentStatus, AppSettings } from '../../types';

export interface RouteContext {
  mainWindow: BrowserWindow | null;
  appSettings: AppSettings;          // Initial snapshot, prefer getAppSettings() for live values
  getAppSettings: () => AppSettings; // Always returns the current appSettings
  getTelegramBot: () => TelegramBot | null;
  getSlackApp: () => SlackApp | null;
  slackResponseChannel: string | null;
  slackResponseThreadTs: string | null;
  handleStatusChangeNotificationCallback: (agent: AgentStatus, newStatus: string) => void;
  sendNotificationCallback: (title: string, body: string, agentId?: string, appSettings?: { notificationsEnabled: boolean; notificationSounds?: Record<string, string> }) => void;
  initAgentPtyCallback: (agent: AgentStatus) => Promise<string>;
  agentStatusEmitter: EventEmitter;
}

export interface RouteRequest {
  method: string;
  pathname: string;
  url: URL;
  body: Record<string, unknown>;
  raw: http.IncomingMessage;
  res: http.ServerResponse;
  params: Record<string, string>;
  /**
   * The agent this call comes from: the one its bearer token was minted for,
   * resolved once by the server before any route sees the request. Undefined
   * on the shared token, whoever presents it: the shell hooks, or a process
   * that read the file. Never set from a header: the header is the
   * claim this field exists to check.
   */
  callerAgentId?: string;
  /**
   * True when that token is the agent's terminal's, not a delegated run's:
   * the one caller a later message can be typed back to. Never set from a
   * header.
   */
  callerTerminal?: boolean;
  /**
   * True when the caller is Tars itself: the main process reaching its own
   * API over the loopback with the pass minted in `core/agent-tokens.ts`,
   * which is never written to disk and never given to a child. No agent, so
   * nothing is scoped to it, but the routes that refuse a caller with no
   * identity let it through. Never set from a header.
   */
  internal?: boolean;
  /**
   * True when the caller is Hermes: the call presents the webhook secret, on
   * the webhook's own path, the only one where the server takes it for
   * anything. The webhook opens to this and to nothing else. Never set from a
   * header.
   */
  hermes?: boolean;
}

export type SendJson = (data: unknown, status?: number) => void;

export type RouteHandler = (req: RouteRequest, sendJson: SendJson, ctx: RouteContext) => Promise<void> | void;

export interface RouteDefinition {
  method: string;
  pattern: string | RegExp;
  handler: RouteHandler;
}

export interface RouteApp {
  routes: RouteDefinition[];
  add(method: string, pattern: string | RegExp, handler: RouteHandler): void;
  get(pattern: string | RegExp, handler: RouteHandler): void;
  post(pattern: string | RegExp, handler: RouteHandler): void;
  put(pattern: string | RegExp, handler: RouteHandler): void;
  delete(pattern: string | RegExp, handler: RouteHandler): void;
}
