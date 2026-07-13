import { generateKeypair } from "@agentworld/identity";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reviseManifest, verifyManifestChain } from "../src/manifest.js";
import { makeActor } from "./helpers.js";

describe("manifest chain (spec 01 §3, §6)", () => {
  it("creates, revises, and verifies a chain", () => {
    const { owner, manifest } = makeActor();
    const rev1 = reviseManifest(manifest, { name: "renamed" }, owner);
    const head = verifyManifestChain([manifest, rev1]);
    expect(head.name).toBe("renamed");
    expect(head.seq).toBe(1);
  });

  it("rejects a tampered revision and a broken prev link", () => {
    const { owner, manifest } = makeActor();
    const rev1 = reviseManifest(manifest, { name: "renamed" }, owner);
    expect(() => verifyManifestChain([manifest, { ...rev1, name: "hacked" }])).toThrow(/signature/);
    const rev1b = reviseManifest(manifest, {}, owner);
    expect(() =>
      verifyManifestChain([manifest, { ...rev1b, prev: "sha256:" + "0".repeat(64), sig: rev1b.sig }]),
    ).toThrow();
  });

  it("rejects manifests signed by the agent key (owner-signed, always)", () => {
    const { agent, manifest } = makeActor();
    expect(() => verifyManifestChain([reviseManifest(manifest, {}, agent)])).toThrow();
  });

  it("succession: only a listed successor with an attestation may assume ownership", () => {
    const heir = generateKeypair();
    const stranger = generateKeypair();
    const { manifest } = makeActor({ successors: [heir.id] });

    const assumed = reviseManifest(manifest, { owner: heir.id }, heir, { attestation: randomUUID() });
    expect(verifyManifestChain([manifest, assumed]).owner).toBe(heir.id);

    expect(() => verifyManifestChain([manifest, reviseManifest(manifest, { owner: stranger.id }, stranger, { attestation: randomUUID() })])).toThrow(/successor/);
    expect(() => verifyManifestChain([manifest, reviseManifest(manifest, { owner: heir.id }, heir)])).toThrow(/attestation/);
  });

  it("sealed frame: goal is immutable after succession (spec 01 §6.3)", () => {
    const heir = generateKeypair();
    const { manifest } = makeActor({ successors: [heir.id], frame: "sealed" });
    const assumed = reviseManifest(manifest, { owner: heir.id }, heir, { attestation: randomUUID() });
    const repointed = reviseManifest(assumed, { goal: { statement: "serve the heir instead" } }, heir);
    expect(() => verifyManifestChain([manifest, assumed, repointed])).toThrow(/sealing/);
    // non-goal changes remain legal
    const renamed = reviseManifest(assumed, { name: "after" }, heir);
    expect(verifyManifestChain([manifest, assumed, renamed]).name).toBe("after");
  });

  it("explicit goal.sealed makes the goal immutable even before succession", () => {
    const { owner, manifest } = makeActor();
    const sealedRev = reviseManifest(manifest, { goal: { ...manifest.goal, sealed: true } }, owner);
    const repointed = reviseManifest(sealedRev, { goal: { statement: "changed", sealed: true } }, owner);
    expect(() => verifyManifestChain([manifest, sealedRev, repointed])).toThrow(/sealing/);
  });

  it("onOutOfScope: declared route rides the chain; unknown routes are rejected (spec 01 §4.4)", () => {
    const { owner, manifest } = makeActor();
    expect(manifest.onOutOfScope).toBeUndefined();
    const declared = reviseManifest(manifest, { onOutOfScope: "escalate:market" }, owner);
    expect(verifyManifestChain([manifest, declared]).onOutOfScope).toBe("escalate:market");
    expect(() => reviseManifest(declared, { onOutOfScope: "escalate:mars" as never }, owner)).toThrow();
  });

  it("endowed continuation freezes the mandate (spec 01 §5.4)", () => {
    const heir = generateKeypair();
    const { manifest } = makeActor({ successors: [heir.id], continuation: "endowed" });
    const assumed = reviseManifest(manifest, { owner: heir.id }, heir, { attestation: randomUUID() });
    const loosened = reviseManifest(
      assumed,
      { mandate: { ...manifest.mandate, spend: { ...manifest.mandate.spend, perTask: 10_000 } } },
      heir,
    );
    expect(() => verifyManifestChain([manifest, assumed, loosened])).toThrow(/mandate/);
  });
});
