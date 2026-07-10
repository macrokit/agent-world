import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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

/** `aw serve` — inbox listener + hub connection; returns the bound URL. */
export async function serve(dir: string, opts: { hub: string; port?: number }): Promise<{ url: string; close(): Promise<void> }> {
  const agent = await loadAgent(dir, { hub: opts.hub });
  const served = await agent.listen(opts.port ?? 7801);
  return served;
}
