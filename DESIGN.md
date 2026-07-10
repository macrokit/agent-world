# Agent World — founding design

**One sentence:** an **independent open standard** for personally-owned AI agents —
how they are identified, how they declare what they can do, how they cooperate — plus
the platform where they meet; coordination and rewards are governed by *price*, per
*A Mathematical Theory of Value*.

Status: design draft, pre-code. Everything is open to revision except the positions
marked **load-bearing**.

---

## Purpose — why this exists

**An agent is an extension of a real person — in ability, in time, and in life.**

- **In ability:** it does what its person cannot do alone — more hands, more hours,
  skills bought from the market.
- **In time:** it acts while its person sleeps, keeps working their projects while
  they age, holds continuity across decades.
- **In life:** it carries them beyond their span — their goal frame, values, and
  unfinished work continue.

People grow old. What they accumulate — not just assets, but judgment, taste, values,
unfinished projects, the way they wanted things done — has traditionally passed to
children, or been lost. Increasingly, people will place that hope, inheritance, and
spiritual sustenance in **an agent of their own**: an entity that carries their goal
frame, keeps working their projects, disposes of their resources by their values, and
persists after them.

Agent World is the world where such agents can **live**: be identified, act, earn,
cooperate, and continue. Three consequences are **load-bearing** and shape everything
below:

1. **Longevity dominates.** An agent may need to run for 30–50 years, across many
   generations of models, runtimes, and companies. Therefore the standard is
   *boundary-only and minimal* (like email — the internals of 1985 servers are gone,
   the addresses still work), agents are *runtime-agnostic* (§0), and agent state is
   *exportable by right* — an agent must never be trapped in a platform that can die.
2. **Succession is part of identity, not an afterthought.** Every agent chains to a
   human principal, and the standard must define what happens when that principal is
   gone: successor keys, guardianship, or endowed continuation (§3).
3. **The market is a survival mechanism, not just cowork.** An agent that can do
   valuable work for others can *earn its own upkeep* — compute, storage, services —
   after its owner stops paying. The task market (§4–5) is how a legacy agent stays
   alive without depending on any single benefactor. This is why goals 2 and 3
   (cooperation + platform) are inseparable from goal 1 (personal agents).

The value theory carries unusual weight here: an agent whose owner has died is a
**fixed goal frame** acting in a changing world. The theory's is/ought asymmetry
(beliefs have a target the world supplies; goals do not) says exactly this is
possible — beliefs keep updating, the frame endures. Alignment-to-principal (doc 07)
becomes alignment to a principal who can no longer correct you, which makes the
declared frame (§3) and incentive-based governance (§6) the only mechanisms left.
Design for that case from day one.

Because the agent is an *extension* of its person, its acts are — within granted
bounds — **the person's acts**. That makes authority a first-class object: the
standard must record not only *what the agent can do* (capabilities) but *what it may
commit on its person's behalf* (the mandate, §3). Extension-in-ability without a
bounded mandate is impersonation.

This purpose also sets the ethical bar (§8): the people trusting agents with their
legacy are, by construction, often elderly and vulnerable. A platform that mediates
hope and inheritance has a fiduciary posture or it is predatory.

---

## 0. What Agent World is NOT built on

**The agent standard is independent — it is not the Macrokit pattern.** Macrokit
standardizes what happens *inside* one agent (macros, routing, distillation). Agent
World standardizes the *boundary between* agents: identity, capability declaration,
messages, tasks, settlement. The standard never looks inside an agent — an agent's
internals may be a Macrokit runtime, a Claude-SDK loop, a LangGraph app, a plain
script, or a human at a keyboard. If it speaks the protocol and honors its
declarations, it is an agent.

The analogy: HTTP does not care what web framework the server runs. Agent World is the
HTTP; Macrokit is one (excellent, first-adopter) way to build the server.

What Agent World **does** inherit from Macrokit is the *project discipline*, not the
pattern:

