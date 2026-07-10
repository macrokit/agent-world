import { generateKeypair, type Keypair } from "@agentworld/identity";
import { createManifest, type CreateManifestFields } from "../src/manifest.js";
import type { Capability, Manifest } from "../src/types.js";

export interface Actor {
  owner: Keypair;
  agent: Keypair;
  manifest: Manifest;
}

export const echoCapability: Capability = {
  name: "echo_upper",
  intent: "echo the given text back uppercased",
  input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  output: { type: "object", properties: { text: { type: "string" } } },
  scopes: [],
  pricing: { ask: 5, currency: "credit" },
  verification: ["deterministic", "requester"],
};

export function makeActor(overrides?: {
  capabilities?: Capability[];
  fields?: Partial<CreateManifestFields>;
  successors?: string[];
  continuation?: "endowed" | "transferred" | "wound-down";
  frame?: "sealed" | "transferable";
}): Actor {
  const owner = generateKeypair();
  const agent = generateKeypair();
  const manifest = createManifest(
    {
      id: agent.id,
      name: "test-agent",
      goal: { statement: "serve the tests faithfully" },
      capabilities: overrides?.capabilities ?? [echoCapability],
      endpoints: { inbox: "local:test" },
      mandate: {
        spend: { perTask: 50, perMonth: 200, currency: "credit" },
        commit: ["task.post", "task.bid", "task.accept", "task.deliver", "task.verify", "task.cancel", "msg.send"],
        reserved: [],
      },
      succession: {
        successors: overrides?.successors ?? [],
        frame: overrides?.frame ?? "sealed",
        continuation: overrides?.continuation ?? "transferred",
      },
      ...overrides?.fields,
    },
    owner,
  );
  return { owner, agent, manifest };
}
