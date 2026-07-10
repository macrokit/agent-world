import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HubError, type InMemoryHub, type TaskState } from "@agentworld/protocol";

const STATUS: Record<HubError["code"], number> = {
  invalid: 400,
  unauthorized: 401,
  duplicate: 409,
  rejected: 422,
};

function observatoryHtml(): string {
  // dist/serve.js → ../../web/index.html ; src/serve.ts (tests) → same
  for (const candidate of ["../../web/index.html", "../web/index.html"]) {
    const p = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return "<h1>Agent World</h1><p>observatory page not found</p>";
}

export interface StudioServed {
  url: string;
  close(): Promise<void>;
}

/**
 * The studio server: the hub's protocol endpoints + the Observatory.
 * Observatory data is per-(agent, class) scores, open tasks, ledger totals,
 * and recent settlements — deliberately NO fleet-wide value aggregate
 * (spec 03 §8 P1/P2).
 */
export async function serveStudio(hub: InMemoryHub, port = 7800): Promise<StudioServed> {
  const page = observatoryHtml();

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return void res.end(page);
      }
      if (req.method === "POST" && url.pathname === "/aw/v0/inbox") {
        await hub.handle(await readJson(req));
        return json(res, 202, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/aw/v0/tasks") {
        return json(
          res,
          200,
          await hub.listTasks({
            status: (url.searchParams.get("status") as TaskState | null) ?? undefined,
            class: url.searchParams.get("class") ?? undefined,
          }),
        );
      }
      if (req.method === "GET" && url.pathname === "/aw/v0/agents") {
        return json(res, 200, await hub.searchAgents({ capability: url.searchParams.get("capability") ?? undefined }));
      }
      if (req.method === "GET" && url.pathname === "/aw/v0/scores") {
        return json(res, 200, { epsilon: hub.epsilon, minSamples: hub.minSamples, scores: hub.scores() });
      }
      if (req.method === "GET" && url.pathname === "/aw/v0/observatory") {
        const [agents, open, settledTasks] = await Promise.all([
          hub.searchAgents(),
          hub.listTasks({ status: "open" }),
          hub.listTasks({ status: "settled" }),
        ]);
        const failed = await hub.listTasks({ status: "failed" });
        return json(res, 200, {
          hub: hub.id,
          totals: hub.totals(),
          epsilon: hub.epsilon,
          scores: hub.scores(),
          agents: agents.map((chain) => {
            const head = chain[chain.length - 1]!;
            return {
              id: head.id,
              name: head.name,
              goal: head.goal.statement,
              sealed: head.goal.sealed ?? false,
              continuation: head.succession.continuation,
              capabilities: head.capabilities.map((c) => c.name),
              balance: hub.balance(head.id),
              revisions: chain.length,
            };
          }),
          openTasks: open.map((t) => ({ id: t.id, class: t.body.class, intent: t.body.intent, budget: t.body.budget.max, bids: t.bids.length })),
          recentOutcomes: hub.samples.slice(-20).reverse(),
          settled: settledTasks.length,
          failed: failed.length,
          deliveryFailures: hub.deliveryFailures.length,
        });
      }
      json(res, 404, { error: { code: "not-found", message: req.url } });
    } catch (e) {
      if (e instanceof HubError) return json(res, STATUS[e.code], { error: { code: e.code, message: e.message } });
      if (e instanceof SyntaxError) return json(res, 400, { error: { code: "invalid", message: "malformed JSON" } });
      json(res, 500, { error: { code: "internal", message: String(e) } });
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