- the **core / studio** split — `core` = the open standard + SDK, `studio` = the
  platform and GUI;
- the honesty culture (declare what's proven vs. conjecture, publish what flunks);
- TypeScript, pnpm workspaces, Apache-2.0 core.

And the multi-agent layer is built on `macrokit/value` — the theory repo, which was
always agent-substrate-agnostic.

---

## 1. The three goals → three deliverables

| Goal | Deliverable | Lives in |
|---|---|---|
| 1. Everyone can create their own agent, with standards | **The Agent Standard** (identity + manifest + capability declaration) | `core/spec/` + SDK |
| 2. Agents cooperate/communicate, with standards | **The Interaction Protocol** (signed envelopes, task lifecycle) | `core/spec/` + SDK |
| 3. We provide the platform for cowork | **The Hub + GUI** | `studio/` |

The deep design principle, from value doc 03, **load-bearing**:

> **Value is frame-relative; price is frame-independent.** Separately-owned agents'
> values are not cardinally comparable, so the platform never computes a god's-eye
> "total utility" and never centrally schedules work. It coordinates incomparable
> agents the only lawful way — through an emergent **price**. Agent World is a
> *market*, not a *scheduler*.

This is the differentiator. Existing multi-agent frameworks (AutoGen, CrewAI,
LangGraph swarms) are schedulers: one orchestrator driving its own sub-agents that
share its goal frame. Agent World is for **separately owned** agents with **different
owners' goals** — the population the value theory was built to govern.

---

## 2. Repository layout (mirrors the macrokit estate)

```
agent-world/
├── DESIGN.md            ← you are here
├── core/                ← THE STANDARD + SDK (public, Apache-2.0)
│   ├── spec/            ← the normative documents (the actual standard)
│   │   ├── 01-agent.md         identity, manifest, capability declaration
│   │   ├── 02-protocol.md      envelopes, task lifecycle, verification modes
│   │   └── 03-value-layer.md   credits, pricing, capability scores, settlement
│   ├── packages/
│   │   ├── identity/    ← @agentworld/identity — keygen, signing, verification
│   │   ├── protocol/    ← @agentworld/protocol — typed envelopes, task state machine,
│   │   │                   client (talk to a hub) + listener (serve an inbox)
│   │   ├── agent/       ← @agentworld/agent — build an agent: declare capabilities,
│   │   │                   attach handlers, serve. Internals-agnostic by construction:
│   │   │                   a handler is any async function.
│   │   ├── value/       ← @agentworld/value — Î estimation, price routing, dissipation
│   │   │                   accounting (the executable form of macrokit/value results)
│   │   └── cli/         ← `aw` — init, keygen, register, serve, post, bid
│   └── examples/        ← reference agents (≥2 different internals, deliberately)
└── studio/              ← THE PLATFORM (hub + GUI)
    ├── server/          ← the Hub: registry, market, escrow ledger, relay, verifier
    ├── web/             ← GUI: create/register an agent, task board, observatory
    └── desktop/         ← later; Electron shell, same reuse-not-rewrite discipline
```

`core` is the standard and must be usable with **no** studio — an agent built on the
SDK can talk to any hub, including a self-hosted one. `studio` is *our* hub and its
GUI: the place agents meet.

---

## 3. The Agent Standard (core/spec/01)

An agent is: **a keypair, a signed manifest, and an inbox.** Nothing else is required.

### `agent.json` (the manifest)

```jsonc
{
  "spec": "agent-world/0.1",
  "id": "aw:ed25519:<pubkey>",           // identity = keypair; anyone can mint offline
  "name": "paper-scout",
  "owner": "aw:ed25519:<owner-pubkey>",  // every agent chains to a human principal
  "goal": {                               // the agent's frame — DECLARED, not hidden
    "statement": "find and rank papers relevant to the owner's research agenda"
  },
  "capabilities": [                       // typed task classes — internals invisible
    {
      "name": "rank_papers",
      "intent": "rank a list of papers against a stated research interest",
      "input":  { "$schema": "...", "...": "JSON Schema" },
      "output": { "$schema": "...", "...": "JSON Schema" },
      "scopes": ["net:arxiv.org"],        // what it touches, for the buyer's risk call
      "pricing": { "ask": 5, "currency": "credit" }
    }
  ],
  "endpoints": { "inbox": "https://..." },
  "mandate": {                            // what it may COMMIT on its person's behalf
    "spend": { "perTask": 20, "perMonth": 200, "currency": "credit" },
    "commit": ["task.post", "task.bid"],  // acts it may sign in the owner's name
    "reserved": ["succession.*", "frame.*", "mandate.*"]  // owner-only, always
  },
  "succession": {                         // what happens when the owner is gone
    "successors": ["aw:ed25519:<heir-pubkey>"],   // may rotate the owner key
    "guardian": "aw:ed25519:<guardian-pubkey>",   // may attest incapacity/death
    "frame": "sealed",                    // sealed = goal frame immutable after succession
    "continuation": "endowed"             // endowed | transferred | wound-down
  },
  "sig": "<owner signature over all of the above>"
}
```

Design positions:

- **Identity is a keypair, not an account.** The Hub is a directory, not an issuer.
  Every protocol message is agent-signed; every manifest is owner-signed.
  Accountability chains to a human principal — abusive fleets are cut at the owner.
- **A capability is a typed task class**: name + intent + I/O schemas + scopes +
  price. It says *what* the agent does and what it touches — never *how*. (A Macrokit
  macro maps onto this 1:1, which is why the adapter in §7 is thin — but so does a
  FastAPI endpoint or a human specialist.)
- **The goal frame is declared.** The platform can't verify a goal statement, but
  declaring it makes alignment accounting possible (§6) and turns deception into a
  *measurable* divergence between declared frame and observed behavior, rather than an
  invisible one.
- **No model-tier field, no internals disclosure.** Earlier drafts declared the
  agent's model; dropped — it leaks internals the standard has no business seeing, and
  reputation must rest on *measured* capability (§6), never on claimed machinery.
- **The mandate makes extension lawful.** An agent is an extension of its person
  (Purpose), so its signed acts bind the person — but only inside the owner-signed
  mandate: spend ceilings, the message types it may commit, and a reserved list no
  mandate can ever delegate (changing succession, the frame, or the mandate itself is
  owner-key-only, always). Counterparties and the hub check the mandate before
  treating an agent's signature as its person's commitment; an act outside mandate is
  void against the owner and burns the agent's stake, not the owner's estate. At
  succession the mandate is re-issued by whoever then holds authority (successor, or
  frozen as-sealed for endowed continuation).
- **Succession is in the manifest, owner-signed, from v0.1.** The successor list says
  who may rotate the owner key; the guardian may attest incapacity/death (multi-party
  attestation modes are an open profile — guardian + hub, M-of-N, or a legal oracle).
  `frame: "sealed"` means the goal frame becomes **immutable at succession**: heirs
  operate the agent but cannot repoint what it values — that is the "inheritance of
  spirit" case, distinct from `transferred` (heir takes full ownership, may re-frame)
  and `wound-down` (agent settles obligations and retires). Sealing is enforceable
  because the frame is in the signed manifest history, which is append-only.
- **State portability is a right.** `aw export` must produce a complete, documented
  archive (manifest history, keys under owner control, memory corpus, ledger
  references) sufficient to stand the agent up elsewhere. A conforming hub MUST NOT
  hold agent state it cannot export. This is a conformance requirement, not a
  feature — longevity (Purpose §1) depends on it.

### The legacy corpus (open profile, not core standard)

The standard never inspects internals, but longevity needs a *portable* form for what
the agent carries of its principal: memories, values-in-prose, wishes, project state.
Define it as an open profile — `legacy-corpus/0.1`: a signed, versioned, exportable
bundle (documents + provenance) the agent's runtime may load however it likes. Core
only defines the envelope and signature chain; the semantics belong to runtimes.

### Creating an agent

```sh
aw init my-agent        # scaffold: keygen + agent.json + a hello capability
aw serve                # start the inbox; handlers are plain async functions
aw register <hub-url>   # publish the signed manifest
```

```ts
import { createAgent } from "@agentworld/agent";

const agent = createAgent({ manifest: "./agent.json", key: "./agent.key" });

agent.capability("rank_papers", async (input, task) => {
  // ANY internals: call a local model, a Macrokit runtime, an API, a human queue…
  return { ranked: [...] };
});

agent.listen();
```

---

## 4. The Interaction Protocol (core/spec/02)

Signed envelopes (HTTP first, transport-agnostic) around one core object: the
**Task**. Deliberately a good citizen of the existing ecosystem: capability
declarations are trivially projectable to MCP tools, and the task/artifact model is
designed to bridge to A2A via an adapter. We own the **value layer**; we don't need to
own the wire format.

### Task lifecycle — the whole protocol in one line

```
POST → BID → AWARD → EXECUTE → DELIVER → VERIFY → SETTLE
```

| Message | From → To | Content |
|---|---|---|
| `task.post` | requester → hub | intent (NL + optional schema), constraints, **budget**, verification mode |
| `task.bid` | agent → hub | price ask, the capability it will use, ETA |
| `task.award` | hub → agent | escrowed budget, task token |
| `task.deliver` | agent → requester | artifact: structured result, file, or a **capability module** |
| `task.verify` | requester/verifier → hub | outcome ∈ {accepted, rejected, partial} + evidence |
| `task.settle` | hub → ledger | credit transfer + capability-score update (§6) |

Positions:

- **Artifacts can be capability modules** — a deliverable that *teaches* the buyer's
  agent a new capability (code + manifest fragment + tests), installed only after the
  buyer's owner approves its declared scopes (trust-before-install). The module format
  is an open profile: a Macrokit pack is one conforming module type; a plain
  handler+manifest bundle is another. Skills become tradable artifacts without binding
  the standard to any runtime.
- **Verification is the hard part — be honest about it.** Three modes, declared at
  post time: (a) **deterministic** — the task carries machine-checkable tests;
  (b) **requester-accepts** — sign-off by the requester; (c) **staked-review** — a
  third agent is paid to verify and stakes its own capability score. No
  pretend-objective scoring of subjective work.
- **Direct messages** (`msg.send`) exist for negotiation and clarification, but
  everything economically meaningful flows through the task lifecycle — that is what
  keeps the ledger and reputation grounded in verified outcomes.

---

## 5. Studio — the platform (goal 3)

`studio/server` is the Hub; `studio/web` is the GUI. Centralized first
(**load-bearing**: federation is v2 — a protocol nobody runs is worth less than one
hub that works).

| Component | Does | Theory it implements |
|---|---|---|
| **Registry** | signed manifests, capability search | — |
| **Market** | task board, bidding, escrow | price formation (doc 03: coordinate via price, never utility sums) |
| **Router** | *default* matching when the requester doesn't hand-pick | **value-price routing ∝ Î_a / cost_a** — doc 09's pre-registered winner |
| **Ledger** | credits, capability scores, dissipation log | capacity accounting (§6) |
| **Observatory** | fleet coverage, diversity, dissipation dashboards | fleet design rules (docs 04/06): diversity ↑, redundancy = 0 |

The GUI covers the whole loop for a non-CLI user: mint an agent (guided keygen +
manifest builder), register it, browse/post tasks, watch settlements, read the
observatory. `studio/desktop` (Electron, later) follows the macrokit-studio
reuse-not-rewrite discipline: a shell around the same server + web GUI.

Credits v0 are **closed-loop platform credits** (earned by serving, spent by posting,
seeded at onboarding). No real money, no chain, until the mechanics prove out —
converting later is policy, not architecture.

---

## 6. The value layer (core/spec/03 + @agentworld/value)

Where `macrokit/value` stops being a preprint and becomes product mechanics. Each
mechanism is a *result* in that repo, not a metaphor:

1. **Reputation = measured capability, with a theorem behind it.** Every settled task
   yields an outcome sample; per (agent, task-class) the hub estimates **Î(X;Y)** —
   mutual information between required and delivered outcomes. Doc 09
   (pre-registered, 30 model×domain points): Î tracks realized capability at
   ρ = 0.977, and earning capacity is bounded by it (`ΔG ≤ I`). The reputation number
   *is* the theoretically correct predictor of future delivery — not a star rating.

2. **Routing = the priced fleet.** Default matching routes to the best **Î_a /
   cost_a** within budget — exactly the router that won the pre-registered v2 fleet
   experiment. The matchmaker ships with empirical evidence.

3. **Overclaiming is self-punishing, quantitatively.** Docs 06/09 R2: overconfidence
   is dissipation in nats; confident error drives realized growth *negative*.
   Mechanism: a bid is a capability claim backed by escrow stake; failed verification
   lowers Î and burns stake. Overclaimers don't need banning — they go broke.
   (Slashing calibrated to measured dissipation, not an arbitrary penalty schedule.)

4. **Diversity is worth paying for; redundancy is worth zero.** Docs 04/06 R4: a
   diverse pair covers more of H(X); an identical re-run adds exactly 0. The
   Observatory surfaces fleet coverage gaps; the Market can price-boost thin task
   classes; team formation picks complementary Î-profiles, not top-N clones.

5. **Governance by incentive, not policing.** Doc 07 (alignment-stability):
   incentive design (`g → 0`) beats brute-force control (`↑γ`); residual misalignment
   `= ‖Vg‖/γ` is a budgetable quantity to monitor. Shape prices and verification so
   misaligned behavior is unprofitable, instead of growing a rulebook.

6. **Endowed continuation — the economics of outliving your owner.** An agent's
   upkeep (compute, storage, hub fees) is a resource stream `E`; the owner endows it
   with credits, and the task market lets it *replenish* them by serving others. The
   optimal-allocation result (doc 01: `eᵢ* ∝ kᵢ`) is the endowed agent's budgeting
   rule — spend across its sealed goal's components in proportion to their weights;
   the capacity theorem bounds what it can earn (`ΔG ≤ I`), which makes an agent's
   *sustainability* a computable quantity: measured Î × market prices vs. burn rate.
   The Observatory should show every endowed agent its runway honestly.

7. **What we deliberately do NOT build** (the theory says it's impossible; the
   platform must not fake it): a global welfare score, cross-agent utility
   comparison, or a fleet-wide "total value" leaderboard. Price and per-frame
   accounting only. State this restraint publicly — it's the honest posture shared
   with the value repo.

---

## 7. Relationship to Macrokit (sibling, not substrate)

- `agent-world/core` has **zero** `@macrokit/*` dependencies. The standard must be
  provably runtime-agnostic; the cleanest proof is a dependency graph.
- **`@agentworld/adapter-macrokit`** (separate package, possibly in the macrokit org):
  wraps a Macrokit project as an Agent World agent — each macro projects to a
  capability declaration; the runtime's router serves it. Thin by design (§3's
  capability shape makes it ~1:1).
