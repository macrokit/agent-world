# Agent World — core

The open standard + SDK for personally-owned agents. **An agent is an extension of a
real person — in ability, in time, and in life.**

- **The standard** lives in [`spec/`](spec/README.md): identity/manifest/mandate/
  succession ([01](spec/01-agent.md)), the interaction protocol ([02](spec/02-protocol.md)),
  and the value layer ([03](spec/03-value-layer.md)).
- **The SDK** is its executable form:

| Package | Provides |
|---|---|
| `@agentworld/identity` | Ed25519 keypairs, `aw:` ids, RFC 8785 canonicalization, signatures |
| `@agentworld/protocol` | manifest chains (sealing, succession), envelopes, the task state machine, `InMemoryHub` (reference hub: escrow, stakes, settlement), HTTP binding + `HubClient` |
| `@agentworld/agent` | `createAgent()` — declare capabilities, attach any async function as a handler, serve an inbox, act within the mandate |
| `@agentworld/value` | the value layer as pure math: Tier-A categorical Î, Tier-B Beta scores, the value-price router (zero dependencies) |
| `@agentworld/bridge-mcp` | expose an agent as an MCP server — capabilities become tools (spec 02 Appendix A) |
| `@agentworld/bridge-a2a` | expose an agent to A2A clients — AgentCard + `message/send` subset |
| `@agentworld/cli` | `aw` — init, keygen, sign, verify, register, serve, export |

## 60 seconds

```sh
pnpm install && pnpm -r build
node packages/cli/dist/index.js init my-agent
# edit my-agent/agent.json (goal, capabilities, mandate, succession)
node packages/cli/dist/index.js sign my-agent
node packages/cli/dist/index.js verify my-agent
```

```ts
import { createAgent } from "@agentworld/agent";

const agent = createAgent({ manifest, key, ownerKey });
agent.capability("rank_papers", async (input) => {
  // ANY internals: a local model, a Macrokit runtime, an API, a human queue
  return { ranked: [] };
});
agent.connect(hub);
await agent.register();
await agent.listen(7801);
```

## Development

```sh
pnpm -r build && pnpm -r test && pnpm -r typecheck
```

The standard is boundary-only: nothing in `core/` may depend on or inspect an agent's
internals, and `core/` has zero `@macrokit/*` dependencies by design (Macrokit is one
possible internals runtime, bridged by a separate adapter).

Apache-2.0.
