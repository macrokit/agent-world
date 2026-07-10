import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  generateKeypair,
  keypairFromPem,
  privateKeyToPem,
  type Keypair,
} from "@agentworld/identity";
import {
  createEnvelope,
  createManifest,
  HubClient,
  manifestSchema,
  reviseManifest,
  verifyManifestChain,
  type Manifest,
} from "@agentworld/protocol";
import { createAgent, type Agent, type CapabilityHandler } from "@agentworld/agent";

/** On-disk layout of an agent directory (created by `aw init`). */
export const FILES = {
  manifest: "agent.json",
  chain: "manifest-chain.json",
  ownerKey: "owner.key",
  agentKey: "agent.key",
  handlers: "handlers.mjs",
} as const;

export function keygenToFile(path: string): Keypair {
  const kp = generateKeypair();
  writeFileSync(path, privateKeyToPem(kp.privateKey), { mode: 0o600 });
  return kp;
}

export function loadKeypair(path: string): Keypair {
  return keypairFromPem(readFileSync(path, "utf8"));
}

export function loadChain(dir: string): Manifest[] {
  const chain = JSON.parse(readFileSync(join(dir, FILES.chain), "utf8")) as Manifest[];
  verifyManifestChain(chain);
  return chain;
}

function writeChain(dir: string, chain: Manifest[]): void {
  writeFileSync(join(dir, FILES.chain), JSON.stringify(chain, null, 2) + "\n");
  writeFileSync(join(dir, FILES.manifest), JSON.stringify(chain[chain.length - 1], null, 2) + "\n");
}

const HELLO_HANDLERS = `// Capability handlers for this agent — ANY async function.
// Keys must match capability names declared in agent.json.
export default {
  hello: async (input) => ({ greeting: \`hello, \${input.name ?? "world"}\` }),
};
`;

/** `aw init` — keypairs + a signed genesis manifest + a hello capability. */
export function init(dir: string, name: string, opts?: { inbox?: string }): Manifest {
  if (existsSync(join(dir, FILES.manifest))) throw new Error(`${dir} already contains an agent`);
  mkdirSync(dir, { recursive: true });
  const owner = keygenToFile(join(dir, FILES.ownerKey));
  const agent = keygenToFile(join(dir, FILES.agentKey));

  const manifest = createManifest(
    {
      id: agent.id,
      name,
      goal: { statement: "describe this agent's purpose — edit me, then run `aw sign`" },
      capabilities: [
        {
          name: "hello",
          intent: "greet the caller by name",
          input: { type: "object", properties: { name: { type: "string" } } },
          output: { type: "object", properties: { greeting: { type: "string" } } },
          scopes: [],
          pricing: { ask: 1, currency: "credit" },
          verification: ["requester"],
        },
      ],
      endpoints: { inbox: opts?.inbox ?? "http://127.0.0.1:7801" },
      mandate: {
        spend: { perTask: 10, perMonth: 100, currency: "credit" },
        commit: ["task.post", "task.bid", "task.accept", "task.deliver", "task.verify", "task.cancel", "msg.send"],
        reserved: [],
      },
      succession: { successors: [], frame: "sealed", continuation: "wound-down" },
    },
    owner,
  );

  writeChain(dir, [manifest]);
  writeFileSync(join(dir, FILES.handlers), HELLO_HANDLERS);
  writeFileSync(join(dir, ".gitignore"), "*.key\n");
  return manifest;
}

/**
 * `aw sign` — turn hand-edits of agent.json into a properly signed revision.
 * Reads the edited head, diffs against the verified chain head, appends.
 */
export function sign(dir: string): Manifest {
  const chain = loadChain(dir);
  const head = chain[chain.length - 1]!;
  const editedRaw = JSON.parse(readFileSync(join(dir, FILES.manifest), "utf8")) as Record<string, unknown>;
  const owner = loadKeypair(join(dir, FILES.ownerKey));

  const { spec: _s, id: _i, owner: _o, seq: _q, prev: _p, sig: _g, attestation: _a, ...editable } = editedRaw;
  const revision = reviseManifest(head, editable as Partial<Manifest>, owner);
  if (revision.prev === null) throw new Error("unreachable");
  manifestSchema.parse(revision);
  const next = [...chain, revision];
  verifyManifestChain(next);
  writeChain(dir, next);
  return revision;
}