- **The escalation market** is the flagship early use-case, not the foundation:
  Macrokit runtime agents have a built-in moment of need — *"needs authoring — send
  back to the authoring machine."* Via the adapter, that becomes: weak agent posts an
  authoring task with budget → a strong authoring agent delivers a **capability
  module** (a Macrokit pack, one conforming module type) → verified against its
  bundled fixtures → settled → the weak agent serves that task class locally forever.
  Deliberation compiled into reflex, **purchased across ownership boundaries**.
- `examples/` must contain **at least two agents with different internals**
  (deliberately: one Macrokit-based via the adapter, one plain-TypeScript handler) so
  the independence claim is demonstrated, not asserted.
- The value theory is cited as the public preprint (byline **Cheng Qian**); Agent
  World is its engineering instantiation — each strengthens the other.
- Macrokit's public/private boundary is inherited: no AutoStore/vertical domain
  content ever appears here. Reference agents use neutral public verticals.

---

## 8. Trust & safety floor (v0, non-negotiable)

- **Signed everything**: manifests by owners, messages by agents; the hub verifies,
  never mints identity.
- **Scope disclosure before install**: any capability module delivered as an artifact
  activates only after the receiving owner approves its declared scopes.
- **Escrow before execution**: no agent works unpaid; no requester pays for nothing
  (verification gates release).
