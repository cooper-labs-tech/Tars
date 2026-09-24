/**
 * Minimal MCP client over streamable HTTP, for the remote servers gbrain and
 * Honcho: Tars probes, lists and calls their tools itself, for an agent on any
 * CLI, where a URL written into ~/.claude.json made "Connected" mean only "a
 * URL is filled in".
 */

export interface McpEndpoint {
  url: string;
  token?: string;
  label: string;
  /**
   * Extra headers on every call, beyond the bearer token: Honcho binds its
   * workspace this way and no other (no tool requires workspace_id, so an
   * agent omits it and the call is refused). Absent for gbrain.
   */
  headers?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT = 15_000;

/** Sessions are per-endpoint and cheap to re-establish, so they are not persisted. */
const sessions = new Map<string, string>();

function headersFor(endpoint: McpEndpoint): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Streamable HTTP servers may answer either shape.
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': PROTOCOL_VERSION,
  };
  if (endpoint.token) headers.Authorization = `Bearer ${endpoint.token}`;
  // After the defaults so a server can correct them, before Mcp-Session-Id,
  // which belongs to this client and is not the caller's to set.
  if (endpoint.headers) Object.assign(headers, endpoint.headers);
  const session = sessions.get(endpoint.url);
  if (session) headers['Mcp-Session-Id'] = session;
  return headers;
}

/** Servers may answer a single JSON object or an SSE frame carrying one. */
function parseBody(raw: string): JsonRpcResponse | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed) as JsonRpcResponse; } catch { return null; }
  }
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try { return JSON.parse(payload) as JsonRpcResponse; } catch { /* next frame */ }
  }
  return null;
}

async function rpc(
  endpoint: McpEndpoint,
  method: string,
  params: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const res = await fetch(endpoint.url, {
    method: 'POST',
    headers: headersFor(endpoint),
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params: params ?? {} }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const sessionId = res.headers.get('mcp-session-id');
  if (sessionId) sessions.set(endpoint.url, sessionId);

  if (res.status === 401 || res.status === 403) {
    throw new Error(`${endpoint.label}: not authorised (check the token)`);
  }
  if (!res.ok) throw new Error(`${endpoint.label}: HTTP ${res.status}`);

  const parsed = parseBody(await res.text());
  if (!parsed) throw new Error(`${endpoint.label}: unreadable response`);
  if (parsed.error) throw new Error(`${endpoint.label}: ${parsed.error.message}`);
  return parsed.result;
}

async function initialize(endpoint: McpEndpoint, timeoutMs: number): Promise<void> {
  if (sessions.has(endpoint.url)) return;
  await rpc(endpoint, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'Tars', version: '1.4.0' },
  }, timeoutMs);
  // Servers that hand out a session id expect the initialized notification;
  // the ones that do not simply ignore it.
  try {
    await fetch(endpoint.url, {
      method: 'POST',
      headers: headersFor(endpoint),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // best effort
  }
}

export async function listMcpTools(endpoint: McpEndpoint, timeoutMs = DEFAULT_TIMEOUT): Promise<McpTool[]> {
  await initialize(endpoint, timeoutMs);
  const result = await rpc(endpoint, 'tools/list', undefined, timeoutMs) as { tools?: McpTool[] } | undefined;
  return result?.tools ?? [];
}

export async function callMcpTool(
  endpoint: McpEndpoint,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<string> {
  await initialize(endpoint, timeoutMs);
  const result = await rpc(endpoint, 'tools/call', { name, arguments: args }, timeoutMs) as
    { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown; isError?: boolean } | undefined;

  if (result?.isError) {
    throw new Error(`${endpoint.label}: tool ${name} failed`);
  }

  const text = (result?.content ?? [])
    .filter(part => part.type === 'text' && part.text)
    .map(part => part.text)
    .join('\n')
    .trim();

  if (text) return text;
  if (result?.structuredContent) return JSON.stringify(result.structuredContent);
  return '';
}

export interface McpProbe {
  reachable: boolean;
  tools: string[];
  error?: string;
}

/** Does this endpoint actually answer, and what can an agent do with it. */
export async function probeMcpEndpoint(endpoint: McpEndpoint, timeoutMs = 8_000): Promise<McpProbe> {
  sessions.delete(endpoint.url);
  try {
    const tools = await listMcpTools(endpoint, timeoutMs);
    return { reachable: true, tools: tools.map(t => t.name) };
  } catch (err) {
    return { reachable: false, tools: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Test seam. */
export function clearMcpSessions(): void {
  sessions.clear();
}
