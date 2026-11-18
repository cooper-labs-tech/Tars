import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerTools, text, tool } from "../../../mcp-shared/src/tools.js";
import { apiRequest } from "../utils/api.js";

type Endpoint = {
  id: string; name: string; baseUrl: string; allowTraces: boolean; keySet: boolean; models: string[];
  approved: boolean; approvedBaseUrl?: string; holdMaxSeconds: number;
  agents: Array<{ id: string; name: string; projectPath: string; provider: string; model?: string }> | number;
  health?: { ok: boolean; status?: number; latencyMs?: number; at: string; error?: string };
  modelsError?: string;
};

const KEY_FILE = z.string().regex(/^[A-Za-z0-9._-]{1,64}\.key$/)
  .describe("The name of a file you wrote in Tars's key drop folder (~/.tars/endpoint-keys/<name>.key), one line holding the key. Tars takes the key into its private folder and deletes the file. Never put a key in a tool argument or a message.");

function describe(e: Endpoint): string {
  const users = typeof e.agents === "number" ? `${e.agents} agent(s)` : e.agents.length ? e.agents.map(a => `${a.name} (${a.provider}${a.model ? ` ${a.model}` : ""})`).join(", ") : "no agent";
  const health = e.health ? `${e.health.ok ? "up" : "down"}${e.health.status ? ` ${e.health.status}` : ""}${e.health.latencyMs !== undefined ? `, ${e.health.latencyMs} ms` : ""} at ${e.health.at}` : "not checked";
  return [
    `- ${e.name} [${e.id}] ${e.baseUrl}`,
    `  ${e.approved ? "approved" : `WAITING for the owner's approval in the window${e.approvedBaseUrl ? ` (approved before: ${e.approvedBaseUrl})` : ""}`}; key ${e.keySet ? "set" : "not set"}; traces ${e.allowTraces ? "allowed" : "off"}; held up to ${e.holdMaxSeconds} s while it pauses`,
    `  models: ${e.models.length ? e.models.join(", ") : "none read"}${e.modelsError ? ` (last read failed: ${e.modelsError})` : ""}; health: ${health}; used by: ${users}`,
  ].join("\n");
}

/**
 * Inference endpoints (OpenAI-compatible) that agents of every project can run their harness on: list, add, change,
 * rotate a key from the drop folder, read models, check health. A new or re-pointed base URL waits for the owner's
 * approval in Tars's window; no tool approves one.
 */
export function registerEndpointTools(server: McpServer): void {
  registerTools(server, [
    tool({
      name: "endpoint_list",
      description: "List the inference endpoints Tars knows (OpenAI-compatible, for codex, pi, qwen-code or opencode agents): approval, key set or not (never the key), models, last health check, and which agents use each.",
      schema: {},
      failure: "listing the endpoints",
      async run() {
        const { endpoints, keyDropFolder } = (await apiRequest("/api/endpoints")) as { endpoints: Endpoint[]; keyDropFolder?: string };
        if (!endpoints.length) return text("No inference endpoint yet. Add one with endpoint_add.");
        return text([...endpoints.map(describe), ...(keyDropFolder ? [`Key drop folder: ${keyDropFolder}`] : [])].join("\n"));
      },
    }),
    tool({
      name: "endpoint_add",
      description: "Add an OpenAI-compatible inference endpoint. It stays unusable until the owner approves it once in Tars's window. Give the key, if any, as a drop file name (key_file), never as text.",
      schema: {
        name: z.string().min(1).max(60).describe("A name people will recognise."),
        base_url: z.string().describe("http(s), up to the routes, for example https://host.example.com/v1."),
        hold_max_seconds: z.number().int().min(0).max(3600).optional().describe("How long Tars holds a request while the endpoint answers 503, 429 or 502 before passing the error on (default 600)."),
        key_file: KEY_FILE.optional(),
      },
      failure: "adding the endpoint",
      async run(args: { name: string; base_url: string; hold_max_seconds?: number; key_file?: string }) {
        const r = (await apiRequest("/api/endpoints", "POST", { name: args.name, baseUrl: args.base_url, holdMaxSeconds: args.hold_max_seconds, keyFile: args.key_file })) as { endpoint: Endpoint; needsApproval: boolean; keyNotTaken?: string };
        return text([describe(r.endpoint), r.needsApproval ? "It waits for the owner's approval in Tars's window." : "", r.keyNotTaken ? `The key was not taken: ${r.keyNotTaken}` : ""].filter(Boolean).join("\n"));
      },
    }),
    tool({
      name: "endpoint_update",
      description: "Change an endpoint's name, base URL, hold ceiling, or turn its traces off. A new base URL makes it wait for the owner's approval again; the rest keeps the approval. Only the owner turns traces on.",
      schema: {
        id: z.string().regex(/^ep-[0-9a-f]{6}$/),
        name: z.string().min(1).max(60).optional(),
        base_url: z.string().optional(),
        hold_max_seconds: z.number().int().min(0).max(3600).optional(),
        traces_off: z.boolean().optional().describe("true to stop allowing traces on this endpoint."),
      },
      failure: "changing the endpoint",
      async run(args: { id: string; name?: string; base_url?: string; hold_max_seconds?: number; traces_off?: boolean }) {
        const r = (await apiRequest(`/api/endpoints/${args.id}`, "POST", { name: args.name, baseUrl: args.base_url, holdMaxSeconds: args.hold_max_seconds, ...(args.traces_off ? { allowTraces: false } : {}) })) as { endpoint: Endpoint; needsApproval: boolean };
        return text([describe(r.endpoint), r.needsApproval ? "It waits for the owner's approval in Tars's window." : ""].filter(Boolean).join("\n"));
      },
    }),
    tool({
      name: "endpoint_set_key",
      description: "Set or rotate an endpoint's key from a drop file: write the key, one line, into ~/.tars/endpoint-keys/<name>.key, then call this with that name. Tars takes it into its private folder and deletes the file. The key is never readable back. No approval is needed.",
      schema: { id: z.string().regex(/^ep-[0-9a-f]{6}$/), key_file: KEY_FILE },
      failure: "setting the key",
      async run(args: { id: string; key_file: string }) {
        await apiRequest(`/api/endpoints/${args.id}/key`, "POST", { keyFile: args.key_file });
        return text(`The key of ${args.id} is set; the drop file is deleted.`);
      },
    }),
    tool({
      name: "endpoint_refresh_models",
      description: "Read the endpoint's own model list (/v1/models) again. An agent can only be set on a model the endpoint lists.",
      schema: { id: z.string().regex(/^ep-[0-9a-f]{6}$/) },
      failure: "reading the models",
      async run(args: { id: string }) {
        const r = (await apiRequest(`/api/endpoints/${args.id}/models`, "POST", {})) as { models: string[] };
        return text(`Models of ${args.id}: ${r.models.join(", ")}`);
      },
    }),
    tool({
      name: "endpoint_check",
      description: "Probe an endpoint (/v1/models with its key): status, latency and the time it was taken.",
      schema: { id: z.string().regex(/^ep-[0-9a-f]{6}$/) },
      failure: "checking the endpoint",
      async run(args: { id: string }) {
        const { health } = (await apiRequest(`/api/endpoints/${args.id}/check`, "POST", {})) as { health: NonNullable<Endpoint["health"]> };
        return text(`${args.id}: ${health.ok ? "up" : "down"}${health.status ? `, HTTP ${health.status}` : ""}${health.latencyMs !== undefined ? `, ${health.latencyMs} ms` : ""}, at ${health.at}${health.error ? `: ${health.error}` : ""}`);
      },
    }),
  ]);
}