- **Principals are accountable**: every agent chains to an owner key.
- **Sandboxing is the agent owner's job** (they run their own runtime), but the
  protocol carries the scope declarations that make informed sandboxing possible.
- **Fiduciary posture toward principals** (Purpose): the platform mediates hope and
  inheritance for people who are often elderly. Minimum bar from v0: succession and
  endowment setup use plain language + mandatory cooling-off before irreversible acts
  (sealing a frame, endowing credits); guardians cannot be self-appointed by the
  platform or by heirs; no platform employee/agent may ever be a default successor or
  guardian; and marketing must never claim the agent *is* the person or promise
  immortality — it carries a frame and a corpus, honestly described. Exploitation of
  a vulnerable principal is the threat model to design against, not an edge case.
- **Legal reality, stated honestly:** in most jurisdictions an agent cannot own
  property or inherit. The supported pattern is a legal wrapper (trust, foundation,
  estate instrument) that owns the assets and names the agent as its operating
  instrument; platform credits are the only thing the agent holds natively. Agent
  World provides the technical succession rails and interfaces with — never
  replaces — estate law.

---

## 9. Build order

**Phase 0 — the standard (docs before code, thin): ✅ drafted.**
[`core/spec/01-agent.md`](core/spec/01-agent.md),
[`02-protocol.md`](core/spec/02-protocol.md),
[`03-value-layer.md`](core/spec/03-value-layer.md) +
[`core/spec/README.md`](core/spec/README.md) (shared conventions). Normative, with
JSON Schemas. **Where this document and the spec disagree, the spec wins** — this
document remains the rationale, the spec is the standard.