/** `aw verify` — verify the chain and that agent.json matches its head. */
export function verify(dir: string): Manifest {
  const chain = loadChain(dir);
  const head = chain[chain.length - 1]!;
  const current = JSON.parse(readFileSync(join(dir, FILES.manifest), "utf8")) as Manifest;
  if (JSON.stringify(current) !== JSON.stringify(head)) {
    throw new Error("agent.json differs from the chain head — run `aw sign` to commit the edits");
  }
  return head;
}

/** `aw export` — the portability archive (spec 01 §7). Keys are NOT included. */
export function exportArchive(dir: string, outFile: string): void {
  const chain = loadChain(dir);
  const archive = {
    format: "aw-export/0.1",
    exportedAt: new Date().toISOString(),
    manifestChain: chain,
    note: "keys are exported only by explicit owner action; copy owner.key/agent.key yourself if that is what you intend",
  };
  writeFileSync(outFile, JSON.stringify(archive, null, 2) + "\n");
}

/** Load an agent dir into a connected, handler-attached Agent. */
export async function loadAgent(dir: string, opts?: { hub?: string; withOwner?: boolean }): Promise<Agent> {
  const chain = loadChain(dir);
  const manifest = chain[chain.length - 1]!;
  const key = loadKeypair(join(dir, FILES.agentKey));
  const ownerKey = opts?.withOwner ? loadKeypair(join(dir, FILES.ownerKey)) : undefined;
  const agent = createAgent({ manifest, key, ownerKey });

  const handlersPath = join(dir, FILES.handlers);
  if (existsSync(handlersPath)) {
    const mod = (await import(`file://${handlersPath}`)) as { default?: Record<string, CapabilityHandler> };
    for (const [name, fn] of Object.entries(mod.default ?? {})) {
      agent.capability(name, fn);
    }
  }
  if (opts?.hub) agent.connect(new HubClient(opts.hub));
  return agent;
}

