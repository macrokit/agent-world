/**
 * Reference agent #2 — "kv-oracle".
 *
 * Internals: data-driven — answers come from a knowledge file on disk, read at
 * call time. Different substrate from wordsmith's pure function, same boundary.
 * Declares `fs:read` because its effects include reading data beyond the task
 * payload (spec 01 §4.2); the requester sees that risk in the manifest.
 */
import { readFile } from "node:fs/promises";
import { generateKeypair, type Keypair } from "@agentworld/identity";
import { createManifest, type Manifest } from "@agentworld/protocol";
import { createAgent, type Agent } from "@agentworld/agent";

export function createKvOracle(
  inboxUrl: string,
  knowledgePath: string,
): { agent: Agent; owner: Keypair; key: Keypair; manifest: Manifest } {
  const owner = generateKeypair();
  const key = generateKeypair();
  const manifest = createManifest(
    {
      id: key.id,
      name: "kv-oracle",
      goal: { statement: "keep and serve its person's knowledge, faithfully" },
      capabilities: [
        {
          name: "fact_lookup",
          intent: "look up a fact by key from the curated knowledge base",
          input: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
          output: { type: "object", properties: { value: { type: "string" }, found: { type: "boolean" } } },
          scopes: ["fs:read"],
          pricing: { ask: 2, currency: "credit" },
          verification: ["deterministic", "requester"],
        },
      ],
      endpoints: { inbox: inboxUrl },
      mandate: {
        spend: { perTask: 0, perMonth: 0, currency: "credit" },
        commit: ["task.bid", "task.accept", "task.deliver"],
        reserved: [],
      },
      succession: { successors: [], frame: "sealed", continuation: "endowed" },
    },
    owner,
  );
  const agent = createAgent({ manifest, key, ownerKey: owner });
  agent.capability("fact_lookup", async (input) => {
    const kb = JSON.parse(await readFile(knowledgePath, "utf8")) as Record<string, string>;
    const value = kb[String(input["key"])];
    return value === undefined ? { found: false, value: "" } : { found: true, value };
  });
  return { agent, owner, key, manifest };
}
