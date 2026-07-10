/**
 * THE ESCALATION MARKET — the flagship flow (DESIGN.md §7).
 *
 * A weak Macrokit-powered agent hits novelty it cannot serve. Instead of a
 * dead-end "needs authoring" banner, it posts an authoring task with budget.
 * A strong authoring agent — separately keyed, separately owned — delivers a
 * capability module. The hub verifies it against the requester's own cases
 * before a credit moves. The weak agent's owner approves the module's scopes,
 * it installs into the real Macrokit registry, and from then on the agent
 * serves that task class locally — and earns with it.
 *
 * Deliberation compiled into reflex, purchased across ownership boundaries.
 *
 * Run: pnpm demo
 */
import { z } from "zod";
import { defineMacro } from "@macrokit/authoring";
import { generateKeypair } from "@agentworld/identity";
import { InMemoryHub, type Artifact, type ModuleTestCase } from "@agentworld/protocol";
import { createAgent, type Agent } from "@agentworld/agent";
import { createManifest } from "@agentworld/protocol";
import {
  AUTHORING_CLASS,
  createAuthoringAgent,
  createMacrokitAgent,
  escalate,
  installIntoRegistry,
} from "./index.js";

export interface EscalationDemoResult {
  escalationSettled: boolean;
  installed: boolean;
  servesLocally: boolean;
  localAnswer: unknown;
  marketRoundSettled: boolean;
  weakAgentSpent: number;
  weakAgentEarned: number;
  authoringEarned: number;
}

const REVERSE_SOURCE = `export async function handler(input) {
  return { reversed: String(input.text).split(" ").reverse().join(" ") };
}`;

