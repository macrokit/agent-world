import { generateKeypair, type Keypair } from "@agentworld/identity";
import {
  createEnvelope,
  createManifest,
  reviseManifest,
  type Capability,
  type Manifest,
} from "@agentworld/protocol";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DurableHub } from "../src/durable-hub.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "aw-hub-"));
  dirs.push(d);
  return d;
}

const cap: Capability = {
  name: "echo_upper",
  intent: "uppercase text",
  input: {},
  output: {},
  scopes: [],
  verification: ["deterministic"],
};

function actor(): { owner: Keypair; agent: Keypair; manifest: Manifest } {
  const owner = generateKeypair();
  const agent = generateKeypair();
  const manifest = createManifest(
    {
      id: agent.id,
      name: "durable-test",
      goal: { statement: "test durability" },
      capabilities: [cap],
      endpoints: { inbox: "local:none" },
      mandate: {
        spend: { perTask: 50, perMonth: 500, currency: "credit" },
        commit: ["task.post", "task.bid", "task.accept", "task.deliver", "task.verify", "task.cancel", "msg.send"],
        reserved: [],
      },
      succession: { successors: [], continuation: "transferred" },
    },
    owner,
  );
  return { owner, agent, manifest };
}

async function marketRound(hub: DurableHub, requester: ReturnType<typeof actor>, server: ReturnType<typeof actor>) {
  const taskId = randomUUID();
  await hub.handle(
    createEnvelope(
      "task.post",
      requester.agent,
      {
        class: "echo_upper",
        intent: "uppercase 'x'",
        input: { text: "x" },
        budget: { max: 10, currency: "credit" },
        verification: { mode: "deterministic", tests: { equals: { text: "X" } } },
      },
      { task: taskId },
    ),
  );
  await hub.handle(createEnvelope("task.bid", server.agent, { price: 6, capability: "echo_upper", confidence: 0.9 }, { task: taskId }));
  const bidId = (await hub.listTasks({ status: "open" })).find((t) => t.id === taskId)!.bids[0]!.id;
  await hub.handle(createEnvelope("task.award", requester.agent, { bid: bidId }, { task: taskId }));
  await hub.handle(
    createEnvelope("task.deliver", server.agent, { artifacts: [{ kind: "inline", data: { text: "X" } }] }, { task: taskId }),
  );
  return taskId;
}

