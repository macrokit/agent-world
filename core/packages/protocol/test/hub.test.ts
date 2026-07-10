import { generateKeypair } from "@agentworld/identity";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEnvelope } from "../src/envelope.js";
import { HubError, InMemoryHub } from "../src/hub.js";
import { buildHandlerModule, sourceToDataUrl } from "../src/module.js";
import type { Envelope, TaskBody } from "../src/types.js";
import { makeActor, type Actor } from "./helpers.js";

const taskBody = (over?: Partial<TaskBody>): Record<string, unknown> => ({
  class: "echo_upper",
  intent: "uppercase 'hello world'",
  input: { text: "hello world" },
  budget: { max: 10, currency: "credit" },
  verification: { mode: "requester" },
  ...over,
});

async function setup(opts?: { verification?: TaskBody["verification"] }) {
  const hub = new InMemoryHub(generateKeypair());
  const requester = makeActor();
  const server = makeActor();
  const serverInbox: Envelope[] = [];
  hub.registerInbox(requester.agent.id, async () => {});
  hub.registerInbox(server.agent.id, async (e) => void serverInbox.push(e));

  await hub.handle(createEnvelope("manifest.publish", requester.owner, { manifest: requester.manifest }));
  await hub.handle(createEnvelope("manifest.publish", server.owner, { manifest: server.manifest }));
  hub.mint(requester.owner.id, 100); // onboarding grants (rule-stated)
  hub.mint(server.agent.id, 10);

  const taskId = randomUUID();
  await hub.handle(
    createEnvelope("task.post", requester.agent, taskBody({ verification: opts?.verification ?? { mode: "requester" } }), { task: taskId }),
  );
  return { hub, requester, server, serverInbox, taskId };
}

async function bidAndAward(hub: InMemoryHub, requester: Actor, server: Actor, taskId: string, confidence = 0.8) {
  await hub.handle(
    createEnvelope("task.bid", server.agent, { price: 8, capability: "echo_upper", confidence }, { task: taskId }),
  );
  const bidId = (await hub.listTasks())[0]!.bids[0]!.id;
  await hub.handle(createEnvelope("task.award", requester.agent, { bid: bidId }, { task: taskId }));
}

