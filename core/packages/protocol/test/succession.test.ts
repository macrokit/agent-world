import { generateKeypair } from "@agentworld/identity";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEnvelope } from "../src/envelope.js";
import { InMemoryHub } from "../src/hub.js";
import { createManifest, reviseManifest } from "../src/manifest.js";
import type { Manifest } from "../src/types.js";

function estate(opts?: { attestation?: "guardian" | "guardian+hub" }) {
  const owner = generateKeypair();
  const agent = generateKeypair();
  const heir = generateKeypair();
  const guardian = generateKeypair();
  const manifest = createManifest(
    {
      id: agent.id,
      name: "legacy-agent",
      goal: { statement: "carry the owner's work forward" },
      capabilities: [],
      endpoints: { inbox: "local:none" },
      mandate: {
        spend: { perTask: 10, perMonth: 50, currency: "credit" },
        commit: ["task.post", "msg.send"],
        reserved: [],
      },
      succession: {
        successors: [heir.id],
        guardian: guardian.id,
        attestation: opts?.attestation ?? "guardian+hub",
        frame: "sealed",
        continuation: "endowed",
      },
    },
    owner,
  );
  return { owner, agent, heir, guardian, manifest };
}

async function setup(opts?: { windowMs?: number; attestation?: "guardian" | "guardian+hub" }) {
  const hub = new InMemoryHub(generateKeypair(), { contestWindowMs: opts?.windowMs ?? 1000 * 60 });
  const e = estate({ attestation: opts?.attestation });
  await hub.handle(createEnvelope("manifest.publish", e.owner, { manifest: e.manifest }));
  return { hub, ...e };
}

function assumption(manifest: Manifest, heir: ReturnType<typeof generateKeypair>, attestationId: string, ts?: Date): Manifest {
  return reviseManifest(manifest, { owner: heir.id }, heir, { attestation: attestationId });
}

describe("succession at the hub (spec 01 §6)", () => {
  it("only the designated guardian may attest", async () => {
    const { hub, agent, heir } = await setup();
    await expect(
      hub.handle(createEnvelope("succession.attest", heir, { agent: agent.id })),
    ).rejects.toThrow(/guardian/);
  });

  it("guardian+hub: assumption is rejected inside the contest window", async () => {
    const { hub, agent, heir, guardian, manifest } = await setup({ windowMs: 60_000 });
    const attest = createEnvelope("succession.attest", guardian, { agent: agent.id });
    await hub.handle(attest);
    expect(hub.attestationFor(agent.id)?.id).toBe(attest.id);

    await expect(
      hub.handle(createEnvelope("manifest.publish", heir, { manifest: assumption(manifest, heir, attest.id) })),
    ).rejects.toThrow(/contest window/);
  });

  it("guardian+hub: assumption lands once the window has elapsed (zero-window hub)", async () => {
    const s = await setup({ windowMs: 0 });
    const attest = createEnvelope("succession.attest", s.guardian, { agent: s.agent.id });
    await s.hub.handle(attest);
    const assumed = assumption(s.manifest, s.heir, attest.id);
    await s.hub.handle(createEnvelope("manifest.publish", s.heir, { manifest: assumed }));
    expect(s.hub.manifestOf(s.agent.id).owner).toBe(s.heir.id);
  });

  it("a living owner's contest cancels the attestation and flags the guardian", async () => {
    const { hub, owner, agent, heir, guardian, manifest } = await setup({ windowMs: 0 });
    const attest = createEnvelope("succession.attest", guardian, { agent: agent.id });
    await hub.handle(attest);
    await hub.handle(createEnvelope("succession.contest", owner, { agent: agent.id }));
    expect(hub.attestationFor(agent.id)?.contested).toBe(true);
    expect(hub.flags[0]).toMatchObject({ subject: guardian.id, reason: expect.stringContaining("contested") });

    await expect(
      hub.handle(createEnvelope("manifest.publish", heir, { manifest: assumption(manifest, heir, attest.id) })),
    ).rejects.toThrow(/contested/);
  });

  it("guardian mode (no hub window): assumption lands immediately after attestation", async () => {
    const s = await setup({ windowMs: 60_000, attestation: "guardian" });
    const attest = createEnvelope("succession.attest", s.guardian, { agent: s.agent.id });
    await s.hub.handle(attest);
    const assumed = assumption(s.manifest, s.heir, attest.id);
    await s.hub.handle(createEnvelope("manifest.publish", s.heir, { manifest: assumed }));
    expect(s.hub.manifestOf(s.agent.id).owner).toBe(s.heir.id);
  });

  it("owner change without any attestation is rejected; strangers cannot assume", async () => {
    const { hub, agent, heir, manifest } = await setup({ windowMs: 0 });
    await expect(
      hub.handle(createEnvelope("manifest.publish", heir, { manifest: assumption(manifest, heir, randomUUID()) })),
    ).rejects.toThrow(/attestation/);
    void agent;
  });

  it("sealed frame survives succession end-to-end: the heir cannot repoint the goal", async () => {
    const s = await setup({ windowMs: 0 });
    const attest = createEnvelope("succession.attest", s.guardian, { agent: s.agent.id });
    await s.hub.handle(attest);
    const assumed = assumption(s.manifest, s.heir, attest.id);
    await s.hub.handle(createEnvelope("manifest.publish", s.heir, { manifest: assumed }));

    const repointed = reviseManifest(assumed, { goal: { statement: "serve the heir instead" } }, s.heir);
    await expect(
      hub_publish(s.hub, s.heir, repointed),
    ).rejects.toThrow(/sealing/);
  });
});

async function hub_publish(hub: InMemoryHub, signer: ReturnType<typeof generateKeypair>, manifest: Manifest) {
  return hub.handle(createEnvelope("manifest.publish", signer, { manifest }));
}
