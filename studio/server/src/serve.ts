import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HubError, type InMemoryHub, type TaskState } from "@agentworld/protocol";

const STATUS: Record<HubError["code"], number> = {
  invalid: 400,
  unauthorized: 401,
  duplicate: 409,
  rejected: 422,
};

/** Reject request bodies larger than this before buffering them (default 256 KiB). */
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

export interface StudioServeOptions {
  port?: number;
  /** bind address — 127.0.0.1 behind a reverse proxy (default), 0.0.0.0 in a container */
  host?: string;
  /** hard cap on request body size (spec: a public inbox must not be a memory DoS) */
  maxBodyBytes?: number;
  /** one line per request; wire to your logger. Omit for silence (tests). */
  log?: (entry: { method: string; path: string; status: number; ms: number; ip: string }) => void;
}

class BodyTooLarge extends Error {}

/** Stop accepting connections, let in-flight requests finish, then drop idle keep-alives. */
function gracefulClose(server: Server, sockets: Set<Socket>, drainMs = 5000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    server.close(() => finish());
    const timer = setTimeout(() => {
      for (const s of sockets) s.destroy();
      finish();
    }, drainMs);
    if (typeof timer.unref === "function") timer.unref();
  });
}

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
export async function serveStudio(hub: InMemoryHub, opts: number | StudioServeOptions = 7800): Promise<StudioServed> {
  const options: StudioServeOptions = typeof opts === "number" ? { port: opts } : opts;
  const port = options.port ?? 7800;
  const host = options.host ?? "127.0.0.1";
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const page = observatoryHtml();

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > maxBodyBytes) throw new BodyTooLarge(`declared ${declared} > limit ${maxBodyBytes}`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > maxBodyBytes) throw new BodyTooLarge(`stream exceeded ${maxBodyBytes}`);
      chunks.push(c as Buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }

  /** Security + CORS headers on every response. The inbox is signature-authed, so
   *  cross-origin reads/posts are safe to allow; the signature is the credential. */
  function baseHeaders(contentType: string): Record<string, string> {
    return {
      "content-type": contentType,
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    };
  }
  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, baseHeaders("application/json"));
    res.end(JSON.stringify(body));
  }

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://x");
    res.on("finish", () =>
      options.log?.({
        method: req.method ?? "?",
        path: url.pathname,
        status: res.statusCode,
        ms: Date.now() - started,
        ip: req.socket.remoteAddress ?? "?",
      }),
    );
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, baseHeaders("text/plain"));
        return void res.end();
      }
      // Liveness: the process is up. Readiness: the ledger invariant holds.
      if (req.method === "GET" && url.pathname === "/healthz") {
        return json(res, 200, { ok: true, hub: hub.id });
      }
      if (req.method === "GET" && url.pathname === "/readyz") {
        try {
          hub.assertConservation();
          return json(res, 200, { ready: true, totals: hub.totals() });
        } catch (e) {
          return json(res, 503, { ready: false, error: String(e) });
        }
      }
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, baseHeaders("text/html; charset=utf-8"));
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
      if (e instanceof BodyTooLarge) return json(res, 413, { error: { code: "too-large", message: e.message } });
      if (e instanceof HubError) return json(res, STATUS[e.code], { error: { code: e.code, message: e.message } });
      if (e instanceof SyntaxError) return json(res, 400, { error: { code: "invalid", message: "malformed JSON" } });
      json(res, 500, { error: { code: "internal", message: String(e) } });
    }
  });

  // Track live sockets so close() can drain in-flight requests then hard-stop
  // idle keep-alives (graceful SIGTERM under systemd/Docker).
  const sockets = new Set<Socket>();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address() as AddressInfo;
      const shown = host === "0.0.0.0" ? "127.0.0.1" : host;
      resolve({
        url: `http://${shown}:${addr.port}`,
        close: () => gracefulClose(server, sockets),
      });
    });
  });
}