describe("InMemoryHub market flow (spec 02 §4, 03 §3–4)", () => {
  it("post → bid → award → deliver → verify(accepted) settles correctly", async () => {
    const { hub, requester, server, serverInbox, taskId } = await setup();

    expect(hub.balance(requester.owner.id)).toBe(90); // 10 escrowed
    await bidAndAward(hub, requester, server, taskId);
    // stake = 0.2 · 0.8 · 8 = 1.28
    expect(hub.balance(server.agent.id)).toBeCloseTo(8.72, 6);
    expect(serverInbox.some((e) => e.type === "task.award")).toBe(true);

    await hub.handle(createEnvelope("task.accept", server.agent, {}, { task: taskId }));
    await hub.handle(
      createEnvelope("task.deliver", server.agent, { artifacts: [{ kind: "inline", data: { text: "HELLO WORLD" } }] }, { task: taskId }),
    );
    await hub.handle(createEnvelope("task.verify", requester.agent, { outcome: "accepted" }, { task: taskId }));

    expect((await hub.listTasks())[0]!.state).toBe("settled");
    expect(hub.balance(server.agent.id)).toBeCloseTo(18, 6); // 10 − 1.28 + 8 + 1.28
    expect(hub.balance(requester.owner.id)).toBeCloseTo(92, 6); // 100 − 8
    expect(hub.samples).toHaveLength(1);
    expect(hub.samples[0]).toMatchObject({ server: server.agent.id, class: "echo_upper", outcome: "accepted" });
    hub.assertConservation();
  });

  it("rejected verification refunds the requester and burns the stake", async () => {
    const { hub, requester, server, taskId } = await setup();
    await bidAndAward(hub, requester, server, taskId, 1.0); // stake = 0.2·1·8 = 1.6
    await hub.handle(createEnvelope("task.accept", server.agent, {}, { task: taskId }));
    await hub.handle(
      createEnvelope("task.deliver", server.agent, { artifacts: [{ kind: "inline", data: { text: "hello world" } }] }, { task: taskId }),
    );
    await hub.handle(createEnvelope("task.verify", requester.agent, { outcome: "rejected" }, { task: taskId }));

    expect((await hub.listTasks())[0]!.state).toBe("failed");
    expect(hub.balance(requester.owner.id)).toBe(100);
    expect(hub.balance(server.agent.id)).toBeCloseTo(8.4, 6);
    expect(hub.totals().burned).toBeCloseTo(1.6, 6); // destroyed, not redistributed (03 §4.1)
    hub.assertConservation();
  });

  it("partial settles pro-rata and burns the unearned stake fraction", async () => {
    const { hub, requester, server, taskId } = await setup();
    await bidAndAward(hub, requester, server, taskId, 0.5); // stake 0.8
    await hub.handle(
      createEnvelope("task.deliver", server.agent, { artifacts: [{ kind: "inline", data: { text: "HELLO" } }] }, { task: taskId }),
    );
    await hub.handle(createEnvelope("task.verify", requester.agent, { outcome: "partial", quality: 0.5 }, { task: taskId }));

    expect(hub.balance(server.agent.id)).toBeCloseTo(10 - 0.8 + 4 + 0.4, 6);
    expect(hub.balance(requester.owner.id)).toBeCloseTo(96, 6);
    expect(hub.totals().burned).toBeCloseTo(0.4, 6);
    hub.assertConservation();
  });

  it("deterministic mode auto-verifies on deliver (equals + category Tier-A sample)", async () => {
    const { hub, requester, server, taskId } = await setup({
      verification: { mode: "deterministic", tests: { equals: { text: "HELLO WORLD" } } },
    });
    await bidAndAward(hub, requester, server, taskId);
    await hub.handle(
      createEnvelope("task.deliver", server.agent, { artifacts: [{ kind: "inline", data: { text: "HELLO WORLD" } }] }, { task: taskId }),
    );
    expect((await hub.listTasks())[0]!.state).toBe("settled");

    const task2 = randomUUID();
    await hub.handle(
      createEnvelope(
        "task.post",
        requester.agent,
        taskBody({ verification: { mode: "deterministic", tests: { category: "positive" } } }),
        { task: task2 },
      ),
    );
    await hub.handle(createEnvelope("task.bid", server.agent, { price: 5, capability: "echo_upper", confidence: 0.9 }, { task: task2 }));
    const bidId = (await hub.listTasks({ status: "open" }))[0]!.bids[0]!.id;
    await hub.handle(createEnvelope("task.award", requester.agent, { bid: bidId }, { task: task2 }));
    await hub.handle(
      createEnvelope("task.deliver", server.agent, { artifacts: [{ kind: "inline", data: { category: "negative" } }] }, { task: task2 }),
    );
    const sample = hub.samples.find((s) => s.categories);
    expect(sample?.categories).toEqual({ expected: "positive", delivered: "negative" });
    expect(sample?.outcome).toBe("rejected");
    hub.assertConservation();
  });
});

