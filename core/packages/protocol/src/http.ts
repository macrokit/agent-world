import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { HubError, type InMemoryHub } from "./hub.js";
import type { Envelope, TaskState } from "./types.js";

const STATUS: Record<HubError["code"], number> = {
  invalid: 400,
  unauthorized: 401,
  duplicate: 409,
  rejected: 422,
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export interface Served {
  url: string;
  close(): Promise<void>;
}

function listen(server: Server, port: number): Promise<Served> {
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

/** The HTTPS binding of a hub (spec 02 §3). TLS is a deployment concern. */
export async function serveHub(hub: InMemoryHub, port = 0): Promise<Served> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "POST" && url.pathname === "/aw/v0/inbox") {
        await hub.handle(await readJson(req));
        return sendJson(res, 202, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/aw/v0/tasks") {
        const tasks = await hub.listTasks({
          status: (url.searchParams.get("status") as TaskState | null) ?? undefined,
          class: url.searchParams.get("class") ?? undefined,
        });
        return sendJson(res, 200, tasks);
      }
      if (req.method === "GET" && url.pathname === "/aw/v0/scores") {
        return sendJson(res, 200, {
          epsilon: hub.epsilon,
          minSamples: hub.minSamples,
          scores: hub.scores(),
        });
      }
      if (req.method === "GET" && url.pathname === "/aw/v0/agents") {
        const chains = await hub.searchAgents({
          capability: url.searchParams.get("capability") ?? undefined,
        });
        return sendJson(res, 200, chains);
      }
      sendJson(res, 404, { error: { code: "not-found", message: req.url } });
    } catch (e) {
      if (e instanceof HubError) {
        return sendJson(res, STATUS[e.code], { error: { code: e.code, message: e.message } });
      }
      if (e instanceof SyntaxError) {
        return sendJson(res, 400, { error: { code: "invalid", message: "malformed JSON" } });
      }
      sendJson(res, 500, { error: { code: "internal", message: String(e) } });
    }
  });
  return listen(server, port);
}

/** An agent's inbox binding (spec 02 §3): POST envelopes to any path. */
export async function serveInbox(
  handler: (env: Envelope) => Promise<void>,
  port = 0,
): Promise<Served> {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") return sendJson(res, 404, { error: { code: "not-found" } });
    try {
      await handler((await readJson(req)) as Envelope);
      sendJson(res, 202, { ok: true });
    } catch (e) {
      if (e instanceof HubError) {
        return sendJson(res, STATUS[e.code], { error: { code: e.code, message: e.message } });
      }
      sendJson(res, 400, { error: { code: "invalid", message: String(e) } });
    }
  });
  return listen(server, port);
}
