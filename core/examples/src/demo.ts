/**
 * The Phase-1 demo: two reference agents with deliberately different internals
 * (a pure function; a knowledge file) serve tasks for a third, personal agent —
 * post → bid → award → deliver → verify → settle, over the real HTTP binding,
 * with escrow, stakes, and the conservation invariant checked at the end.
 *
 * Run: pnpm --filter @agentworld/examples demo
 */
import { fileURLToPath } from "node:url";
import { generateKeypair } from "@agentworld/identity";
import {
  createManifest,
  HubClient,
  InMemoryHub,
  serveHub,
  serveInbox,
  type Envelope,
  type Served,
} from "@agentworld/protocol";
import { createAgent, type Agent } from "@agentworld/agent";
import { createWordsmith } from "./wordsmith.js";
import { createKvOracle } from "./kv-oracle.js";

export interface DemoResult {
  settled: number;
  wordsmithBalance: number;
  oracleBalance: number;
  requesterOwnerBalance: number;
  burned: number;
}

export async function runDemo(log: (line: string) => void = () => {}): Promise<DemoResult> {
  const closers: Served[] = [];
  try {
    // ---- the hub ----
    const hub = new InMemoryHub(generateKeypair());
    const hubSrv = await serveHub(hub);
    closers.push(hubSrv);
    log(`hub          ${hub.id.slice(0, 24)}…  at ${hubSrv.url}`);

    // ---- reference agent 1: wordsmith (internals: a pure function) ----
    let wordsmithAgent: Agent | undefined;
    const wsInbox = await serveInbox(async (e: Envelope) => wordsmithAgent?.handleEnvelope(e));
    closers.push(wsInbox);
    const ws = createWordsmith(wsInbox.url);
    wordsmithAgent = ws.agent;
    ws.agent.connect(new HubClient(hubSrv.url));

    // ---- reference agent 2: kv-oracle (internals: a knowledge file, fs:read) ----
    let oracleAgent: Agent | undefined;
    const koInbox = await serveInbox(async (e: Envelope) => oracleAgent?.handleEnvelope(e));
    closers.push(koInbox);
    const knowledgePath = fileURLToPath(new URL("../data/knowledge.json", import.meta.url));
    const ko = createKvOracle(koInbox.url, knowledgePath);
    oracleAgent = ko.agent;
    ko.agent.connect(new HubClient(hubSrv.url));

    // ---- the requester: a person's own agent (no capabilities; it asks) ----
    const owner = generateKeypair();
    const key = generateKeypair();
    const requester = createAgent({
      manifest: createManifest(
        {
          id: key.id,
          name: "personal-agent",
          goal: { statement: "extend its person: get things done with other agents" },
          capabilities: [],
          endpoints: { inbox: "local:demo" },
          mandate: {
            spend: { perTask: 10, perMonth: 50, currency: "credit" },
            commit: ["task.post", "task.verify", "task.cancel", "msg.send"],
            reserved: [],
          },
          succession: { successors: [], frame: "sealed", continuation: "wound-down" },
        },
        owner,
      ),
      key,
      ownerKey: owner,
    });
    requester.connect(new HubClient(hubSrv.url)).attachLocal(hub);

    // ---- register + rule-stated grants ----
    await requester.register();
    await ws.agent.register();
    await ko.agent.register();
    hub.mint(owner.id, 100);
    hub.mint(ws.key.id, 10);
    hub.mint(ko.key.id, 10);
    log(`agents       personal-agent, wordsmith (pure fn), kv-oracle (knowledge file)`);
    log(`grants       owner 100 ¢r · wordsmith 10 ¢r · kv-oracle 10 ¢r`);

    const client = new HubClient(hubSrv.url);

    async function settleTask(opts: {
      cls: string;
      intent: string;
      input: Record<string, unknown>;
      expected: Record<string, unknown>;
      server: Agent;
      price: number;
      confidence: number;
    }): Promise<void> {
      const taskId = await requester.post({
        class: opts.cls,
        intent: opts.intent,
        input: opts.input,
        budget: { max: 8, currency: "credit" },
        verification: { mode: "deterministic", tests: { equals: opts.expected } },
      });
      log(`task.post    ${opts.cls}: "${opts.intent}" (escrow 8, deterministic)`);
      await opts.server.bid(taskId, { price: opts.price, capability: opts.cls, confidence: opts.confidence });
      const view = (await client.listTasks({ status: "open" })).find((t) => t.id === taskId)!;
      const bid = view.bids[0]!;
      log(`task.bid     ${opts.cls} ← price ${bid.body.price}, confidence ${bid.body.confidence} (stake ${(0.2 * bid.body.confidence * bid.body.price).toFixed(2)})`);
      await requester.award(taskId, "auto"); // delegate matching to the value-price router (spec 03 §6)
      // award → accept → handler → deliver → hub-run deterministic verify → settle
      for (let i = 0; i < 60; i++) {
        const t = hub.taskView(taskId);
        if (t.state === "settled" || t.state === "failed") {
          log(`settled      ${opts.cls}: ${t.report?.outcome} — payout ${t.report?.outcome === "accepted" ? bid.body.price : 0}, escrow remainder refunded`);
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`task ${opts.cls} did not settle in time`);
    }

    await settleTask({
      cls: "word_stats",
      intent: "how big is this text, and what does it dwell on?",
      input: { text: "value is created by gradients and value flows where attention goes" },
      expected: { words: 11, chars: 66, top: "value" },
      server: ws.agent,
      price: 3,
      confidence: 0.9,
    });

    await settleTask({
      cls: "fact_lookup",
      intent: "what is the definition of an agent?",
      input: { key: "agent.definition" },
      expected: { found: true, value: "an agent is an extension of a real person — in ability, in time, and in life" },
      server: ko.agent,
      price: 2,
      confidence: 0.95,
    });

    hub.assertConservation();
    const totals = hub.totals();
    log(`ledger       balances ${totals.balances} + escrowed ${totals.escrowed} + burned ${totals.burned} = minted ${totals.minted} ✓ conservation holds`);
    log(`balances     owner ${hub.balance(owner.id)} · wordsmith ${hub.balance(ws.key.id)} · kv-oracle ${hub.balance(ko.key.id)}`);

    return {
      settled: (await hub.listTasks({ status: "settled" })).length,
      wordsmithBalance: hub.balance(ws.key.id),
      oracleBalance: hub.balance(ko.key.id),
      requesterOwnerBalance: hub.balance(owner.id),
      burned: totals.burned,
    };
  } finally {
    for (const c of closers) await c.close();
  }
}

// CLI entry
if (process.argv[1] && /demo\.(js|ts)$/.test(process.argv[1])) {
  const result = await runDemo((line) => console.log(line));
  console.log(`\n${result.settled}/2 tasks settled between three separately-keyed agents with different internals.`);
}
