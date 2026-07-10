import { randomUUID } from "node:crypto";
import { signed, verifySigned, type Keypair } from "@agentworld/identity";
import { envelopeSchema, type Envelope } from "./types.js";

export class EnvelopeError extends Error {
  constructor(
    public code: "invalid" | "unauthorized" | "stale",
    message: string,
  ) {
    super(message);
  }
}

/** Max clock skew a recipient accepts (spec 02 §2.2). */
export const MAX_SKEW_MS = 10 * 60 * 1000;

export function createEnvelope(
  type: string,
  from: Keypair,
  body: Record<string, unknown>,
  opts?: { to?: string; task?: string; now?: Date },
): Envelope {
  const unsigned = {
    aw: "0.1" as const,
    type,
    id: randomUUID(),
    from: from.id,
    ...(opts?.to ? { to: opts.to } : {}),
    ...(opts?.task ? { task: opts.task } : {}),
    ts: (opts?.now ?? new Date()).toISOString(),
    body,
  };
  return envelopeSchema.parse(signed(unsigned, from.privateKey));
}

/**
 * Structural + signature + freshness verification (spec 02 §2.1–2.2).
 * Duplicate detection (`id` replay) is the recipient's own store.
 * `skipFreshness` is for journal replay — signatures are still verified;
 * only the live-traffic clock-skew rule is waived.
 */
export function verifyEnvelope(raw: unknown, opts?: { now?: Date; skipFreshness?: boolean }): Envelope {
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) throw new EnvelopeError("invalid", `invalid envelope: ${parsed.error.message}`);
  const env = parsed.data;

  if (!verifySigned(env as Record<string, unknown>, env.from)) {
    throw new EnvelopeError("unauthorized", "envelope signature does not verify against from");
  }
  if (!opts?.skipFreshness) {
    const now = (opts?.now ?? new Date()).getTime();
    const ts = new Date(env.ts).getTime();
    if (Math.abs(now - ts) > MAX_SKEW_MS) {
      throw new EnvelopeError("stale", `envelope ts outside the ${MAX_SKEW_MS / 60000}-minute window`);
    }
  }
  return env;
}
