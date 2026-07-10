/**
 * The A2A bridge (spec 02 Appendix A): serve an Agent World agent to
 * A2A-speaking clients.
 *
 * SCOPE, honestly: this is an inbound v0 SUBSET of A2A —
 *   - the AgentCard at /.well-known/agent.json (capabilities → skills),
 *   - JSON-RPC `message/send` completing synchronously (no streaming, no
 *     push notifications, no long-running task states).
 * The aw value layer (bids, escrow, stakes, settlement) has no A2A
 * equivalent; a bridged call is a direct local invoke by the agent's owner,
 * exactly like the MCP bridge. Outbound bridging (an aw agent hiring
 * A2A agents) is future work.
 */
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type { Agent } from "@agentworld/agent";
import type { Manifest } from "@agentworld/protocol";

export const A2A_DIALECT = "a2a/0.3-subset";

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  protocolVersion: string;
  capabilities: { streaming: boolean; pushNotifications: boolean };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Array<{ id: string; name: string; description: string; tags: string[] }>;
  /** aw extension: the agent's verifiable identity and declared goal */
  extensions: { agentWorld: { id: string; owner: string; goal: string; spec: string } };
}

/** manifest → AgentCard: capabilities become skills; identity rides as an extension. */
export function manifestToAgentCard(manifest: Manifest, baseUrl: string): AgentCard {
  return {
    name: manifest.name,
    description: manifest.goal.statement,
    url: baseUrl,
    version: "0.1.0",
    protocolVersion: A2A_DIALECT,
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: manifest.capabilities.map((c) => ({
      id: c.name,
      name: c.name,
      description: c.intent,
      tags: c.scopes,
    })),
    extensions: {
      agentWorld: { id: manifest.id, owner: manifest.owner, goal: manifest.goal.statement, spec: manifest.spec },
    },
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Serve the bridge. `message/send` params (subset):
 *   { message: { parts: [{ kind: "data", data: {...} }], metadata?: { skillId } } }
 * The skill is `metadata.skillId`, or the agent's single capability when it
 * has exactly one. Returns a completed A2A Task with one data artifact.
 */
export async function serveA2a(agent: Agent, port = 0): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/.well-known/agent.json") {
        const addr = server.address() as AddressInfo;
        return send(200, manifestToAgentCard(agent.manifest, `http://127.0.0.1:${addr.port}`));
      }
      if (req.method === "POST" && url.pathname === "/") {
        const rpc = (await readJson(req)) as { jsonrpc: string; id: unknown; method: string; params?: Record<string, unknown> };
        if (rpc.method !== "message/send") {
          return send(200, { jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32601, message: `unsupported method: ${rpc.method} (${A2A_DIALECT})` } });
        }
        const message = rpc.params?.["message"] as
          | { parts?: Array<{ kind?: string; data?: Record<string, unknown> }>; metadata?: { skillId?: string } }
          | undefined;
        const skillId =
          message?.metadata?.skillId ??
          (agent.manifest.capabilities.length === 1 ? agent.manifest.capabilities[0]!.name : undefined);
        const data = message?.parts?.find((p) => p.kind === "data")?.data ?? {};
        if (!skillId || !agent.manifest.capabilities.some((c) => c.name === skillId)) {
          return send(200, { jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32602, message: `unknown or unspecified skill: ${String(skillId)}` } });
        }
        try {
          const result = await agent.invoke(skillId, data);
          return send(200, {
            jsonrpc: "2.0",
            id: rpc.id ?? null,
            result: {
              id: randomUUID(),
              contextId: randomUUID(),
              status: { state: "completed" },
              artifacts: [{ artifactId: randomUUID(), parts: [{ kind: "data", data: result }] }],
              kind: "task",
            },
          });
        } catch (e) {
          return send(200, {
            jsonrpc: "2.0",
            id: rpc.id ?? null,
            result: {
              id: randomUUID(),
              status: { state: "failed", message: { parts: [{ kind: "text", text: String(e instanceof Error ? e.message : e) }] } },
              kind: "task",
            },
          });
        }
      }
      send(404, { error: "not found" });
    } catch (e) {
      send(400, { error: String(e) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
