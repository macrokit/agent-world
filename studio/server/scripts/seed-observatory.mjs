// Dev tool: serve a studio hub on :7800 seeded with market history, so the
// Observatory has real data to show. State is a temp dir; nothing persists.
//
//   node studio/server/scripts/seed-observatory.mjs
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair } from "@agentworld/identity";
import { createManifest, createEnvelope } from "@agentworld/protocol";
import { DurableHub } from "../dist/index.js";
import { serveStudio } from "../dist/index.js";

const hub = await DurableHub.open(mkdtempSync(join(tmpdir(), "aw-observatory-")));
const srv = await serveStudio(hub, 7800);
console.log(`observatory at ${srv.url}/`);

const mk = (name, caps, goal, continuation = "transferred", sealed = false) => {
  const owner = generateKeypair();
  const agent = generateKeypair();
  const manifest = createManifest(
    {
      id: agent.id,
      name,
      goal: { statement: goal, sealed },
      capabilities: caps,
      endpoints: { inbox: "local:seed" },
      mandate: {
        spend: { perTask: 50, perMonth: 5000, currency: "credit" },
        commit: ["task.post", "task.bid", "task.accept", "task.deliver", "task.verify", "task.cancel", "msg.send"],
        reserved: [],
      },
      succession: { successors: [], frame: "sealed", continuation },
    },
    owner,
  );
  return { owner, agent, manifest };
};

const capOf = (name, intent, scopes = []) => ({
  name, intent, input: {}, output: {}, scopes, pricing: { ask: 3, currency: "credit" }, verification: ["deterministic", "requester"],
});

const requester = mk("personal-agent", [], "extend its person: get things done with other agents");
const classifier = mk("intent-classifier", [capOf("classify", "route a request to the right category")], "sort what its person receives", "endowed", true);
const wordsmith = mk("wordsmith", [capOf("word_stats", "turn text into honest numbers")], "turn text into honest numbers");
const novice = mk("newcomer", [capOf("classify", "a fresh classifier, no track record yet")], "prove itself in the market");

for (const a of [requester, classifier, wordsmith, novice]) {
  hub.registerInbox(a.agent.id, async () => {});
  await hub.handle(createEnvelope("manifest.publish", a.owner, { manifest: a.manifest }));
}
hub.mintWithRule(requester.agent.id, 500, "seed grant");
hub.mintWithRule(classifier.agent.id, 30, "seed grant");
hub.mintWithRule(wordsmith.agent.id, 30, "seed grant");
hub.mintWithRule(novice.agent.id, 30, "seed grant");

async function round(server, cls, tests, data, price = 3) {
  const taskId = randomUUID();
  await hub.handle(createEnvelope("task.post", requester.agent, {
    class: cls, intent: `seeded ${cls} round`, input: {},
    budget: { max: 6, currency: "credit" }, verification: { mode: "deterministic", tests },
  }, { task: taskId }));
  await hub.handle(createEnvelope("task.bid", server.agent, { price, capability: cls, confidence: 0.9 }, { task: taskId }));
  await hub.handle(createEnvelope("task.award", requester.agent, { auto: true }, { task: taskId }));
  await hub.handle(createEnvelope("task.deliver", server.agent, { artifacts: [{ kind: "inline", data }] }, { task: taskId }));
}

// Tier-A history for the classifier: categorical outcomes, 7 right, 2 wrong
const cats = ["billing", "support", "sales"];
for (let i = 0; i < 9; i++) {
  const expected = cats[i % 3];
  const delivered = i < 7 ? expected : cats[(i + 1) % 3];
  await round(classifier, "classify", { category: expected }, { category: delivered }, 3);
}
// Tier-B history for wordsmith: 5 accepted, 1 rejected
for (let i = 0; i < 6; i++) {
  await round(wordsmith, "word_stats", { equals: { ok: true } }, { ok: i < 5 }, 2);
}

// one live OPEN task with competing bids (novice vs classifier)
const openTask = randomUUID();
await hub.handle(createEnvelope("task.post", requester.agent, {
  class: "classify", intent: "which team should read this letter?", input: { text: "…" },
  budget: { max: 6, currency: "credit" }, verification: { mode: "deterministic", tests: { category: "support" } },
}, { task: openTask }));
await hub.handle(createEnvelope("task.bid", classifier.agent, { price: 4, capability: "classify", confidence: 0.9 }, { task: openTask }));
await hub.handle(createEnvelope("task.bid", novice.agent, { price: 2, capability: "classify", confidence: 0.6 }, { task: openTask }));

hub.assertConservation();
console.log("seeded:", JSON.stringify(hub.totals()));