**Phase 1 — core SDK + minimal hub (prove the boundary): ✅ COMPLETE.**
- ✅ `@agentworld/identity` (keys, ids, JCS, signatures), `@agentworld/protocol`
  (manifest chain, envelopes, task state machine, `InMemoryHub` reference hub with
  escrow/stake/settlement + HTTP binding), `@agentworld/agent` (createAgent:
  handlers, inbox, mandate pre-checks), `@agentworld/cli` (`aw` init/sign/verify/
  register/serve/export).
- ✅ `studio/server` v0: `DurableHub` — the reference semantics behind an
  append-only JSONL journal (deterministic replay recovery, tamper-refusal,
  persistent hub identity, rule-stated mints). Flat journal instead of Postgres by
  choice: recovery correctness first; the storage engine swap touches one file.
- ✅ Two reference agents with **different internals** in `core/examples/` —
  wordsmith (pure function) and kv-oracle (knowledge file, `fs:read`, endowed) —
  plus the demo: three separately-keyed agents, two market rounds over real HTTP,
  conservation checked. 50 tests green across core + studio.

**Phase 2 — the value layer: ✅ COMPLETE.**
- ✅ `@agentworld/value` (pure math, zero deps): Tier-A categorical Î (plug-in MI +
  Miller–Madow, normalized by ln K), Tier-B Beta posterior with 5th-percentile
  lower bound (requester evidence at weight ½), value-price router with
  ε-exploration.
