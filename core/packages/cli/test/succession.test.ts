import { generateKeypair } from "@agentworld/identity";
import { InMemoryHub, serveHub, type Served } from "@agentworld/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  FILES,
  init,
  keygenToFile,
  loadChain,
  loadKeypair,
  register,
  successionAssume,
  successionAttest,
  successionContest,
  successionPlan,
  successionSeal,
  successionStatus,
  SEAL_WARNING,
} from "../src/lib.js";

const dirs: string[] = [];
const servers: Served[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "aw-succ-"));
  dirs.push(d);
  return d;
}

describe("aw succession", () => {
  it("plan + status: plain language, owner-signed revisions", () => {
    const base = tmp();
    const dir = join(base, "estate");
    init(dir, "estate");
    const heir = keygenToFile(join(base, "heir.key"));
    const guardian = keygenToFile(join(base, "guardian.key"));

    const rev = successionPlan(dir, {
      successors: [heir.id],
      guardian: guardian.id,
      attestation: "guardian+hub",
      frame: "sealed",
      continuation: "endowed",
    });
    expect(rev.seq).toBe(1);
    expect(rev.succession.successors).toEqual([heir.id]);

    const status = successionStatus(dir);
    expect(status).toContain("may attest the owner's death or incapacity");
    expect(status).toContain("heirs operate it but cannot repoint it");
    expect(status).toContain("sustains itself from its earnings");
  });

  it("status warns loudly when no successor is named", () => {
    const dir = join(tmp(), "lonely");
    init(dir, "lonely");
    expect(successionStatus(dir)).toContain("NONE NAMED");
  });

  it("seal enforces the cooling-off acknowledgment, then is permanent", () => {
    const dir = join(tmp(), "sealed");
    init(dir, "sealed");
    expect(() => successionSeal(dir, { acknowledged: false })).toThrow(/PERMANENT/);
    expect(() => successionSeal(dir, { acknowledged: false })).toThrow(SEAL_WARNING.slice(0, 30));

    const rev = successionSeal(dir, { acknowledged: true });
    expect(rev.goal.sealed).toBe(true);
    expect(() => successionSeal(dir, { acknowledged: true })).toThrow(/already sealed/);
  });

  it("the full estate story: plan → attest → assume; owner key replaced; hub accepts", async () => {
    const hub = new InMemoryHub(generateKeypair(), { contestWindowMs: 0 });
    const srv = await serveHub(hub);
    servers.push(srv);

    const base = tmp();
    const dir = join(base, "estate");
    const genesis = init(dir, "estate");
    const heirKeyFile = join(base, "heir.key");
    const heir = keygenToFile(heirKeyFile);
    const guardian = keygenToFile(join(base, "guardian.key"));

    successionPlan(dir, { successors: [heir.id], guardian: guardian.id, continuation: "endowed" });
    await register(dir, srv.url);

    const attestationId = await successionAttest(srv.url, join(base, "guardian.key"), genesis.id);
    const rev = await successionAssume(dir, { successorKeyFile: heirKeyFile, attestation: attestationId, hub: srv.url });

    expect(rev.owner).toBe(heir.id);
    expect(loadChain(dir)).toHaveLength(3);
    expect(loadKeypair(join(dir, FILES.ownerKey)).id).toBe(heir.id); // heir now holds owner authority
    expect(hub.manifestOf(genesis.id).owner).toBe(heir.id); // hub accepted the assumption

    // endowed continuation froze the mandate: the heir cannot loosen it (chain-level)
    const strangerKeyFile = join(base, "stranger.key");
    keygenToFile(strangerKeyFile);
    await expect(
      successionAssume(dir, { successorKeyFile: strangerKeyFile, attestation: attestationId }),
    ).rejects.toThrow(/not a named successor/);
  });

  it("a living owner contests: the assumption is blocked at the hub", async () => {
    const hub = new InMemoryHub(generateKeypair(), { contestWindowMs: 0 });
    const srv = await serveHub(hub);
    servers.push(srv);

    const base = tmp();
    const dir = join(base, "alive");
    const genesis = init(dir, "alive");
    const heirKeyFile = join(base, "heir.key");
    const heir = keygenToFile(heirKeyFile);
    const guardian = keygenToFile(join(base, "guardian.key"));

    successionPlan(dir, { successors: [heir.id], guardian: guardian.id });
    await register(dir, srv.url);

    const attestationId = await successionAttest(srv.url, join(base, "guardian.key"), genesis.id);
    await successionContest(srv.url, dir); // "I am alive."
    expect(hub.flags.some((f) => f.subject === guardian.id)).toBe(true);

    await expect(
      successionAssume(dir, { successorKeyFile: heirKeyFile, attestation: attestationId, hub: srv.url }),
    ).rejects.toThrow(/contested/);

    // the rejected assumption left the local estate untouched
    expect(loadChain(dir)).toHaveLength(2);
    expect(loadKeypair(join(dir, FILES.ownerKey)).id).not.toBe(heir.id);
  });
});