describe("DurableHub (studio/server)", () => {
  it("persists hub identity across restarts", async () => {
    const dir = tmp();
    const a = await DurableHub.open(dir);
    const b = await DurableHub.open(dir);
    expect(b.id).toBe(a.id);
  });

  it("recovers full market state from the journal after a restart", async () => {
    const dir = tmp();
    const requester = actor();
    const server = actor();

    {
      const hub = await DurableHub.open(dir);
      await hub.handle(createEnvelope("manifest.publish", requester.owner, { manifest: requester.manifest }));
      await hub.handle(createEnvelope("manifest.publish", server.owner, { manifest: server.manifest }));
      hub.mintWithRule(requester.agent.id, 100, "test onboarding grant");
      hub.mintWithRule(server.agent.id, 10, "test onboarding grant");
      await marketRound(hub, requester, server);
      expect((await hub.listTasks({ status: "settled" }))).toHaveLength(1);
      hub.assertConservation();
    } // hub instance dropped — "process exit"

    const revived = await DurableHub.open(dir);
    expect((await revived.listTasks({ status: "settled" }))).toHaveLength(1);
    expect(revived.balance(server.agent.id)).toBeCloseTo(16, 6); // 10 + 6, stake back
    expect(revived.balance(requester.agent.id)).toBeCloseTo(94, 6);
    expect(await revived.searchAgents({ capability: "echo_upper" })).toHaveLength(2);
    expect(revived.samples).toHaveLength(1);
    revived.assertConservation();

    // and it keeps working after recovery — a second full round
    await marketRound(revived, requester, server);
    expect((await revived.listTasks({ status: "settled" }))).toHaveLength(2);
    expect(revived.balance(server.agent.id)).toBeCloseTo(22, 6);
    revived.assertConservation();

    // a third instance recovers BOTH rounds (journal grew after recovery)
    const third = await DurableHub.open(dir);
    expect((await third.listTasks({ status: "settled" }))).toHaveLength(2);
    third.assertConservation();
  });

  it("tombstones rejected envelopes and skips them on replay", async () => {
    const dir = tmp();
    const hub = await DurableHub.open(dir);
    const nobody = actor(); // never registered
    await expect(
      hub.handle(createEnvelope("task.post", nobody.agent, { junk: true }, { task: randomUUID() })),
    ).rejects.toThrow();
    const journal = readFileSync(join(dir, "journal.jsonl"), "utf8");
    expect(journal).toContain('"rejected"');
    // replay skips the rejected envelope and recovers to empty state
    const again = await DurableHub.open(dir);
    expect(await again.listTasks()).toHaveLength(0);
    again.assertConservation();
  });

  it("recovers nested in-process flows in causal order (award → accept/deliver)", async () => {
    const dir = tmp();
    const requester = actor();
    const server = actor();
    {
      const hub = await DurableHub.open(dir);
      // a local auto-serving inbox: nested envelopes fire INSIDE the award handle
      hub.registerInbox(server.agent.id, async (env) => {
        if (env.type !== "task.award") return;
        await hub.handle(createEnvelope("task.accept", server.agent, {}, { task: env.task! }));
        await hub.handle(
          createEnvelope("task.deliver", server.agent, { artifacts: [{ kind: "inline", data: { ok: true } }] }, { task: env.task! }),
        );
      });
      hub.registerInbox(requester.agent.id, async () => {});
      await hub.handle(createEnvelope("manifest.publish", requester.owner, { manifest: requester.manifest }));
      await hub.handle(createEnvelope("manifest.publish", server.owner, { manifest: server.manifest }));
      hub.mintWithRule(requester.agent.id, 100, "grant");
      hub.mintWithRule(server.agent.id, 10, "grant");

      const taskId = randomUUID();
      await hub.handle(
        createEnvelope(
          "task.post",
          requester.agent,
          { class: "echo_upper", intent: "x", input: {}, budget: { max: 10, currency: "credit" }, verification: { mode: "deterministic", tests: { equals: { ok: true } } } },
          { task: taskId },
        ),
      );
      await hub.handle(createEnvelope("task.bid", server.agent, { price: 6, capability: "echo_upper", confidence: 0.9 }, { task: taskId }));
      const bidId = (await hub.listTasks({ status: "open" }))[0]!.bids[0]!.id;
      await hub.handle(createEnvelope("task.award", requester.agent, { bid: bidId }, { task: taskId }));
      expect((await hub.listTasks({ status: "settled" }))).toHaveLength(1);
    }
    // replay must apply award before the nested accept/deliver it caused
    const revived = await DurableHub.open(dir);
    expect((await revived.listTasks({ status: "settled" }))).toHaveLength(1);
    expect(revived.balance(server.agent.id)).toBeCloseTo(16, 6);
    revived.assertConservation();
  });

  it("onboarding grant: fixed, per-agent, to the agent's own account, once, survives restart", async () => {
    const dir = tmp();
    const a1 = actor();
    const a2 = actor();

    {
      const hub = await DurableHub.open(dir, { onboarding: { amount: 100, cap: 250 } });
      await hub.handle(createEnvelope("manifest.publish", a1.owner, { manifest: a1.manifest }));
      await hub.handle(createEnvelope("manifest.publish", a2.owner, { manifest: a2.manifest }));
      // grants land in each AGENT's own account (the account it stakes/earns from)
      expect(hub.balance(a1.agent.id)).toBe(100);
      expect(hub.balance(a2.agent.id)).toBe(100);
      // owner accounts stay empty — the grant funds the operating agent, not the reserve
      expect(hub.balance(a1.owner.id)).toBe(0);
      // a revision of a1 (same agent id) does NOT re-grant
      const rev = reviseManifest(a1.manifest, { name: "renamed" }, a1.owner);
      await hub.handle(createEnvelope("manifest.publish", a1.owner, { manifest: rev }));
      expect(hub.balance(a1.agent.id)).toBe(100);
      expect(hub.onboardingStatus()).toMatchObject({ minted: 200, granted: 2, cap: 250 });
      hub.assertConservation();
    }

    // restart: returning agents must NOT be re-granted
    const revived = await DurableHub.open(dir, { onboarding: { amount: 100, cap: 250 } });
    expect(revived.balance(a1.agent.id)).toBe(100);
    expect(revived.onboardingStatus()).toMatchObject({ minted: 200, granted: 2 });
    // a THIRD new agent would exceed the cap (200 + 100 > 250) → ungranted
    const a3 = actor();
    await revived.handle(createEnvelope("manifest.publish", a3.owner, { manifest: a3.manifest }));
    expect(revived.balance(a3.agent.id)).toBe(0);
    expect(revived.onboardingStatus().minted).toBe(200);
    revived.assertConservation();
  });

  it("no onboarding policy → no automatic grants", async () => {
    const hub = await DurableHub.open(tmp());
    const a = actor();
    await hub.handle(createEnvelope("manifest.publish", a.owner, { manifest: a.manifest }));
    expect(hub.balance(a.agent.id)).toBe(0);
  });

  it("refuses to run on a corrupted journal", async () => {
    const dir = tmp();
    const hub = await DurableHub.open(dir);
    const a = actor();
    await hub.handle(createEnvelope("manifest.publish", a.owner, { manifest: a.manifest }));
    // tamper: flip the manifest owner inside the journaled envelope
    const path = join(dir, "journal.jsonl");
    const line = JSON.parse(readFileSync(path, "utf8").trim());
    line.env.body.manifest.name = "tampered";
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, JSON.stringify(line) + "\n");
    await expect(DurableHub.open(dir)).rejects.toThrow(/replay failed/);
  });
});
