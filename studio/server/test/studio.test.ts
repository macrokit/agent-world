import { generateKeypair, type Keypair } from "@agentworld/identity";
import { createEnvelope, createManifest, type Capability, type Manifest } from "@agentworld/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DurableHub } from "../src/durable-hub.js";
import { serveStudio, type StudioServed } from "../src/serve.js";

const dirs: string[] = [];
const servers: StudioServed[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "aw-studio-"));
  dirs.push(d);
  return d;
}

const cap: Capability = {
  name: "echo_upper",
  intent: "uppercase",
  input: {},
  output: {},
  scopes: [],
  verification: ["deterministic"],
};

function actor(commit?: string[]): { owner: Keypair; agent: Keypair; manifest: Manifest } {
  const owner = generateKeypair();
  const agent = generateKeypair();
  const manifest = createManifest(
    {
      id: agent.id,
      name: "studio-test",
      goal: { statement: "test" },
      capabilities: [cap],
      endpoints: { inbox: "local:none" },
      mandate: {
        spend: { perTask: 50, perMonth: 5000, currency: "credit" },
        commit: (commit ?? ["task.post", "task.bid", "task.accept", "task.deliver", "task.verify", "task.cancel", "msg.send"]) as never,
        reserved: [],
      },
      succession: { successors: [], continuation: "endowed" },
    },
    owner,
  );
  return { owner, agent, manifest };
}

async function settleOne(hub: DurableHub, requester: ReturnType<typeof actor>, server: ReturnType<typeof actor>, auto = false) {
  const taskId = randomUUID();
  await hub.handle(
    createEnvelope(
      "task.post",
      requester.agent,
      {
        class: "echo_upper",
        intent: "x",
        input: {},
        budget: { max: 5, currency: "credit" },
        verification: { mode: "deterministic", tests: { equals: { ok: true } } },
      },
      { task: taskId },
    ),
  );
  await hub.handle(createEnvelope("task.bid", server.agent, { price: 2, capability: "echo_upper", confidence: 0.9 }, { task: taskId }));
  const award = auto
    ? { auto: true }
    : { bid: (await hub.listTasks({ status: "open" })).find((t) => t.id === taskId)!.bids[0]!.id };
  await hub.handle(createEnvelope("task.award", requester.agent, award, { task: taskId }));
  await hub.handle(createEnvelope("task.deliver", server.agent, { artifacts: [{ kind: "inline", data: { ok: true } }] }, { task: taskId }));
  return taskId;
}

describe("studio server (Observatory + hub endpoints)", () => {
  it("serves the observatory page and its data endpoint", async () => {
    const hub = await DurableHub.open(tmp());
    const srv = await serveStudio(hub, 0);
    servers.push(srv);

    const requester = actor();
    const server = actor();
    await hub.handle(createEnvelope("manifest.publish", requester.owner, { manifest: requester.manifest }));
    await hub.handle(createEnvelope("manifest.publish", server.owner, { manifest: server.manifest }));
    hub.mintWithRule(requester.owner.id, 100, "test grant");
    hub.mintWithRule(server.agent.id, 10, "test grant");
    await settleOne(hub, requester, server);

    const page = await (await fetch(srv.url + "/")).text();
    expect(page).toContain("observatory");
    expect(page).toContain("no global value number"); // the P1/P2 posture, stated on the page

    const data = (await (await fetch(srv.url + "/aw/v0/observatory")).json()) as Record<string, never>;
    expect(data["settled"]).toBe(1);
    expect((data["agents"] as unknown[]).length).toBe(2);
    expect((data["scores"] as Array<{ n: number }>)[0]!.n).toBe(1);
    const scores = (await (await fetch(srv.url + "/aw/v0/scores")).json()) as { epsilon: number };
    expect(scores.epsilon).toBe(0.1);
  });

  it("auto-award decisions replay deterministically from the journal", async () => {
    const dir = tmp();
    const requester = actor(["task.post", "task.verify", "task.cancel", "msg.send"]);
    const serverA = actor();
    const serverB = actor();

    let winner: string | undefined;
    {
      const hub = await DurableHub.open(dir);
      for (const a of [requester, serverA, serverB]) {
        await hub.handle(createEnvelope("manifest.publish", a.owner, { manifest: a.manifest }));
      }
      hub.mintWithRule(requester.owner.id, 100, "grant");
      hub.mintWithRule(serverA.agent.id, 20, "grant");
      hub.mintWithRule(serverB.agent.id, 20, "grant");

      // both bid; both are zero-sample novices → router may explore; decision is keyed randomness
      const taskId = randomUUID();
      await hub.handle(
        createEnvelope(
          "task.post",
          requester.agent,
          { class: "echo_upper", intent: "x", input: {}, budget: { max: 5, currency: "credit" }, verification: { mode: "requester" } },
          { task: taskId },
        ),
      );
      await hub.handle(createEnvelope("task.bid", serverA.agent, { price: 2, capability: "echo_upper", confidence: 0.9 }, { task: taskId }));
      await hub.handle(createEnvelope("task.bid", serverB.agent, { price: 3, capability: "echo_upper", confidence: 0.9 }, { task: taskId }));
      await hub.handle(createEnvelope("task.award", requester.agent, { auto: true }, { task: taskId }));
      winner = (await hub.listTasks()).find((t) => t.id === taskId)!.award!.server;
      hub.assertConservation();
    }

    const revived = await DurableHub.open(dir);
    const task = (await revived.listTasks())[0]!;
    expect(task.award?.server).toBe(winner); // same decision, or replay would corrupt balances
    revived.assertConservation();
  });
});
