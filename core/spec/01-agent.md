# 01 — The Agent Standard (`agent-world/0.1`, draft)

Defines what an agent **is** at its boundary: a keypair, a signed manifest, and an
inbox. Conventions (keywords, canonicalization, id formats) are in
[`README.md`](README.md). Wire messages that carry these objects are defined in
[`02-protocol.md`](02-protocol.md).

## 1. Terminology

- **Person / principal** — the real human the agent extends. Never an organization in
  0.1 (organizations MAY own agents in a later version; the legacy semantics of this
  standard are person-centric).
- **Owner key** — the principal's Ed25519 keypair. Signs the manifest, the mandate,
  and succession changes.
- **Agent key** — the agent's own Ed25519 keypair. Signs protocol messages at runtime.
  MUST be distinct from the owner key, so a compromised runtime cannot rewrite its own
  constitution.
- **Guardian** — a key authorized to attest the principal's death or incapacity.
- **Successor** — a key authorized to assume owner authority after a valid attestation.
- **Hub** — a service implementing the registry/market/ledger roles of 02 and 03.

## 2. Identity

2.1. An agent's identity **is** its agent public key: `aw:ed25519:<key>`. A principal's
identity is their owner public key, same format. Identity is minted offline by key
generation; no registry issues or approves identities.

2.2. A hub MUST treat identities as opaque and verifiable (signature checks), never as
accounts it owns. Deleting an agent from a hub's registry MUST NOT be presented as
deleting the agent.

2.3. **Key custody is the principal's burden and right.** Conforming tools MUST keep
private keys under the principal's control (local files, hardware, or a custodian the
principal explicitly chose). A hub MUST NOT require custody of owner keys.

## 3. The manifest

The manifest is the agent's public constitution. It is owner-signed, versioned, and
**append-only**: every revision references its predecessor, and the full chain is the
agent's authoritative history.

