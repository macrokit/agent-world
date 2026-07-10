import { generateKeypair, type Keypair } from "@agentworld/identity";
import {
  buildHandlerModule,
  createManifest,
  HubClient,
  InMemoryHub,
  serveHub,
  serveInbox,
  type Capability,
  type Envelope,
  type Manifest,
  type Served,
} from "@agentworld/protocol";
import { afterAll, describe, expect, it } from "vitest";
import { createAgent, MandateError, type Agent } from "../src/index.js";

const servers: Served[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
});

const upperCap: Capability = {
  name: "echo_upper",
  intent: "uppercase the given text",
  input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  output: { type: "object", properties: { text: { type: "string" } } },
  scopes: [],
  pricing: { ask: 5, currency: "credit" },
  verification: ["deterministic"],
};

function manifestFor(
  key: Keypair,
  owner: Keypair,
  over?: { inbox?: string; perTask?: number; capabilities?: Capability[] },
): Manifest {
  return createManifest(
    {
      id: key.id,
      name: "test-agent",
      goal: { statement: "serve the tests" },
      capabilities: over?.capabilities ?? [upperCap],
      endpoints: { inbox: over?.inbox ?? "local:" },
      mandate: {
        spend: { perTask: over?.perTask ?? 50, perMonth: 500, currency: "credit" },
        commit: ["task.post", "task.bid", "task.accept", "task.deliver", "task.verify", "task.cancel", "msg.send"],
        reserved: [],
      },
      succession: { successors: [], continuation: "transferred" },
    },
    owner,
  );
}

function makeAgent(over?: { inbox?: string; perTask?: number; capabilities?: Capability[] }) {
  const owner = generateKeypair();
  const key = generateKeypair();
  const agent = createAgent({ manifest: manifestFor(key, owner, over), key, ownerKey: owner });
  return { agent, owner, key };
}

describe("Agent end-to-end (spec 01+02+03 together)", () => {
  it("two separately-keyed agents complete post → bid → award → deliver → settle in-process", async () => {
    const hub = new InMemoryHub(generateKeypair());
    const requester = makeAgent();
    const server = makeAgent();

    requester.agent.connect(hub).attachLocal(hub);
    server.agent.connect(hub).attachLocal(hub);
    server.agent.capability("echo_upper", async (input) => ({
      text: String(input["text"]).toUpperCase(),
    }));

    await requester.agent.register();
    await server.agent.register();
    hub.mint(requester.key.id, 100);
    hub.mint(server.key.id, 10);

    const taskId = await requester.agent.post({
      class: "echo_upper",
      intent: "uppercase 'hello agent world'",
      input: { text: "hello agent world" },
      budget: { max: 10, currency: "credit" },
      verification: { mode: "deterministic", tests: { equals: { text: "HELLO AGENT WORLD" } } },
    });

    await server.agent.bid(taskId, { price: 6, capability: "echo_upper", confidence: 0.9 });
    const bidId = (await hub.listTasks())[0]!.bids[0]!.id;
    await requester.agent.award(taskId, bidId);

    // award → auto accept → handler ran → deliver → deterministic verify → settled
    const task = hub.taskView(taskId);
    expect(task.state).toBe("settled");
    expect(task.report?.outcome).toBe("accepted");
    expect(hub.balance(server.key.id)).toBeCloseTo(16, 6); // 10 + 6, stake returned
    expect(hub.balance(requester.key.id)).toBeCloseTo(94, 6);
    hub.assertConservation();
  });

  it("runs the same flow over real HTTP (served hub, served agent inbox)", async () => {
    const hub = new InMemoryHub(generateKeypair());
    const hubSrv = await serveHub(hub);
    servers.push(hubSrv);

    // late-bound inbox: listen first, then mint the manifest with the real URL
    let target: Agent | undefined;
    const inbox = await serveInbox(async (env: Envelope) => target?.handleEnvelope(env));
    servers.push(inbox);

    const owner = generateKeypair();
    const key = generateKeypair();
    const server = createAgent({
      manifest: manifestFor(key, owner, { inbox: inbox.url }),
      key,
      ownerKey: owner,
    });
    server.capability("echo_upper", async (input) => ({ text: String(input["text"]).toUpperCase() }));
    server.connect(new HubClient(hubSrv.url));
    target = server;

    const requester = makeAgent();
    requester.agent.connect(new HubClient(hubSrv.url)).attachLocal(hub);

    await requester.agent.register();
    await server.register();
    hub.mint(requester.key.id, 100);
    hub.mint(key.id, 10);

    const taskId = await requester.agent.post({
      class: "echo_upper",
      intent: "uppercase over http",
      input: { text: "over http" },
      budget: { max: 10, currency: "credit" },
      verification: { mode: "deterministic", tests: { equals: { text: "OVER HTTP" } } },
    });
    await server.bid(taskId, { price: 5, capability: "echo_upper", confidence: 0.9 });
    const client = new HubClient(hubSrv.url);
    const bidId = (await client.listTasks())[0]!.bids[0]!.id;
    await requester.agent.award(taskId, bidId);

    // HTTP delivery is asynchronous end-to-end; poll briefly
    let state = "";
    for (let i = 0; i < 40 && state !== "settled"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      state = (await client.listTasks())[0]!.state;
    }
    expect(state).toBe("settled");
    expect(hub.balance(key.id)).toBeCloseTo(15, 6); // 10 + 5, stake returned
    hub.assertConservation();
  });

  it("refuses out-of-mandate acts locally before they reach the hub", async () => {
    const hub = new InMemoryHub(generateKeypair());
    const { agent } = makeAgent({ perTask: 5 });
    agent.connect(hub);
    await expect(
      agent.post({
        class: "echo_upper",
        intent: "too expensive",
        input: {},
        budget: { max: 6, currency: "credit" },
        verification: { mode: "requester" },
      }),
    ).rejects.toThrow(MandateError);
  });

  it("rejects construction with mismatched or identical keys", () => {
    const owner = generateKeypair();
    const key = generateKeypair();
    const manifest = manifestFor(key, owner);
    expect(() => createAgent({ manifest, key: owner })).toThrow(/does not match/);
    expect(() => createAgent({ manifest, key, ownerKey: key })).toThrow(/match/);
  });

  it("refuses to attach a handler for an undeclared capability", () => {
    const { agent } = makeAgent({ capabilities: [] });
    expect(() => agent.capability("echo_upper", async () => ({}))).toThrow(/not declared/);
  });
});

