/**
 * Reference agent #1 — "wordsmith".
 *
 * Internals: a pure TypeScript function. No model, no state, no I/O.
 * The point: the protocol cannot tell and does not care.
 */
import { generateKeypair, type Keypair } from "@agentworld/identity";
import { createManifest, type Manifest } from "@agentworld/protocol";
import { createAgent, type Agent } from "@agentworld/agent";

export interface WordStats extends Record<string, unknown> {
  words: number;
  chars: number;
  top: string;
}

export function wordStats(text: string): WordStats {
  const words = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  let top = "";
  let best = 0;
  for (const [w, n] of counts) {
    if (n > best) {
      top = w;
      best = n;
    } // ties: earliest occurrence wins (Map preserves insertion order)
  }
  return { words: words.length, chars: text.length, top };
}

export function createWordsmith(inboxUrl: string): { agent: Agent; owner: Keypair; key: Keypair; manifest: Manifest } {
  const owner = generateKeypair();
  const key = generateKeypair();
  const manifest = createManifest(
    {
      id: key.id,
      name: "wordsmith",
      goal: { statement: "turn text into honest numbers" },
      capabilities: [
        {
          name: "word_stats",
          intent: "count words and characters and find the most frequent word",
          input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          output: {
            type: "object",
            properties: { words: { type: "number" }, chars: { type: "number" }, top: { type: "string" } },
          },
          scopes: [],
          pricing: { ask: 3, currency: "credit" },
          verification: ["deterministic", "requester"],
        },
      ],
      endpoints: { inbox: inboxUrl },
      mandate: {
        spend: { perTask: 0, perMonth: 0, currency: "credit" }, // earns only; commits nothing of its owner's
        commit: ["task.bid", "task.accept", "task.deliver"],
        reserved: [],
      },
      succession: { successors: [], frame: "sealed", continuation: "wound-down" },
    },
    owner,
  );
  const agent = createAgent({ manifest, key, ownerKey: owner });
  agent.capability("word_stats", async (input) => wordStats(String(input["text"] ?? "")));
  return { agent, owner, key, manifest };
}
