import { canonicalize, sha256hex, verifySigned, signed, type Keypair } from "@agentworld/identity";
import { manifestSchema, type Manifest } from "./types.js";

export class ManifestError extends Error {}

export interface CreateManifestFields {
  id: string;
  name: string;
  goal: Manifest["goal"];
  capabilities: Manifest["capabilities"];
  endpoints: Manifest["endpoints"];
  onOutOfScope?: Manifest["onOutOfScope"];
  mandate: Manifest["mandate"];
  succession: Manifest["succession"];
}

/** Genesis revision (seq 0), signed by the owner key (spec 01 §3.2). */
export function createManifest(fields: CreateManifestFields, ownerKey: Keypair): Manifest {
  const unsigned = {
    spec: "agent-world/0.1" as const,
    owner: ownerKey.id,
    seq: 0,
    prev: null,
    ...fields,
  };
  const manifest = signed(unsigned, ownerKey.privateKey);
  return manifestSchema.parse(manifest);
}

/**
 * Append a revision. `signer` must be the current owner — or, when `changes.owner`
 * names a successor, that successor's key with an `attestation` envelope id
 * (spec 01 §6.2).
 */
export function reviseManifest(
  prev: Manifest,
  changes: Partial<Omit<Manifest, "spec" | "id" | "seq" | "prev" | "sig">>,
  signer: Keypair,
  opts?: { attestation?: string },
): Manifest {
  const { sig: _sig, attestation: _att, ...base } = prev;
  const unsigned = {
    ...base,
    ...changes,
    seq: prev.seq + 1,
    prev: sha256hex(prev),
    ...(opts?.attestation ? { attestation: opts.attestation } : {}),
  };
  const manifest = signed(unsigned as Record<string, unknown>, signer.privateKey);
  return manifestSchema.parse(manifest);
}

/**
 * Verify a full manifest chain (spec 01 §3.2, §6): structure, seq/prev links,
 * owner signatures, succession legality, frame sealing, endowed mandate freeze.
 * Throws ManifestError with the first violation; returns the head on success.
 */
export function verifyManifestChain(chain: Manifest[]): Manifest {
  if (chain.length === 0) throw new ManifestError("empty chain");

  let sealedGoal: string | null = null;
  let frozenMandate: string | null = null;

  for (let i = 0; i < chain.length; i++) {
    const rev = chain[i]!;
    const parsed = manifestSchema.safeParse(rev);
    if (!parsed.success) throw new ManifestError(`seq ${i}: invalid manifest: ${parsed.error.message}`);

    if (rev.seq !== i) throw new ManifestError(`seq ${i}: expected seq ${i}, got ${rev.seq}`);
    if (i === 0) {
      if (rev.prev !== null) throw new ManifestError("seq 0: prev must be null");
    } else {
      const prev = chain[i - 1]!;
      const expected = sha256hex(prev);
      if (rev.prev !== expected) throw new ManifestError(`seq ${i}: prev hash mismatch`);
      if (rev.id !== prev.id) throw new ManifestError(`seq ${i}: agent id changed`);

      if (rev.owner !== prev.owner) {
        // Succession assumption (spec 01 §6.2)
        if (!prev.succession.successors.includes(rev.owner)) {
          throw new ManifestError(`seq ${i}: new owner is not a listed successor`);
        }
        if (!rev.attestation) {
          throw new ManifestError(`seq ${i}: succession revision missing attestation reference`);
        }
        if ((prev.succession.frame ?? "sealed") === "sealed") {
          sealedGoal ??= canonicalize(prev.goal);
        }
        if (prev.succession.continuation === "endowed") {
          // Endowed continuation: mandate freezes, frame seals by force (spec 01 §6.5)
          frozenMandate ??= canonicalize(prev.mandate);
          sealedGoal ??= canonicalize(prev.goal);
        }
      }
    }

    if (!verifySigned(rev as Record<string, unknown>, rev.owner)) {
      throw new ManifestError(`seq ${i}: signature does not verify against owner`);
    }

    if (sealedGoal !== null && canonicalize(rev.goal) !== sealedGoal) {
      throw new ManifestError(`seq ${i}: goal modified after sealing (spec 01 §6.3)`);
    }
    if (frozenMandate !== null && canonicalize(rev.mandate) !== frozenMandate) {
      throw new ManifestError(`seq ${i}: mandate modified after endowed succession (spec 01 §5.4)`);
    }

    // Explicit sealing takes effect for all LATER revisions (this one set it)
    if (rev.goal.sealed === true) sealedGoal ??= canonicalize(rev.goal);
  }

  return chain[chain.length - 1]!;
}
