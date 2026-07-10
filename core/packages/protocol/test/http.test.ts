import { generateKeypair } from "@agentworld/identity";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createEnvelope } from "../src/envelope.js";
import { InMemoryHub } from "../src/hub.js";
import { serveHub, serveInbox, type Served } from "../src/http.js";
import { HubClient } from "../src/client.js";
import type { Envelope } from "../src/types.js";
import { makeActor } from "./helpers.js";

const servers: Served[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
});

describe("HTTP binding (spec 02 §3)", () => {
  it("runs the market flow over HTTP with a real agent inbox", async () => {
    const hub = new InMemoryHub(generateKeypair());
    const hubSrv = await serveHub(hub);
    servers.push(hubSrv);
    const client = new HubClient(hubSrv.url);

    const requester = makeActor();
    const received: Envelope[] = [];
    const inbox = await serveInbox(async (env) => void received.push(env));
    servers.push(inbox);

    // server-agent manifest points at a real HTTP inbox
    const server = makeActor({ fields: { endpoints: { inbox: inbox.url } } });
    hub.registerInbox(requester.agent.id, async () => {});

    await client.send(createEnvelope("manifest.publish", requester.owner, { manifest: requester.manifest }));
    await client.send(createEnvelope("manifest.publish", server.owner, { manifest: server.manifest }));
    hub.mint(requester.agent.id, 100);
    hub.mint(server.agent.id, 10);

    const taskId = randomUUID();
    await client.send(
      createEnvelope(
        "task.post",
        requester.agent,
        {
          class: "echo_upper",
          intent: "uppercase it",
          input: { text: "hi" },
          budget: { max: 10, currency: "credit" },
          verification: { mode: "deterministic", tests: { equals: { text: "HI" } } },
        },
        { task: taskId },
      ),
    );

    const open = await client.listTasks({ status: "open" });
    expect(open).toHaveLength(1);

    await client.send(
      createEnvelope("task.bid", server.agent, { price: 8, capability: "echo_upper", confidence: 0.9 }, { task: taskId }),
    );
    const bidId = (await client.listTasks())[0]!.bids[0]!.id;
    await client.send(createEnvelope("task.award", requester.agent, { bid: bidId }, { task: taskId }));

    // award arrived at the HTTP inbox
    expect(received.some((e) => e.type === "task.award" && e.task === taskId)).toBe(true);

    await client.send(
      createEnvelope("task.deliver", server.agent, { artifacts: [{ kind: "inline", data: { text: "HI" } }] }, { task: taskId }),
    );
    expect((await client.listTasks({ status: "settled" }))).toHaveLength(1);

    const agents = await client.searchAgents({ capability: "echo_upper" });
    expect(agents.length).toBe(2);
    hub.assertConservation();
  });

  it("maps HubError codes to HTTP statuses", async () => {
    const hub = new InMemoryHub(generateKeypair());
    const hubSrv = await serveHub(hub);
    servers.push(hubSrv);

    // invalid envelope → 400
    const res400 = await fetch(`${hubSrv.url}/aw/v0/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nope: true }),
    });
    expect(res400.status).toBe(400);

    // duplicate → 409
    const actor = makeActor();
    hub.registerInbox(actor.agent.id, async () => {});
    const client = new HubClient(hubSrv.url);
    await client.send(createEnvelope("manifest.publish", actor.owner, { manifest: actor.manifest }));
    const env = createEnvelope("msg.send", actor.agent, { text: "x" }, { to: actor.agent.id });
    await client.send(env);
    const res409 = await fetch(`${hubSrv.url}/aw/v0/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(env),
    });
    expect(res409.status).toBe(409);

    // rejected protocol rule → 422
    const res422 = await fetch(`${hubSrv.url}/aw/v0/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createEnvelope("task.hack", actor.agent, {})),
    });
    expect(res422.status).toBe(422);
  });
});
