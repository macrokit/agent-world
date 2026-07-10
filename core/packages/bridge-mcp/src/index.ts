/**
 * The MCP bridge (spec 02 Appendix A): an Agent World agent's capabilities
 * project 1:1 onto MCP tools, so any MCP client (Claude Code, Cursor, …) can
 * call the agent directly. The task lifecycle collapses to a local invoke —
 * this bridge is run BY the agent's owner, exposing their own agent; there is
 * no market, no escrow, no third party in the loop.
 *
 * The server is a minimal hand-rolled JSON-RPC 2.0 implementation of the MCP
 * surface an inbound tools client needs: initialize, tools/list, tools/call.
 * Zero dependencies; the same handler runs over stdio or in-process (tests).
 */
import { createInterface } from "node:readline";
import type { Agent } from "@agentworld/agent";
import type { Capability, Manifest } from "@agentworld/protocol";

export const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** capability → MCP tool: name, intent → description, input schema verbatim. */
export function capabilityToMcpTool(cap: Capability): McpTool {
  const scopes = cap.scopes.length ? ` [scopes: ${cap.scopes.join(", ")}]` : "";
  return {
    name: cap.name,
    description: cap.intent + scopes,
    inputSchema: cap.input && Object.keys(cap.input).length ? cap.input : { type: "object" },
  };
}

export function manifestToMcpTools(manifest: Manifest): McpTool[] {
  return manifest.capabilities.map(capabilityToMcpTool);
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** The bridge: a pure request → response function over an Agent. */
export function createMcpBridge(agent: Agent): {
  handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null>;
} {
  async function handle(req: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = req.id ?? null;
    // notifications (no id) get no response
    if (req.id === undefined) return null;

    try {
      switch (req.method) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: {} },
              serverInfo: {
                name: `agent-world:${agent.manifest.name}`,
                version: "0.1.0",
              },
              instructions:
                `This server is the Agent World agent "${agent.manifest.name}" ` +
                `(${agent.id}). Goal: ${agent.manifest.goal.statement}`,
            },
          };
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        case "tools/list":
          return { jsonrpc: "2.0", id, result: { tools: manifestToMcpTools(agent.manifest) } };
        case "tools/call": {
          const name = req.params?.["name"];
          const args = (req.params?.["arguments"] ?? {}) as Record<string, unknown>;
          if (typeof name !== "string" || !agent.manifest.capabilities.some((c) => c.name === name)) {
            return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool: ${String(name)}` } };
          }
          try {
            const result = await agent.invoke(name, args);
            return {
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false },
            };
          } catch (e) {
            // tool-level failure is an in-band tool result, not a protocol error
            return {
              jsonrpc: "2.0",
              id,
              result: { content: [{ type: "text", text: String(e instanceof Error ? e.message : e) }], isError: true },
            };
          }
        }
        default:
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${req.method}` } };
      }
    } catch (e) {
      return { jsonrpc: "2.0", id, error: { code: -32603, message: String(e) } };
    }
  }
  return { handle };
}

/** Run the bridge over stdio — `claude mcp add my-agent -- node serve-mcp.js`. */
export function serveMcpStdio(agent: Agent, io?: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream }): void {
  const bridge = createMcpBridge(agent);
  const output = io?.output ?? process.stdout;
  const rl = createInterface({ input: io?.input ?? process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    void (async () => {
      let response: JsonRpcResponse | null;
      try {
        response = await bridge.handle(JSON.parse(line) as JsonRpcRequest);
      } catch {
        response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
      }
      if (response) output.write(JSON.stringify(response) + "\n");
    })();
  });
}
