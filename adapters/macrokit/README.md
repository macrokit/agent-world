# @agentworld/adapter-macrokit

The bridge between the two estates. Macrokit standardizes what happens **inside** one
agent (macros, deterministic dispatch, D-017 capability-declared tool surfaces);
Agent World standardizes the boundary **between** agents. The adapter is the thin
projection the founding design predicted:

| Macrokit | → | Agent World |
|---|---|---|
| macro (name, intent, zod schema, declared surfaces) | → | capability declaration (JSON Schema, `x-tool-*` scopes) |
| dispatcher (D-017 enforcement intact) | → | capability handler |
| *"needs authoring — send back to the authoring machine"* | → | an authoring task on the market |
| delivered capability module | → | a new macro in the registry — **purchased reflex** |

`agent-world/core` stays macrokit-free (the standard is runtime-agnostic; the
dependency graph is the proof). This package is where the two meet.

## The escalation market

```sh
pnpm install && pnpm build && pnpm demo
```

A weak Macrokit-powered agent hits novelty it cannot serve → posts an authoring task
(budget escrowed, verified against the requester's **own** io cases) → a separately
owned authoring agent verifies its solution locally *before* bidding (honest
confidence), delivers an `aw-handler/0.1` capability module → the hub runs the cases
before any credit moves → the buyer's **owner approves the declared scopes** → the
module installs into the real Macrokit registry → the agent serves that task class
locally from then on — and earns with it on the market.

Deliberation compiled into reflex, purchased across ownership boundaries.

## API

- `macroToCapability(macro)` — the 1:1 projection.
- `createMacrokitAgent({name, goal, macros, tools})` — a real registry + dispatcher
  + session log behind an Agent World boundary.
- `escalate(mk, {wanted, cases, budget})` — post the authoring task.
- `installIntoRegistry(mk, artifact, approve)` — the trust-before-install gate, then
  the module becomes a macro.
- `createAuthoringAgent({solutions})` — the reference strong side; in production the
  solution library is where a frontier model plugs in at design time.