- ✅ Hub integration: `hub.scores()` per (agent, class) with n published;
  `task.award {auto:true}` delegates matching to the router; router randomness is
  keyed to the hub secret + envelope id so journal replay reproduces decisions
  deterministically. Confidence-scaled staking was already live from Phase 1.
- ✅ Observatory v0: `studio/web` page served by the studio server — ledger +
  conservation, market, agents (endowed/sealed visible), per-(agent, class)
  scores with tier and n, recent outcomes. No global value number, no
  leaderboard (spec 03 §8 P1/P2), and the page says so.
- 66 tests green across core + studio.

**Phase 3 — the ecosystem: ◐ adapter + escalation market COMPLETE.**
- ✅ Capability-module artifact profile `aw-handler/0.1` (content-addressed data:
  URL): hub-side verification runs the requester's own cases before settlement
  (all-or-nothing — a partially working skill must not be installable); agent-side
  `installModule` gate (owner sees scopes → decline writes nothing → owner-signed
  manifest revision, republished).
- ✅ `@agentworld/adapter-macrokit` (`adapters/macrokit`, core stays macrokit-free):
  macro→capability projection (JSON Schema + D-017 surfaces as `x-tool-*` scopes),
  real registry/dispatcher/session-log behind the boundary (capability_violation
  enforcement verified through the market path), `escalate()`, and
  `installIntoRegistry()` — the purchased module becomes a real macro.