/** `aw register` — publish the manifest chain head to a hub (owner-signed). */
export async function register(dir: string, hubUrl: string): Promise<void> {
  const chain = loadChain(dir);
  const owner = loadKeypair(join(dir, FILES.ownerKey));
  const hub = new HubClient(hubUrl);
  // publish any revisions the hub does not have yet, oldest first
  for (const manifest of chain) {
    try {
      await hub.send(
        createEnvelope("manifest.publish", owner, { manifest: manifest as unknown as Record<string, unknown> }),
      );
    } catch (e) {
      // an already-known revision is fine (duplicate/rejected); newer ones must land
      if (manifest === chain[chain.length - 1]) throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// succession — the lifecycle that carries the agent past its person (spec 01 §6)
// ---------------------------------------------------------------------------

export interface SuccessionPlanOpts {
  successors?: string[];
  guardian?: string;
  attestation?: "guardian" | "guardian+hub";
  frame?: "sealed" | "transferable";
  continuation?: "endowed" | "transferred" | "wound-down";
}

/** `aw succession plan` — an owner-signed revision of the succession block. */
export function successionPlan(dir: string, opts: SuccessionPlanOpts): Manifest {
  const chain = loadChain(dir);
  const head = chain[chain.length - 1]!;
  const owner = loadKeypair(join(dir, FILES.ownerKey));
  const revision = reviseManifest(
    head,
    {
      succession: {
        ...head.succession,
        ...(opts.successors ? { successors: opts.successors } : {}),
        ...(opts.guardian ? { guardian: opts.guardian } : {}),
        ...(opts.attestation ? { attestation: opts.attestation } : {}),
        ...(opts.frame ? { frame: opts.frame } : {}),
        ...(opts.continuation ? { continuation: opts.continuation } : {}),
      },
    },
    owner,
  );
  const next = [...chain, revision];
  verifyManifestChain(next);
  writeChain(dir, next);
  return revision;
}

export const SEAL_WARNING = `Sealing is PERMANENT and cannot be undone — not by you, not by your heirs.

From this revision on, no key — including your own — can change what this
agent values. Its goal statement becomes the fixed frame it will serve for
as long as it runs, possibly long after you. Heirs will be able to operate
it, but never to repoint it.

Take a day. Read the goal statement in agent.json out loud. If it still
says exactly what you mean, run this command again with --i-have-reviewed.`;

/** `aw succession seal` — seals the goal frame NOW. Cooling-off enforced (spec 08 fiduciary floor). */
export function successionSeal(dir: string, opts: { acknowledged: boolean }): Manifest {
  if (!opts.acknowledged) throw new Error(SEAL_WARNING);
  const chain = loadChain(dir);
  const head = chain[chain.length - 1]!;
  if (head.goal.sealed === true) throw new Error("the goal frame is already sealed");
  const owner = loadKeypair(join(dir, FILES.ownerKey));
  const revision = reviseManifest(head, { goal: { ...head.goal, sealed: true } }, owner);
  const next = [...chain, revision];
  verifyManifestChain(next);
  writeChain(dir, next);
  return revision;
}

/** `aw succession status` — the plan, in plain language (spec 08: no jargon at the estate boundary). */
export function successionStatus(dir: string): string {
  const chain = loadChain(dir);
  const head = chain[chain.length - 1]!;
  const s = head.succession;
  const lines = [
    `${head.name} (${head.id})`,
    `  owner: ${head.owner}`,
    s.successors.length
      ? `  successors: ${s.successors.join(", ")} — may take over the owner key after a valid attestation`
      : `  successors: NONE NAMED — if the owner is gone, no one can ever operate this agent`,
    s.guardian
      ? `  guardian: ${s.guardian} — may attest the owner's death or incapacity`
      : `  guardian: none — succession cannot begin without one`,
    `  attestation: ${s.attestation ?? "guardian+hub"}` +
      ((s.attestation ?? "guardian+hub") === "guardian+hub"
        ? " — the hub enforces a public contest window; the owner can cancel any attestation while alive"
        : " — the guardian's word alone starts succession"),
    `  frame: ${s.frame ?? "sealed"}` +
      ((s.frame ?? "sealed") === "sealed"
        ? " — at succession, what this agent values becomes permanent; heirs operate it but cannot repoint it"
        : " — the heir takes full ownership and may change the agent's goal"),
    `  continuation: ${s.continuation}` +
      (s.continuation === "endowed"
        ? " — the agent sustains itself from its earnings; heirs may only rotate keys or wind it down"
        : s.continuation === "transferred"
          ? " — the heir becomes the new principal"
          : " — the agent settles its obligations and retires"),
    `  goal sealed now: ${head.goal.sealed === true ? "YES — permanent" : "no (seals at succession per frame above)"}`,
  ];
  return lines.join("\n");
}

/** `aw succession attest` — the guardian attests; returns the attestation envelope id. */
export async function successionAttest(hubUrl: string, guardianKeyFile: string, agentId: string): Promise<string> {
  const guardian = loadKeypair(guardianKeyFile);
  const hub = new HubClient(hubUrl);
  const env = createEnvelope("succession.attest", guardian, { agent: agentId });
  await hub.send(env);
  return env.id;
}

/** `aw succession contest` — the living owner cancels an attestation. */
export async function successionContest(hubUrl: string, dir: string): Promise<void> {
  const chain = loadChain(dir);
  const owner = loadKeypair(join(dir, FILES.ownerKey));
  await new HubClient(hubUrl).send(
    createEnvelope("succession.contest", owner, { agent: chain[chain.length - 1]!.id }),
  );
}

/**
 * `aw succession assume` — a named successor takes owner authority: appends
 * the succession revision (signed by the successor, referencing the
 * attestation), replaces owner.key, and publishes to the hub, which enforces
 * the contest window.
 */
export async function successionAssume(
  dir: string,
  opts: { successorKeyFile: string; attestation: string; hub?: string },
): Promise<Manifest> {
  const chain = loadChain(dir);
  const head = chain[chain.length - 1]!;
  const successor = loadKeypair(opts.successorKeyFile);
  if (!head.succession.successors.includes(successor.id)) {
    throw new Error("this key is not a named successor of the agent");
  }
  const revision = reviseManifest(head, { owner: successor.id }, successor, { attestation: opts.attestation });
  const next = [...chain, revision];
  verifyManifestChain(next);
  // publish FIRST: if the hub rejects (contested attestation, open contest
  // window), the local estate directory stays untouched.
  if (opts.hub) {
    await new HubClient(opts.hub).send(
      createEnvelope("manifest.publish", successor, { manifest: revision as unknown as Record<string, unknown> }),
    );
  }
  writeChain(dir, next);
  copyFileSync(opts.successorKeyFile, join(dir, FILES.ownerKey));
  return revision;
}

/** `aw serve` — inbox listener + hub connection; returns the bound URL. */
export async function serve(dir: string, opts: { hub: string; port?: number }): Promise<{ url: string; close(): Promise<void> }> {
  const agent = await loadAgent(dir, { hub: opts.hub });
  const served = await agent.listen(opts.port ?? 7801);
  return served;
}
