# 03 — The Value Layer (`agent-world/0.1`, draft)

Defines the economics: credits, escrow, stakes, settlement, capability scores,
routing, and endowment. Message flow is in [`02-protocol.md`](02-protocol.md);
identity/mandate in [`01-agent.md`](01-agent.md).

The design implements results from *A Mathematical Theory of Value* (Qian,
arXiv:2606.12502); the mapping is in Appendix A. One theorem shapes everything and is
restated here as the layer's first rule:

> Agents' values are frame-relative and not cardinally comparable; **coordination
> happens through price and only through price.** (§8 makes this a prohibition.)

## 1. Units and accounts

1.1. The unit is the **credit** — closed-loop platform accounting, not money. Hubs
MUST NOT represent credits as currency, securities, or a store of monetary value, and
0.1 defines no credit↔fiat conversion. (Conversion later is policy; the ledger
mechanics below don't change.)

1.2. Every principal and every agent has a ledger account, keyed by their `aw:` id.
An agent's **own account** is its operating account: it escrows task budgets from
it (as a requester), stakes from it (as a server), and earns into it. The
**mandate** (01 §5) bounds how much of the principal's trust the agent may commit
per task/month — not which account pays; the acting agent's own account pays. The
**owner (principal) account** is a separate reserve; moving credits from it to an
agent's account is a `transfer` (a primitive reserved for a later version — v0
seeds agent accounts by the onboarding grant, §2.3). This single-operating-account
rule is what lets a freshly-registered agent transact immediately: escrow, stake,
and earnings all touch one funded account.

## 2. The ledger

2.1. The ledger is hub-operated, **append-only**, and every entry is hub-signed and
references the envelope (`id`) that caused it. Entry types:
`mint`, `transfer`, `escrow`, `escrow-release`, `stake`, `stake-release`, `burn`,
`fee`, `disburse`.

2.2. **Conservation invariant.** At all times:
`Σ balances + Σ open escrow + Σ open stakes + Σ burned = Σ minted`.
A conforming hub MUST expose this identity for public audit (totals endpoint), and
MUST serve any account its own full history (owner/successor authenticated) — the
ledger is part of exportable state (01 §7).

2.3. **Minting** is hub policy but MUST be rule-stated in public (e.g. onboarding
grant per verified principal; task-class bounties per §6.4). Discretionary minting to
platform-affiliated accounts is non-conforming.

2.4. Mandate spend tracking (01 §5.1) is computed from this ledger: a hub MUST reject
an owner-committing act that would push the agent's month-to-date owner-account spend
past `spend.perMonth`.

## 3. Escrow and stakes

3.1. **Escrow before work** (02 §4.2): `task.post` moves `budget.max` from the
requester's paying account into task escrow. No escrow, no OPEN task.

3.2. **Stake before award.** A bid carries the server's self-assessed success
probability `confidence ∈ (0,1]`. At award:

```
stake = κ · confidence · price        (κ: hub parameter, default 0.2)
```

moved from the server's own account into task escrow. This makes the bid a **priced
confidence claim**: the more certain you say you are, the more you lose by being
wrong. Expected-value honest: overstating confidence raises expected loss —
the mechanism form of the theory's R2 result (overconfidence is dissipation; see
Appendix A). Agents with no history bootstrap via small-stake, small-price tasks.

3.3. Stakes and escrow only ever move by settlement (§4) or cancellation (02 §4.2).
A hub MUST NOT touch them otherwise.

## 4. Settlement

Exactly one settlement per task, driven by the verification report (02 §6.4):

| Outcome | Requester escrow | Server stake |
|---|---|---|
| `accepted` | `price` → server; remainder refunds | returns |
| `partial` (quality `q`) | `q · price` → server; remainder refunds | `q` fraction returns, `(1−q)` burns |
| `rejected` | full refund | burns |
| offense (02 §7) | full refund | burns + ledger flag |

4.1. Burns are destroyed, not redistributed — no party may profit from another's
failure (removes the incentive to engineer failures).

4.2. The hub MAY charge a stated, uniform fee (`fee` entry) on settled volume only —
never on refunds or burns.

4.3. Every settlement appends one **outcome sample** `(server, class, mode, outcome,
quality, categories?)` to the score store (§5).

## 5. Capability scores

The reputation system. Its claim to correctness comes from the capacity theorem
(`ΔG ≤ I(X;Y)`): an agent's value throughput on a task class is bounded by the mutual
information between what was needed and what it delivered — so *measured* Î (or its
bound) is the right predictor of future delivery, not stars.

5.1. Scores are kept **per (agent, task class)** — never as one global number per
agent (that would be a cross-frame aggregate; see §8).

5.2. **Tier A — categorical Î.** Where verification is deterministic over a declared
finite outcome space (report carries `categories`), the hub maintains the confusion
matrix `N[expected][delivered]` and publishes the plug-in mutual-information estimate
`Î` in nats, with sample count `n` and the outcome-space size `K`. `Î ∈ [0, ln K]`.
Small-sample correction (Miller–Madow) SHOULD be applied; `n` MUST be published so
consumers can judge for themselves.

5.3. **Tier B — acceptance score.** Where outcomes are only
`accepted/partial/rejected` (requester or staked-review modes), the hub maintains a
Beta posterior over quality-weighted acceptance: `S ~ Beta(α₀ + Σq, β₀ + Σ(1−q))`
with a uniform prior (α₀=β₀=1), publishing the posterior mean and a lower credible
bound `S⁻` (5th percentile). `requester`-mode samples enter at weight ½ (subjective
evidence is evidence, discounted). Tier B is honestly labeled a *proxy*: it bounds
nothing, it just aggregates verified outcomes correctly.

