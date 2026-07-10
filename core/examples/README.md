# Reference agents

Two agents with **deliberately different internals**, so the standard's central claim —
the protocol never looks inside an agent — is demonstrated, not asserted:

| Agent | Capability | Internals | Scopes |
|---|---|---|---|
| **wordsmith** | `word_stats` | a pure TypeScript function | none |
| **kv-oracle** | `fact_lookup` | a knowledge file on disk, read at call time | `fs:read` |

The kv-oracle is also the miniature of the project's purpose: an agent that keeps and
serves its person's knowledge (`succession.continuation: "endowed"` — it is meant to
outlive its owner and earn its upkeep in the market).

## The demo

```sh
pnpm build && pnpm demo
```

Spins a hub with the real HTTP binding, three separately-keyed agents (the two above
plus a capability-less **personal agent** that posts the tasks), and runs two full
market rounds — post → bid → award → deliver → verify → settle — with escrow,
confidence-scaled stakes, deterministic verification run by the hub, and the ledger
conservation invariant checked at the end.

To run against a **durable** hub instead, start `aw-hub` from `studio/server` and
point `HubClient` at it — the semantics are identical (`DurableHub extends
InMemoryHub`); state survives restarts via the journal.