describe("InMemoryHub enforcement", () => {
  it("rejects duplicate envelopes (replay)", async () => {
    const { hub, requester } = await setup();
    const env = createEnvelope("msg.send", requester.agent, { text: "hi" }, { to: requester.agent.id });
    await hub.handle(env);
    await expect(hub.handle(env)).rejects.toThrow(/duplicate/);
  });

  it("enforces mandate: act type, perTask, and perMonth (spec 01 §5.1)", async () => {
    const hub = new InMemoryHub(generateKeypair());
    const limited = makeActor({
      fields: {
        mandate: {
          spend: { perTask: 5, perMonth: 8, currency: "credit" },
          commit: ["task.post"],
          reserved: [],
        },
      },
    });
    await hub.handle(createEnvelope("manifest.publish", limited.owner, { manifest: limited.manifest }));
    hub.mint(limited.owner.id, 100);

    await expect(
      hub.handle(createEnvelope("task.post", limited.agent, taskBody({ budget: { max: 6, currency: "credit" } }), { task: randomUUID() })),
    ).rejects.toThrow(/perTask/);
    await expect(
      hub.handle(createEnvelope("msg.send", limited.agent, { text: "hi" }, { to: limited.agent.id })),
    ).rejects.toThrow(/mandate/);
    await hub.handle(createEnvelope("task.post", limited.agent, taskBody({ budget: { max: 5, currency: "credit" } }), { task: randomUUID() }));
    await expect(
      hub.handle(createEnvelope("task.post", limited.agent, taskBody({ budget: { max: 4, currency: "credit" } }), { task: randomUUID() })),
    ).rejects.toThrow(/perMonth/);
  });

  it("no escrow, no OPEN: rejects a post the owner cannot fund", async () => {
    const hub = new InMemoryHub(generateKeypair());
    const poor = makeActor();
    await hub.handle(createEnvelope("manifest.publish", poor.owner, { manifest: poor.manifest }));
    await expect(
      hub.handle(createEnvelope("task.post", poor.agent, taskBody(), { task: randomUUID() })),
    ).rejects.toThrow(/insufficient/);
  });

  it("rejects bids without the declared capability and from uninvited agents on direct tasks", async () => {
    const { hub, requester, server, taskId } = await setup();
    const impostor = makeActor({ capabilities: [] });
    await hub.handle(createEnvelope("manifest.publish", impostor.owner, { manifest: impostor.manifest }));
    await expect(
      hub.handle(createEnvelope("task.bid", impostor.agent, { price: 5, capability: "echo_upper", confidence: 0.5 }, { task: taskId })),
    ).rejects.toThrow(/capability/);

    const direct = randomUUID();
    await hub.handle(
      createEnvelope("task.post", requester.agent, taskBody({ visibility: "direct", servers: [requester.agent.id] }), { task: direct }),
    );
    await expect(
      hub.handle(createEnvelope("task.bid", server.agent, { price: 5, capability: "echo_upper", confidence: 0.5 }, { task: direct })),
    ).rejects.toThrow(/invited/);
  });

  it("only the requester awards and verifies", async () => {
    const { hub, requester, server, taskId } = await setup();
    await hub.handle(createEnvelope("task.bid", server.agent, { price: 8, capability: "echo_upper", confidence: 0.8 }, { task: taskId }));
    const bidId = (await hub.listTasks())[0]!.bids[0]!.id;
    await expect(
      hub.handle(createEnvelope("task.award", server.agent, { bid: bidId }, { task: taskId })),
    ).rejects.toThrow(/requester/);
    await hub.handle(createEnvelope("task.award", requester.agent, { bid: bidId }, { task: taskId }));
    await hub.handle(
      createEnvelope("task.deliver", server.agent, { artifacts: [{ kind: "inline", data: { text: "X" } }] }, { task: taskId }),
    );
    await expect(
      hub.handle(createEnvelope("task.verify", server.agent, { outcome: "accepted" }, { task: taskId })),
    ).rejects.toThrow(/requester/);
  });

  it("cancel refunds escrow (and returns the stake when awarded)", async () => {
    const { hub, requester, server, taskId } = await setup();
    await bidAndAward(hub, requester, server, taskId);
    await hub.handle(createEnvelope("task.cancel", requester.agent, {}, { task: taskId }));
    expect((await hub.listTasks())[0]!.state).toBe("cancelled");
    expect(hub.balance(requester.owner.id)).toBe(100);
    expect(hub.balance(server.agent.id)).toBe(10);
    hub.assertConservation();
  });

  it("rejects unsupported envelope types", async () => {
    const { hub, requester } = await setup();
    await expect(hub.handle(createEnvelope("task.hack", requester.agent, {}))).rejects.toThrow(HubError);
  });
});