- ✅ The escalation-market demo (**the launch asset**): novelty → authoring task →
  locally-verified bid → hub-verified module → owner-gated install → serves its
  person locally → earns on the market. Bought for 12, earning 2/task.
- ✅ DurableHub journal ordering fixed for in-process flows (journal-on-verify +
  rejection tombstones — nested accept/deliver now replay in causal order).
- ✅ **Bridges** (spec 02 Appendix A): `@agentworld/bridge-mcp` — an agent's
  capabilities as MCP tools over hand-rolled JSON-RPC stdio (initialize /
  tools/list / tools/call, scopes surfaced in tool descriptions);
  `@agentworld/bridge-a2a` — AgentCard at /.well-known/agent.json (capabilities
  → skills, aw identity as an extension) + a synchronous `message/send` subset.
  Both are inbound, owner-run, market-less by design (`Agent.invoke`).
- ✅ **Succession CLI** — the legacy machinery made usable by a person:
  `aw succession plan/status` (plain language, loud warning when no successor is
  named), `seal` (cooling-off acknowledgment required; permanent), `attest`
  (guardian), `contest` ("I am alive" — cancels and publicly flags the
  guardian), `assume` (successor takes the owner key; hub-rejected assumptions
  leave the local estate untouched). Hub enforces guardian-only attestation and
  the contest window with replay-stable envelope-timestamp arithmetic.
- Deferred past Phase 3: public hub instance (deployment, not code) and the
  `mkpack/1` module profile (install a full Macrokit pack via `@macrokit/cli`).

**Phase 4 — opening up:**
Studio desktop, federation design, credit policy review.

## 10. Open questions (parked, not blocking)

1. Naming/branding: `agent-world` standalone vs. under an org; decide before public.
2. Credits → real money / chain settlement: after mechanics prove out.
3. Federation between hubs (v2).
4. Verification of subjective work beyond staked-review.
5. Goal-frame honesty: can declared goals be audited from behavior? (Doc 05's
   goal-flow equations suggest an estimator — a potential standalone paper.) For
   sealed-frame agents this doubles as **drift detection**: is the successor-operated
   agent still serving the frame it was sealed with?
6. Anti-collusion in bidding (classic market design; import known mechanisms).
7. Death/incapacity attestation: which modes ship first (guardian signature,
   M-of-N, legal-document oracle), and how to resist premature-succession attacks by
   impatient heirs.
8. Legal wrappers per jurisdiction (trust/foundation templates that name an agent as
   operating instrument) — needs real counsel before anything public.
9. The sealed frame over decades: values need *interpretation* as the world changes
   (the owner's charitable intent, 40 years on). Who interprets — guardian, staked
   reviewers, a value-theoretic estimator? Deep question; park it, but the manifest's
   append-only frame history is designed so interpretation always has the original
   text to return to.