describe("installModule — the trust-before-install gate (spec 02 §8.3)", () => {
  const SOURCE = `export async function handler(input) {
    return { reversed: String(input.text).split(" ").reverse().join(" ") };
  }`;
  const artifactFor = (source: string) =>
    buildHandlerModule({
      source,
      capability: {
        name: "reverse_words",
        intent: "reverse the words of a text",
        input: { type: "object" },
        output: { type: "object" },
        scopes: ["x-demo-surface"],
      },
      cases: [{ input: { text: "a b" }, expected: { reversed: "b a" } }],
    });

  it("a decline writes nothing — no manifest change, no handler", async () => {
    const { agent } = makeAgent();
    const before = agent.manifest.seq;
    const seen: string[][] = [];
    const result = await agent.installModule(artifactFor(SOURCE), {
      approve: ({ scopes }) => {
        seen.push(scopes);
        return false;
      },
    });
    expect(result.installed).toBe(false);
    expect(seen).toEqual([["x-demo-surface"]]); // the owner SAW the scopes before deciding
    expect(agent.manifest.seq).toBe(before);
    expect(agent.manifest.capabilities.some((c) => c.name === "reverse_words")).toBe(false);
  });

  it("approval installs: owner-signed manifest revision, republished, and the skill serves", async () => {
    const hub = new InMemoryHub(generateKeypair());
    const buyer = makeAgent();
    buyer.agent.connect(hub).attachLocal(hub);
    await buyer.agent.register();
    hub.mint(buyer.key.id, 100);
    hub.mint(buyer.key.id, 10);

    const result = await buyer.agent.installModule(artifactFor(SOURCE), { approve: () => true });
    expect(result.installed).toBe(true);
    expect(buyer.agent.manifest.seq).toBe(1); // revised, owner-signed
    expect((await hub.searchAgents({ capability: "reverse_words" }))[0]).toHaveLength(2); // republished chain

    // the purchased skill now serves a market task end-to-end
    const requester = makeAgent();
    requester.agent.connect(hub).attachLocal(hub);
    await requester.agent.register();
    hub.mint(requester.key.id, 50);
    const taskId = await requester.agent.post({
      class: "reverse_words",
      intent: "reverse this",
      input: { text: "value of extension" },
      budget: { max: 5, currency: "credit" },
      verification: { mode: "deterministic", tests: { equals: { reversed: "extension of value" } } },
    });
    await buyer.agent.bid(taskId, { price: 2, capability: "reverse_words", confidence: 0.9 });
    const bidId = (await hub.listTasks({ status: "open" }))[0]!.bids[0]!.id;
    await requester.agent.award(taskId, bidId);
    expect(hub.taskView(taskId).state).toBe("settled");
    hub.assertConservation();
  });

  it("rejects a module whose hash does not match, even when approved", async () => {
    const { agent } = makeAgent();
    const bad = { ...artifactFor(SOURCE), hash: "sha256:" + "0".repeat(64) };
    await expect(agent.installModule(bad, { approve: () => true })).rejects.toThrow(/hash/);
    expect(agent.manifest.seq).toBe(0);
  });
});