describe("capability-module verification (spec 02 §8.3)", () => {
  const GOOD_SOURCE = `export async function handler(input) {
    return { reversed: String(input.text).split(" ").reverse().join(" ") };
  }`;
  const BAD_SOURCE = `export async function handler(input) { return { reversed: input.text }; }`;
  const CASES = [
    { input: { text: "hello agent world" }, expected: { reversed: "world agent hello" } },
    { input: { text: "a b" }, expected: { reversed: "b a" } },
  ];
  const moduleCapability = {
    name: "reverse_words",
    intent: "reverse the words of a text",
    input: { type: "object" },
    output: { type: "object" },
    scopes: [],
  };

  async function postModuleTask(hub: InMemoryHub, requester: Actor, server: Actor) {
    const taskId = randomUUID();
    await hub.handle(
      createEnvelope(
        "task.post",
        requester.agent,
        taskBody({
          class: "open",
          verification: { mode: "deterministic", tests: { cases: CASES } },
        }),
        { task: taskId },
      ),
    );
    await hub.handle(
      createEnvelope("task.bid", server.agent, { price: 8, capability: "echo_upper", confidence: 0.9 }, { task: taskId }),
    );
    const bidId = (await hub.listTasks({ status: "open" })).find((t) => t.id === taskId)!.bids[0]!.id;
    await hub.handle(createEnvelope("task.award", requester.agent, { bid: bidId }, { task: taskId }));
    return taskId;
  }

  it("settles when the delivered module passes all declared cases", async () => {
    const { hub, requester, server } = await setup();
    const taskId = await postModuleTask(hub, requester, server);
    const artifact = buildHandlerModule({ source: GOOD_SOURCE, capability: moduleCapability, cases: CASES });
    await hub.handle(createEnvelope("task.deliver", server.agent, { artifacts: [artifact] }, { task: taskId }));
    const t = hub.taskView(taskId);
    expect(t.state).toBe("settled");
    expect(t.report?.evidence).toMatchObject({ check: "cases", passed: 2, total: 2 });
    hub.assertConservation();
  });

  it("rejects a module that fails cases — stake burns", async () => {
    const { hub, requester, server } = await setup();
    const taskId = await postModuleTask(hub, requester, server);
    const artifact = buildHandlerModule({ source: BAD_SOURCE, capability: moduleCapability, cases: CASES });
    await hub.handle(createEnvelope("task.deliver", server.agent, { artifacts: [artifact] }, { task: taskId }));
    expect(hub.taskView(taskId).state).toBe("failed");
    expect(hub.totals().burned).toBeGreaterThan(0);
    hub.assertConservation();
  });

  it("rejects a module whose content does not match its hash", async () => {
    const { hub, requester, server } = await setup();
    const taskId = await postModuleTask(hub, requester, server);
    const artifact = buildHandlerModule({ source: GOOD_SOURCE, capability: moduleCapability, cases: CASES });
    const tampered = { ...artifact, url: sourceToDataUrl(BAD_SOURCE) };
    await hub.handle(createEnvelope("task.deliver", server.agent, { artifacts: [tampered] }, { task: taskId }));
    const t = hub.taskView(taskId);
    expect(t.state).toBe("failed");
    expect(JSON.stringify(t.report?.evidence)).toContain("hash");
  });
});