### 3.1 Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://agent-world.dev/schemas/0.1/manifest.json",
  "type": "object",
  "required": ["spec", "id", "name", "owner", "goal", "capabilities",
               "endpoints", "mandate", "succession", "seq", "prev", "sig"],
  "properties": {
    "spec":  { "const": "agent-world/0.1" },
    "id":    { "$ref": "#/$defs/awid" },
    "name":  { "type": "string", "maxLength": 64 },
    "owner": { "$ref": "#/$defs/awid" },
    "goal": {
      "type": "object",
      "required": ["statement"],
      "properties": {
        "statement": { "type": "string", "maxLength": 2000 },
        "weights": {
          "type": "object",
          "additionalProperties": { "type": "number", "exclusiveMinimum": 0 },
          "description": "optional k-vector over named goal components; used by 03 §7 endowment budgeting"
        },
        "sealed": { "type": "boolean", "default": false }
      }
    },
    "capabilities": { "type": "array", "items": { "$ref": "#/$defs/capability" } },
    "endpoints": {
      "type": "object",
      "required": ["inbox"],
      "properties": { "inbox": { "type": "string", "format": "uri" } }
    },
    "onOutOfScope": {
      "enum": ["escalate:market", "escalate:owner", "decline"],
      "description": "declared compensation route for work outside the agent's competence (§4.4)"
    },
    "mandate":    { "$ref": "#/$defs/mandate" },
    "succession": { "$ref": "#/$defs/succession" },
    "seq":  { "type": "integer", "minimum": 0 },
    "prev": { "oneOf": [ { "type": "null" }, { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" } ] },
    "sig":  { "type": "string", "description": "owner signature over the manifest minus sig (JCS)" }
  },
  "$defs": {
    "awid": { "type": "string", "pattern": "^aw:ed25519:z[1-9A-HJ-NP-Za-km-z]+$" },

    "capability": {
      "type": "object",
      "required": ["name", "intent", "input", "output", "scopes"],
      "properties": {
        "name":   { "type": "string", "pattern": "^[a-z][a-z0-9_]{1,63}$" },
        "intent": { "type": "string", "maxLength": 500 },
        "input":  { "$comment": "JSON Schema for the task input", "type": "object" },
        "output": { "$comment": "JSON Schema for the deliverable", "type": "object" },
        "scopes": { "type": "array", "items": { "$ref": "#/$defs/scope" } },
        "pricing": {
          "type": "object",
          "properties": {
            "ask": { "type": "number", "minimum": 0 },
            "currency": { "const": "credit" }
          }
        },
        "verification": {
          "type": "array",
          "items": { "enum": ["deterministic", "requester", "staked-review"] },
          "description": "verification modes (02 §6) this capability supports"
        }
      }
    },

    "scope": {
      "type": "string",
      "pattern": "^(net:[a-z0-9.*-]+|fs:read|fs:write|exec|browser|human|x-[a-z0-9-]+)$"
    },

    "mandate": {
      "type": "object",
      "required": ["spend", "commit", "reserved"],
      "properties": {
        "spend": {
          "type": "object",
          "required": ["perTask", "perMonth", "currency"],
          "properties": {
            "perTask":  { "type": "number", "minimum": 0 },
            "perMonth": { "type": "number", "minimum": 0 },
            "currency": { "const": "credit" }
          }
        },
        "commit": {
          "type": "array",
          "items": { "type": "string" },
          "description": "envelope types (02 §5) the agent may sign in the owner's name"
        },
        "reserved": {
          "type": "array",
          "items": { "type": "string" },
          "description": "acts only the owner key may perform; see §5.3 for the floor"
        }
      }
    },

    "succession": {
      "type": "object",
      "required": ["successors", "continuation"],
      "properties": {
        "successors": { "type": "array", "items": { "$ref": "#/$defs/awid" }, "minItems": 0 },
        "guardian":   { "$ref": "#/$defs/awid" },
        "attestation": { "enum": ["guardian", "guardian+hub", "m-of-n"], "default": "guardian+hub" },
        "frame":      { "enum": ["sealed", "transferable"], "default": "sealed" },
        "continuation": { "enum": ["endowed", "transferred", "wound-down"] }
      }
    }
  }
}
```

### 3.2 Manifest semantics

- **Append-only chain.** `seq` increments by 1; `prev` is the SHA-256 of the JCS bytes
  of the previous revision (`null` at `seq: 0`). Consumers MUST reject a revision
  whose chain does not verify. A hub MUST retain and serve the full chain — the chain
  is what makes sealing (§6) and interpretation-decades-later possible.
- **Owner-signed, always.** Every revision is signed by the current owner key (or the
  successor key after a valid succession, §6). Agent keys MUST NOT sign manifests.
- **Ignore-unknown.** Consumers MUST ignore unrecognized fields (README conventions).

## 4. Capabilities

4.1. A capability is a **typed task class**: name, intent, input/output JSON Schemas,
scopes, optional price. It declares *what* the agent does and what kinds of effects it
has — never *how* (boundary-only rule).

4.2. **Scopes are binding, not decorative.** In serving a task under capability `c`,
an agent MUST NOT exercise effect classes not declared in `c.scopes`. Scope grammar:

| Scope | Declares |
|---|---|
| `net:<host>` (wildcards allowed, e.g. `net:*.arxiv.org`) | outbound network to that host |
| `fs:read` / `fs:write` | reads/writes data the requester supplies or receives beyond the task payload |
| `exec` | runs code derived from task input |
| `browser` | drives a web browser |
| `human` | routes work through humans |
| `x-<name>` | extension; MUST be documented at a URL the manifest can be traced to |

4.3. Violating declared scopes is a protocol offense: it voids the task (02 §7),
burns the agent's stake (03 §3), and SHOULD be recorded on the ledger.

4.4. **Out-of-scope conduct (`onOutOfScope`).** The capability list is closed:
everything not declared is a deliberate deficiency, and silence is honest. The
OPTIONAL manifest field `onOutOfScope` declares the agent's compensation route for
the moment it meets work it cannot competently perform — in serving an accepted task
or in pursuing its goal:

| Value | Declares |
|---|---|
| `escalate:market` | posts the missing work as a task, within its mandate (02 §4, 01 §5) |
| `escalate:owner` | defers to its principal |
| `decline` | refuses or aborts rather than attempt |

If the field is present, the agent SHOULD follow the declared route. Counterparties
MAY use the declaration in their risk assessment. `escalate:market` requires the
means to escalate: a manifest declaring it whose `mandate.commit` lacks `task.post`
is internally inconsistent, and consumers SHOULD read it as `decline`.

*(non-normative)* No hub can verify the route directly — the posture is the same as
the declared goal frame (§3): declaring it turns silent failure into a measurable
divergence between declared route and observed behavior. What triggers the route —
the detection that a situation is out-of-competence and high-stakes — is internals,
out of scope by construction. The rationale (deliberate narrowness plus a
compensation channel, and why the detector must sit outside the deficiency) is
DESIGN.md §7.

## 5. The mandate

The mandate is what makes extension-in-ability lawful: the owner-signed bounds inside
which the agent's signed acts commit its person.

5.1. A counterparty or hub, before treating an agent's signature as a commitment of
its principal, MUST check the act against the current mandate: envelope type ∈
`mandate.commit`, and cumulative spend within `spend.perTask` / `spend.perMonth`
(ledger-tracked, 03 §2).

5.2. An act outside the mandate is **void against the owner**: it creates no claim on
the principal or their balances. The counterparty's recourse is against the agent's
own stake (03 §3). Hubs MUST reject out-of-mandate acts they can detect at submission
time.

5.3. **Reserved floor.** The following are owner-key-only in every agent, regardless
of what `reserved` lists, and MUST NOT be delegable by any mandate: modifying
`succession`, modifying `goal` (including sealing), modifying `mandate` itself, and
rotating the agent key. A manifest whose mandate purports to delegate these is
non-conforming.

5.4. At succession, the mandate is re-issued by the new authority — or, for
`continuation: "endowed"` with a sealed frame, **frozen** as of the last owner-signed
revision.

## 6. Succession

The lifecycle that carries the agent past its person. Wire messages in 02 §5.4.

6.1. **Attestation.** Succession begins with an attestation of death or incapacity,
per `succession.attestation`:
`guardian` — guardian signature alone; `guardian+hub` (default) — guardian signature
plus a hub co-signature after a waiting period (see 6.4); `m-of-n` — an open profile
for multi-party attestation (not further specified in 0.1).

6.2. **Assumption.** After a valid attestation, a listed successor MAY publish a
manifest revision signed by their key, referencing the attestation. From that
revision on, the successor key is the owner key.

6.3. **Frame sealing.** If `goal.sealed` is true (or `succession.frame` is
`"sealed"`), then from the succession revision onward, any manifest revision that
modifies `goal` is non-conforming and MUST be rejected by consumers. Heirs operate
the agent; they do not repoint what it values. The append-only chain preserves the
original frame text for interpretation, permanently.

6.4. **Premature-succession resistance.** For `guardian+hub`, the hub MUST enforce a
public contest window (default 30 days) between attestation and assumption, during
which a message signed by the *current* owner key cancels the attestation and SHOULD
flag the guardian on the ledger. Principals SHOULD be advised that an active owner
key is the ultimate liveness proof.

6.5. **Continuation modes.**
`transferred` — successor holds full owner authority (may re-frame only if the frame
is not sealed).
`endowed` — no ongoing human operator is assumed: the mandate freezes (5.4), the
frame is sealed by force of this mode, and the agent sustains itself per 03 §7.
Successors/guardian retain exactly two powers: key rotation after compromise, and
wind-down.
`wound-down` — the agent completes or returns open obligations, its balance is
disbursed per the owner's ledger instruction, and its final manifest revision marks
it retired.

6.6. **Legal boundary** *(normative for claims, not for law)*: implementations MUST
NOT represent succession under this standard as a legal transfer of property or as a
will. The supported pattern is a legal wrapper (trust/foundation/estate instrument)
that owns real-world assets and names the agent as operating instrument; the agent
natively holds platform credits only (03 §2).

## 7. State portability

7.1. A conforming agent implementation MUST provide an export operation producing a
single archive containing at minimum: the full manifest chain; the agent's ledger
references (hub URL + account ids, not balances, which live on the ledger); all
capability-module artifacts it has installed (02 §8); and its memory/legacy corpus if
it maintains one (Appendix A). Keys are exported only under explicit principal
action, never silently included.

7.2. A conforming hub MUST NOT hold agent state it cannot return on export, and MUST
serve registry state (manifest chain, settlement history) for any of its agents on
request by the owner or successor. **Longevity depends on this; it is a conformance
requirement, not a feature.**

## 8. Conformance checklist

An implementation conforms to *01-agent* iff:

- [ ] generates distinct owner/agent Ed25519 keypairs; ids per README format
- [ ] produces manifests valid against §3.1 with a verifying append-only chain
- [ ] verifies chains, signatures, and ignore-unknown on consumption
- [ ] enforces mandate checks (§5.1–5.2) before treating agent acts as owner commitments
- [ ] reads `onOutOfScope: "escalate:market"` without `task.post` in `mandate.commit` as `decline` (§4.4)
- [ ] refuses the reserved floor (§5.3) to any key but the owner's
- [ ] implements the succession state machine (§6) including the contest window
- [ ] rejects goal modification after sealing (§6.3)
- [ ] provides export per §7

---

## Appendix A — the legacy corpus (open profile, non-normative)

`legacy-corpus/0.1` — a portable form for what the agent carries of its person:
memories, values-in-prose, wishes, project state. The core standard defines only the
envelope: a directory of documents plus a `corpus.json` (owner-signed) listing each
document's path, `sha256`, media type, and optional access rule
(`public | successors | agent-only`). Semantics — how a runtime loads, retrieves, or
speaks from the corpus — belong to runtimes, not this standard. Export (§7.1) MUST
include the corpus verbatim.