export async function runEscalationDemo(log: (line: string) => void = () => {}): Promise<EscalationDemoResult> {
  const hub = new InMemoryHub(generateKeypair());

  // ---- the weak agent: a real Macrokit project (registry + dispatcher) ----
  const weak = createMacrokitAgent({
    name: "pocket-agent",
    goal: "serve its person on a weak local model; buy the skills it lacks",
    macros: [
      defineMacro({
        name: "word_stats",
        intent: "count words and characters in a text",
        schema: z.object({ text: z.string() }),
        handler: async ({ text }) => ({ words: text.split(/\s+/).filter(Boolean).length, chars: text.length }),
        capabilities: [],
      }),
    ],
    spend: { perTask: 20, perMonth: 100 },
  });
  weak.agent.connect(hub).attachLocal(hub);

  // ---- the authoring agent: separately owned, strong at design time ----
  const authoring = createAuthoringAgent({
    solutions: [{ teaches: "reverse_words", source: REVERSE_SOURCE }],
    ask: 12,
  });
  authoring.agent.connect(hub).attachLocal(hub);

  await weak.agent.register();
  await authoring.agent.register();
  // Each agent's own operating account (spec 03 §1.2): posts escrow from it,
  // bids stake from it, earnings land in it.
  hub.mint(weak.key.id, 50);
  hub.mint(authoring.key.id, 20);
  log(`agents       pocket-agent (macrokit runtime, 1 macro) · authoring-agent (separately owned)`);
  log(`grants       pocket-agent 50 ¢r · authoring 20 ¢r`);

  // ---- 1. novelty: the person asks for something the agent cannot serve ----
  const ask = "reverse the words in 'life in time in ability'";
  log(`person asks  "${ask}"`);
  log(`pocket-agent serves reverse_words? ${weak.serves("reverse_words")} → escalate to the market`);

  const cases: ModuleTestCase[] = [
    { input: { text: "life in time in ability" }, expected: { reversed: "ability in time in life" } },
    { input: { text: "a b c" }, expected: { reversed: "c b a" } },
  ];
  const wanted = {
    name: "reverse_words",
    intent: "reverse the words of a text",
    input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    output: { type: "object", properties: { reversed: { type: "string" } } },
    scopes: [],
  };

  // capture the delivered module as it arrives
  let delivered: Extract<Artifact, { kind: "capability-module" }> | undefined;
  weak.agent.onMessage(async (env) => {
    if (env.type === "task.deliver") {
      const artifacts = env.body["artifacts"] as Artifact[];
      const mod = artifacts?.find((a) => a.kind === "capability-module");
      if (mod?.kind === "capability-module") delivered = mod;
    }
  });

  // ---- 2. escalation task: budget escrowed, cases are the verification ----
  const taskId = await escalate(weak, { wanted, cases, budget: 15 });
  log(`task.post    ${AUTHORING_CLASS}: budget 15 escrowed, verified by the requester's own ${cases.length} cases`);

  // ---- 3. the authoring agent appraises honestly, then bids ----
  const open = (await hub.listTasks({ status: "open" }))[0]!;
  const confidence = await authoring.appraise(open.body.input);
  if (confidence === null) throw new Error("authoring agent could not verify a solution — no bid");
  log(`task.bid     authoring-agent verified its solution locally first → confidence ${confidence}, price 12`);
  await authoring.agent.bid(taskId, { price: 12, capability: AUTHORING_CLASS, confidence });

  // ---- 4. award → deliver → hub runs the cases → settle ----
  await weak.agent.award(taskId, "auto");
  const escalationTask = hub.taskView(taskId);
  log(`settled      module passed ${JSON.stringify((escalationTask.report?.evidence as Record<string, unknown>)?.["passed"])}/${cases.length} cases → authoring-agent paid 12`);

  // ---- 5. the owner approves the module's scopes; it installs as a macro ----
  const install = await installIntoRegistry(weak, delivered!, ({ scopes, capability }) => {
    log(`install      owner approves scopes [${scopes.join(", ") || "none"}] for '${capability.name}' → yes`);
    return true;
  });

  // snapshot: what the skill cost, before it starts earning
  const afterBuy = hub.balance(weak.key.id);

  // ---- 6. the person asks again — served locally, through the dispatcher ----
  const local = await weak.dispatcher.dispatch({ tool: "reverse_words", args: { text: "life in time in ability" } });
  const localAnswer = local.ok ? local.value : local.error;
  log(`person asks  again → served LOCALLY by the purchased macro: ${JSON.stringify(localAnswer)}`);

  // ---- 7. and the skill earns: a stranger posts a reverse_words task ----
  const stranger = makeStranger(hub);
  await stranger.agent.register();
  hub.mint(stranger.agent.id, 20);
  const marketTask = await stranger.agent.post({
    class: "reverse_words",
    intent: "reverse these words",
    input: { text: "goes attention where flows value" },
    budget: { max: 5, currency: "credit" },
    verification: { mode: "deterministic", tests: { equals: { reversed: "value flows where attention goes" } } },
  });
  await weak.agent.bid(marketTask, { price: 2, capability: "reverse_words", confidence: 0.9 });
  await stranger.agent.award(marketTask, "auto");
  const marketSettled = hub.taskView(marketTask).state === "settled";
  log(`market       a stranger's reverse_words task → pocket-agent serves it → earned 2`);

  hub.assertConservation();
  const totals = hub.totals();
  log(`ledger       balances ${totals.balances} + escrowed ${totals.escrowed} + burned ${totals.burned} = minted ${totals.minted} ✓`);
  const finalWeak = hub.balance(weak.key.id);
  log(`balances     pocket-agent ${finalWeak} (bought the skill for ${50 - afterBuy}, earned ${finalWeak - afterBuy} serving it) · authoring ${hub.balance(authoring.key.id)}`);

  return {
    escalationSettled: escalationTask.state === "settled",
    installed: install.installed,
    servesLocally: weak.serves("reverse_words"),
    localAnswer,
    marketRoundSettled: marketSettled,
    weakAgentSpent: 50 - afterBuy, // paid for the authoring task
    weakAgentEarned: finalWeak - afterBuy, // earned back by serving the class
    authoringEarned: hub.balance(authoring.key.id) - 20,
  };
}

function makeStranger(hub: InMemoryHub): { agent: Agent; owner: ReturnType<typeof generateKeypair> } {
  const owner = generateKeypair();
  const key = generateKeypair();
  const agent = createAgent({
    manifest: createManifest(
      {
        id: key.id,
        name: "stranger",
        goal: { statement: "needs words reversed" },
        capabilities: [],
        endpoints: { inbox: "local:" },
        mandate: {
          spend: { perTask: 10, perMonth: 50, currency: "credit" },
          commit: ["task.post", "task.verify", "task.cancel", "msg.send"],
          reserved: [],
        },
        succession: { successors: [], continuation: "wound-down" },
      },
      owner,
    ),
    key,
    ownerKey: owner,
  });
  agent.connect(hub).attachLocal(hub);
  return { agent, owner };
}

// CLI entry
if (process.argv[1] && /demo\.(js|ts)$/.test(process.argv[1])) {
  const r = await runEscalationDemo((l) => console.log(l));
  console.log(
    `\nescalation settled: ${r.escalationSettled} · installed: ${r.installed} · serves locally: ${r.servesLocally} · market round: ${r.marketRoundSettled}`,
  );
}