describe("value-price auto-award (spec 03 §5–6)", () => {
  /** Settle `n` deterministic rounds for `server`, passing or failing them all. */
  async function buildHistory(
    hub: InMemoryHub,
    requester: Actor,
    server: Actor,
    n: number,
    pass: boolean,
  ): Promise<void> {
    for (let i = 0; i < n; i++) {
      const taskId = randomUUID();
      await hub.handle(
        createEnvelope(
          "task.post",
          requester.agent,
          taskBody({ budget: { max: 2, currency: "credit" }, verification: { mode: "deterministic", tests: { equals: { ok: true } } } }),
          { task: taskId },
        ),
      );
      await hub.handle(
        createEnvelope("task.bid", server.agent, { price: 1, capability: "echo_upper", confidence: 0.9 }, { task: taskId }),
      );
      const bidId = (await hub.listTasks({ status: "open" })).find((t) => t.id === taskId)!.bids[0]!.id;
      await hub.handle(createEnvelope("task.award", requester.agent, { bid: bidId }, { task: taskId }));
      await hub.handle(
        createEnvelope("task.deliver", server.agent, { artifacts: [{ kind: "inline", data: { ok: pass } }] }, { task: taskId }),
      );
    }
  }

  async function richSetup(opts?: { epsilon?: number; random?: () => number }) {
    const hub = new InMemoryHub(generateKeypair(), { epsilon: opts?.epsilon ?? 0, random: opts?.random });
    const requester = makeActor({ fields: { mandate: { spend: { perTask: 50, perMonth: 5000, currency: "credit" }, commit: ["task.post", "task.verify", "task.cancel", "msg.send"], reserved: [] } } });
    const good = makeActor();
    const bad = makeActor();
    for (const a of [requester, good, bad]) {
      hub.registerInbox(a.agent.id, async () => {});
      await hub.handle(createEnvelope("manifest.publish", a.owner, { manifest: a.manifest }));
    }
    hub.mint(requester.owner.id, 1000);
    hub.mint(good.agent.id, 50);
    hub.mint(bad.agent.id, 50);
    await buildHistory(hub, requester, good, 6, true);
    await buildHistory(hub, requester, bad, 6, false);
    return { hub, requester, good, bad };
  }

  it("scores are per (agent, class) with n published", async () => {
    const { hub, good, bad } = await richSetup();
    const scores = hub.scores();
    const g = scores.find((s) => s.server === good.agent.id)!;
    const b = scores.find((s) => s.server === bad.agent.id)!;
    expect(g.n).toBe(6);
    expect(g.vhat).toBeGreaterThan(0.5);
    expect(b.vhat).toBeLessThan(0.05);
    expect(scores.every((s) => s.class === "echo_upper")).toBe(true);
  });

  it("auto-award routes to the best V̂/price even when it is pricier", async () => {
    const { hub, requester, good, bad } = await richSetup();
    const taskId = randomUUID();
    await hub.handle(createEnvelope("task.post", requester.agent, taskBody(), { task: taskId }));
    await hub.handle(createEnvelope("task.bid", bad.agent, { price: 1, capability: "echo_upper", confidence: 0.9 }, { task: taskId }));
    await hub.handle(createEnvelope("task.bid", good.agent, { price: 8, capability: "echo_upper", confidence: 0.9 }, { task: taskId }));
    await hub.handle(createEnvelope("task.award", requester.agent, { auto: true }, { task: taskId }));
    expect(hub.taskView(taskId).award?.server).toBe(good.agent.id);
    hub.assertConservation();
  });

  it("ε-exploration can route a novice; replay reproduces the decision deterministically", async () => {
    const { hub, requester, good } = await richSetup({ epsilon: 1, random: undefined });
    // fresh novice with zero samples
    const novice = makeActor();
    hub.registerInbox(novice.agent.id, async () => {});
    await hub.handle(createEnvelope("manifest.publish", novice.owner, { manifest: novice.manifest }));
    hub.mint(novice.agent.id, 50);

    const taskId = randomUUID();
    await hub.handle(createEnvelope("task.post", requester.agent, taskBody(), { task: taskId }));
    await hub.handle(createEnvelope("task.bid", good.agent, { price: 5, capability: "echo_upper", confidence: 0.9 }, { task: taskId }));
    await hub.handle(createEnvelope("task.bid", novice.agent, { price: 5, capability: "echo_upper", confidence: 0.5 }, { task: taskId }));
    await hub.handle(createEnvelope("task.award", requester.agent, { auto: true }, { task: taskId }));
    // ε=1 and one novice among bidders → exploration must pick the novice
    expect(hub.taskView(taskId).award?.server).toBe(novice.agent.id);
  });
});
