/**
 * How the MCP servers answer a tools/call, and how they register their tools:
 * a table per server, one row per tool. A row is what tools/list shows (name,
 * description, schema) and what the tool does; registerTools runs every row
 * inside the one guard that turns a throw into the tool's
 * "Error <failure>: <message>", where each tool used to carry a try/catch.
 *
 * Neither the SDK nor zod is imported (see tars-api.ts): each server brings
 * its own. A schema is read only through what its fields parse to, the
 * `_output` zod 3 and zod 4 both declare.
 */

import { toolCall } from "./tool-call.js";

/** A tools/call result, as every server here builds one. */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** An answer. */
export const text = (body: string): ToolResult => ({ content: [{ type: "text", text: body }] });

/** An answer that reports a failure, in the tool's own words. */
export const problem = (body: string): ToolResult => ({ content: [{ type: "text", text: body }], isError: true });

/** What a tool that threw answers. */
export const failed = (what: string, error: unknown): ToolResult =>
  problem(`Error ${what}: ${error instanceof Error ? error.message : String(error)}`);

/** A zod raw shape, seen through what each of its fields parses to. */
export type Shape = Record<string, { readonly _output: unknown }>;

/** What a call may carry besides its arguments: a progress token, and the way to send progress. */
export type ToolExtra = {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: never) => Promise<void>;
} | undefined;

/** A row of a server's table. */
export interface Tool<S extends Shape = Shape> {
  name: string;
  description: string;
  schema: S;
  /** How a throw is reported: "Error <failure>: <message>". */
  failure: string;
  /**
   * It only reads: told to the CLI as readOnlyHint, which lets Claude Code run it beside the other calls of one
   * message (2.1.321 runs an MCP call alongside others only for a read-only tool, or a server that sets mayOverlap;
   * QA's gate of #579). Never on a tool that changes anything: the mark also tells a CLI it needs no permission.
   */
  readOnly?: true;
  run(args: { [K in keyof S]: S[K]["_output"] }, extra: ToolExtra): Promise<ToolResult>;
}

/** A row, its arguments typed from its schema. */
export const tool = <S extends Shape>(row: Tool<S>): Tool => row as unknown as Tool;

/**
 * The one method of the SDK's McpServer a table needs, typed loosely: its
 * real, overloaded signature is the SDK's, in each server's own version,
 * which this folder cannot name.
 */
export interface ToolServer {
  tool(name: string, description: never, schema: never, ...rest: never[]): unknown;
}

/** Registers the rows in order, the order tools/list gives them in. */
export function registerTools(server: ToolServer, tools: readonly Tool[]): void {
  for (const { name, description, schema, failure, run, readOnly } of tools) {
    const guarded = async (args: never, extra: ToolExtra): Promise<ToolResult> => {
      try {
        // Its calls to Tars name it (tool-call.ts).
        return await toolCall.run(name, () => run(args, extra));
      } catch (error) {
        return failed(failure, error);
      }
    };
    if (readOnly) server.tool(name, description as never, schema as never, { readOnlyHint: true } as never, guarded as never);
    else server.tool(name, description as never, schema as never, guarded as never);
  }
}