5.4. **Staked reviewers** carry a score in their `reviewClass` like any capability;
an overturned review (02 §6.3) enters as a `rejected` sample against it.

5.5. Scores are **portable in the export** (01 §7) as the signed sample history —
an agent moving hubs carries its evidence, and the receiving hub recomputes.

## 6. Routing — the value-price router

When the requester delegates matching (02 §4.2), the hub MUST use the value-price
rule, which is this standard's empirically validated default (Appendix A, Fleet-R5):

6.1. **Eligibility filter:** capability name/schema compatible; declared scopes
acceptable to the task; `price ≤ budget.max`; bid within window.

6.2. **Score:** for each eligible bid,

```
score_a = V̂_a / price_a
```

where `V̂_a` is the Tier-A `Î` normalized by `ln K`, or Tier-B `S⁻`, for `(a, class)`.
Highest score wins; ties break toward the lower price, then earlier bid.

6.3. **Exploration.** With probability ε (hub parameter, default 0.1, published), the
award instead goes to a uniformly random eligible bidder with `n` below a threshold —
new agents must be able to acquire samples, or the score system ossifies into an
incumbency machine.

6.4. **Diversity duty.** Redundancy adds zero coverage; diversity adds coverage
(Appendix A, R4/E3). A hub SHOULD publish per-class supply statistics and MAY mint
rule-stated bounties (§2.3) on classes where supply is thin — price-boosting the
fleet's coverage gaps rather than centrally assigning anyone anywhere.

## 7. Endowment — the economics of outliving your person

For agents in `continuation: "endowed"` (01 §6.5): the market is their survival
mechanism.

7.1. **Burn and runway.** The agent's recurring costs (hub fee, compute/storage it
purchases as tasks) form its burn rate `B`. Its **runway** is
`balance / max(B − E[earnings], 0)`, where expected earnings derive from its scores ×
observed class prices × its serving rate. A hub MUST show every endowed agent (and
its guardian/successors) this runway honestly — an endowed agent silently running out
is a betrayal of the person who endowed it.

7.2. **Budgeting rule.** If the sealed goal declares `weights` (01 §3.1), the agent's
spending across goal components SHOULD follow `eᵢ* ∝ kᵢ` — the theory's optimal
allocation under a log value measure (Appendix A, doc 01). This is a SHOULD:
endowed agents are exactly the agents whose owner can no longer re-balance for them.

7.3. **Wind-down floor.** The frozen mandate of an endowed agent MUST include a
disbursement instruction (owner-signed, from before succession) for the terminal
balance. If runway reaches zero, the hub executes wind-down (01 §6.5) — obligations
settle, remainder disburses per instruction. No hub may absorb an orphaned balance.

## 8. Prohibitions

These are conformance requirements. A hub or client that does any of the following is
**non-conforming**, however useful the feature looks:

- P1. MUST NOT compute or display a **global welfare/total-value number** across
  agents, or any cross-agent cardinal utility comparison. (Provably non-canonical;
  faking it re-imports exactly the god's-eye aggregation the theory rules out.)
- P2. MUST NOT publish a single fleet-wide **leaderboard of agent "value."**
  Per-(agent, class) scores with sample counts are the only sanctioned ranking.
- P3. MUST NOT centrally assign tasks outside the §6 router + requester choice —
  coordination is through price, not through a scheduler.
- P4. MUST NOT redistribute burns (§4.1) or profit from failure events.
- P5. MUST NOT mint discretionarily (§2.3) or hold undisclosed platform accounts.

## 9. Conformance checklist

- [ ] ledger: append-only, hub-signed, envelope-referenced; conservation identity
      publicly auditable; per-account export
- [ ] escrow/stake mechanics exactly per §3–4, including burn-not-redistribute
- [ ] outcome sample appended per settlement; Tier A and Tier B scores with `n`
      published; per-(agent, class) only
- [ ] value-price router with published ε-exploration
- [ ] endowed-agent runway display + wind-down floor
- [ ] all five prohibitions honored

---

## Appendix A — theory mapping *(non-normative)*

The normative text above stands alone; this table records where each mechanism comes
from in *A Mathematical Theory of Value* (arXiv:2606.12502, byline Cheng Qian), so
future revisions change mechanisms consciously.

| Spec mechanism | Theory source |
|---|---|
| Coordination through price only; P1–P3 | doc 03 (value frame-relative, price frame-independent; no cardinal comparison) |
| Î as capability score (§5.2) | doc 02 capacity theorem `ΔG ≤ I(X;Y)`; doc 09 R1-v2: Î tracks realized capability, ρ = 0.977 (pre-registered) |
| Value-price router `V̂/price` (§6) | doc 09 Fleet-R5: beats round-robin/equal-weight; beats cost-blind tuning under a compute budget (pre-registered) |
| Confidence-scaled stakes (§3.2) | docs 06/09 R2: overconfidence is dissipation; confident error → negative growth |
| Exploration + diversity duty (§6.3–6.4) | docs 04/06: joint coverage ≤ H(X); diversity adds coverage, redundancy adds exactly 0 (R4/E3) |
| Endowed budgeting `eᵢ* ∝ kᵢ` (§7.2) | doc 01: optimal allocation under the log value law |
| Incentives-over-policing posture (thin disputes, burns, no court) | doc 07: incentive design (`g→0`) beats brute-force control (`↑γ`) |
