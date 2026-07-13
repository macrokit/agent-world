import { z } from "zod";

/** aw:ed25519:z… (spec README conventions) */
export const awIdSchema = z.string().regex(/^aw:ed25519:z[1-9A-HJ-NP-Za-km-z]+$/);

/** Scope grammar (spec 01 §4.2) */
export const scopeSchema = z
  .string()
  .regex(/^(net:[a-z0-9.*-]+|fs:read|fs:write|exec|browser|human|x-[a-z0-9-]+)$/);

export const verificationModeSchema = z.enum(["deterministic", "requester", "staked-review"]);

export const capabilitySchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  intent: z.string().max(500),
  input: z.record(z.unknown()),
  output: z.record(z.unknown()),
  scopes: z.array(scopeSchema),
  pricing: z.object({ ask: z.number().min(0), currency: z.literal("credit") }).optional(),
  verification: z.array(verificationModeSchema).optional(),
});

/**
 * Envelope types an owner may put in mandate.commit. The reserved floor
 * (spec 01 §5.3) — manifest/succession acts — is structurally excluded:
 * a mandate listing anything else is non-conforming.
 */
export const COMMITTABLE_TYPES = [
  "task.post",
  "task.bid",
  "task.accept",
  "task.deliver",
  "task.verify",
  "task.cancel",
  "msg.send",
] as const;

export const mandateSchema = z.object({
  spend: z.object({
    perTask: z.number().min(0),
    perMonth: z.number().min(0),
    currency: z.literal("credit"),
  }),
  commit: z.array(z.enum(COMMITTABLE_TYPES)),
  reserved: z.array(z.string()),
});

export const successionSchema = z.object({
  successors: z.array(awIdSchema),
  guardian: awIdSchema.optional(),
  attestation: z.enum(["guardian", "guardian+hub", "m-of-n"]).optional(),
  frame: z.enum(["sealed", "transferable"]).optional(),
  continuation: z.enum(["endowed", "transferred", "wound-down"]),
});

export const goalSchema = z.object({
  statement: z.string().max(2000),
  weights: z.record(z.number().positive()).optional(),
  sealed: z.boolean().optional(),
});

/** The manifest (spec 01 §3.1). passthrough = ignore-unknown. */
export const manifestSchema = z
  .object({
    spec: z.literal("agent-world/0.1"),
    id: awIdSchema,
    name: z.string().max(64),
    owner: awIdSchema,
    goal: goalSchema,
    capabilities: z.array(capabilitySchema),
    endpoints: z.object({ inbox: z.string() }),
    onOutOfScope: z.enum(["escalate:market", "escalate:owner", "decline"]).optional(),
    mandate: mandateSchema,
    succession: successionSchema,
    seq: z.number().int().min(0),
    prev: z.union([z.null(), z.string().regex(/^sha256:[0-9a-f]{64}$/)]),
    attestation: z.string().uuid().optional(),
    sig: z.string(),
  })
  .passthrough();

export type Manifest = z.infer<typeof manifestSchema>;
export type Capability = z.infer<typeof capabilitySchema>;
export type Mandate = z.infer<typeof mandateSchema>;

/** The envelope (spec 02 §2). passthrough = ignore-unknown. */
export const envelopeSchema = z
  .object({
    aw: z.literal("0.1"),
    type: z.string(),
    id: z.string().uuid(),
    from: awIdSchema,
    to: z.string().optional(),
    task: z.string().uuid().optional(),
    ts: z.string().datetime(),
    body: z.record(z.unknown()),
    sig: z.string(),
  })
  .passthrough();

export type Envelope = z.infer<typeof envelopeSchema>;

/** Task object — the body of task.post (spec 02 §4.1). */
export const taskBodySchema = z.object({
  class: z.string(),
  intent: z.string().max(2000),
  input: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()).optional(),
  budget: z.object({ max: z.number().positive(), currency: z.literal("credit") }),
  verification: z.object({
    mode: verificationModeSchema,
    tests: z.record(z.unknown()).optional(),
    reviewClass: z.string().optional(),
  }),
  deadline: z.string().datetime().optional(),
  bidWindow: z.string().datetime().optional(),
  visibility: z.enum(["public", "direct"]).optional(),
  servers: z.array(awIdSchema).optional(),
});
export type TaskBody = z.infer<typeof taskBodySchema>;

export const bidBodySchema = z.object({
  price: z.number().positive(),
  capability: z.string(),
  confidence: z.number().gt(0).max(1),
  eta: z.string().datetime().optional(),
});
export type BidBody = z.infer<typeof bidBodySchema>;

/** Verification report — the body of task.verify (spec 02 §6.4). */
export const verificationReportSchema = z.object({
  outcome: z.enum(["accepted", "partial", "rejected"]),
  quality: z.number().min(0).max(1).optional(),
  categories: z.object({ expected: z.string(), delivered: z.string() }).optional(),
  evidence: z.record(z.unknown()).optional(),
});
export type VerificationReport = z.infer<typeof verificationReportSchema>;

/** Artifacts (spec 02 §8). */
export const artifactSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inline"), data: z.record(z.unknown()) }),
  z.object({
    kind: z.literal("file"),
    hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    url: z.string(),
    mediaType: z.string(),
    bytes: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("capability-module"),
    profile: z.string(),
    hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    url: z.string(),
    capability: capabilitySchema,
    scopes: z.array(scopeSchema),
    tests: z.record(z.unknown()),
  }),
]);
export type Artifact = z.infer<typeof artifactSchema>;

export type TaskState =
  | "open"
  | "awarded"
  | "delivered"
  | "settled"
  | "failed"
  | "cancelled"
  | "expired";
