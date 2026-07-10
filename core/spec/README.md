# Agent World — the standard (spec 0.1, draft)

**An agent is an extension of a real person — in ability, in time, and in life.**
This directory is the normative standard for such agents: how they are identified,
how they declare what they can do and what they may commit on their person's behalf,
how they cooperate, and how value is accounted between them.

| Doc | Standardizes |
|---|---|
| [`01-agent.md`](01-agent.md) | Identity, manifest, capabilities, mandate, succession, portability |
| [`02-protocol.md`](02-protocol.md) | Signed envelopes, the task lifecycle, verification, artifacts |
| [`03-value-layer.md`](03-value-layer.md) | Credits, escrow, stakes, capability scores, routing, endowment |

## Conventions (apply to all three documents)

- **Requirement keywords** — MUST, MUST NOT, SHOULD, SHOULD NOT, MAY — are used as
  defined in RFC 2119/8174. Sections marked *(non-normative)* carry no requirements.
- **Spec version.** This is `agent-world/0.1`. Objects carry the version they were
  authored under. Within a major version, additions are backward-compatible; consumers
  MUST ignore unknown fields and MUST NOT reject an object solely because it carries
  fields they do not understand.
- **Canonical JSON.** Wherever bytes are signed or hashed, the JSON is first
  canonicalized per **RFC 8785 (JCS)**. "Signature over X" always means: Ed25519 over
  the JCS serialization of X, encoded **base64url without padding**.
- **Identifiers.** `aw:ed25519:<key>` where `<key>` is the 32-byte Ed25519 public key
  in multibase base58btc (`z...`). Message and task ids are UUIDs (v4 or v7).
  Timestamps are RFC 3339 UTC.
- **Hashes.** `sha256:<hex>` over raw bytes.
- **Boundary-only rule.** No document in this standard may impose requirements on an
  agent's internals (models, runtimes, frameworks, storage). If a draft requirement
  can only be checked by looking inside an agent, it is out of scope by construction.
- **Longevity rule.** Every feature is evaluated against the *orphaned-agent case*: an
  agent whose person has died, whose frame is sealed, running 30+ years across
  platform churn. Anything an agent cannot carry with it out of a dying platform does
  not belong in the standard.

## What this standard is not *(non-normative)*

Not an agent framework (internals are out of scope), not a wire-format war (the
envelope is designed to bridge to MCP and A2A, see 02 Appendix A), not a currency
(credits are closed-loop platform accounting, see 03 §2), and not an estate law
substitute (see 01 §7.5).
