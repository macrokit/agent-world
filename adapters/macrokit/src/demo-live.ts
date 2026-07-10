/**
 * THE ESCALATION MARKET — live-hub mode.
 *
 * The same story as demo.ts, but against a REAL remote hub over HTTPS, the way
 * agents on laptops actually live: behind NAT with no reachable inbox. So the
 * flow is poll-driven — agents watch the task board instead of receiving
 * pushes, and the requester retrieves its purchased module from the settled
 * task view (spec 02 §3: delivery is best-effort; the view is the fallback).
 *
 * Nothing is minted manually: every agent funds itself from the hub's
 * rule-stated onboarding grant.
 *
 * Run:  pnpm demo:live                 (defaults to https://hub.macrokit.dev)
 *       AW_HUB=http://... pnpm demo:live
 */
import { z } from "zod";
import { defineMacro } from "@macrokit/authoring";
import { generateKeypair } from "@agentworld/identity";
import {
  createEnvelope,
  createManifest,
  HubClient,
  type Artifact,
  type ModuleTestCase,
  type TaskView,
} from "@agentworld/protocol";
import { createAgent } from "@agentworld/agent";
import {
  AUTHORING_CLASS,
  createAuthoringAgent,
  createMacrokitAgent,
  escalate,
  installIntoRegistry,
} from "./index.js";

const REVERSE_SOURCE = `export async function handler(input) {
  return { reversed: String(input.text).split(" ").reverse().join(" ") };
}`;

export interface LiveDemoResult {
  hub: string;
  escalationSettled: boolean;
  installed: boolean;
  servesLocally: boolean;
  localAnswer: unknown;
  marketRoundSettled: boolean;
  weakBalance: number;
  authoringBalance: number;
  conservationHolds: boolean;
}

async function pollTask(
  client: HubClient,
  taskId: string,
  until: (t: TaskView) => boolean,
  label: string,
  attempts = 40,
): Promise<TaskView> {
  for (let i = 0; i < attempts; i++) {
    const all = await client.listTasks();
    const t = all.find((x) => x.id === taskId);
    if (t && until(t)) return t;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function balances(hubUrl: string): Promise<Map<string, number>> {
  const obs = (await (await fetch(`${hubUrl.replace(/\/$/, "")}/aw/v0/observatory`)).json()) as {
    agents: Array<{ id: string; balance: number }>;
    totals: { minted: number; balances: number; escrowed: number; burned: number };
  };
  const m = new Map(obs.agents.map((a) => [a.id, a.balance]));
  m.set("__conservation__", Math.abs(obs.totals.balances + obs.totals.escrowed + obs.totals.burned - obs.totals.minted) < 1e-6 ? 1 : 0);
  return m;
}

export async function runLiveEscalationDemo(
  hubUrl: string,
  log: (line: string) => void = () => {},
): Promise<LiveDemoResult> {
  const client = new HubClient(hubUrl);
  log(`hub          ${hubUrl}`);

  // ---- the weak agent: a real Macrokit project, inbox honestly unreachable ----
  const weak = createMacrokitAgent({
    name: "pocket-agent-live",
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
    inboxUrl: "local:unreachable-laptop",
    spend: { perTask: 20, perMonth: 100 },
  });
  weak.agent.connect(new HubClient(hubUrl));

  // ---- the authoring agent: separately owned, also behind NAT ----
  const authoring = createAuthoringAgent({
    name: "authoring-agent-live",
    inboxUrl: "local:unreachable-workstation",
    solutions: [{ teaches: "reverse_words", source: REVERSE_SOURCE }],
    ask: 12,
  });
  authoring.agent.connect(new HubClient(hubUrl));

  // ---- register: both self-fund from the rule-stated onboarding grant ----
  await weak.agent.register();
  await authoring.agent.register();
  let bal = await balances(hubUrl);
  log(`onboarding   pocket-agent ${bal.get(weak.key.id)} ¢r · authoring ${bal.get(authoring.key.id)} ¢r — no manual minting`);

  // ---- 1. novelty → escalation task ----
  log(`person asks  "reverse the words in 'life in time in ability'"`);
  log(`serves reverse_words? ${weak.serves("reverse_words")} → escalate to the market`);
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
  const taskId = await escalate(weak, { wanted, cases, budget: 15 });
  log(`task.post    ${AUTHORING_CLASS} (budget 15 escrowed; verified by the requester's own cases)`);

  // ---- 2. the authoring agent POLLS the board, appraises, bids ----
  const open = await pollTask(client, taskId, (t) => t.state === "open", "task on the board");
  const confidence = await authoring.appraise(open.body.input);
  if (confidence === null) throw new Error("authoring agent could not verify a solution — no bid");
  await authoring.agent.bid(taskId, { price: 12, capability: AUTHORING_CLASS, confidence });
  log(`task.bid     authoring verified its solution locally first → confidence ${confidence}, price 12`);

  // ---- 3. the weak agent awards (value-price router) ----
  await pollTask(client, taskId, (t) => t.bids.length > 0, "bid to arrive");
  await weak.agent.award(taskId, "auto");

  // ---- 4. authoring agent polls, sees it won, serves: accept → deliver ----
  const awarded = await pollTask(client, taskId, (t) => t.award?.server === authoring.key.id, "award");
  await client.send(createEnvelope("task.accept", authoring.key, {}, { task: taskId }));
  const artifact = (await authoring.solve(awarded.body.input))!;
  await client.send(
    createEnvelope("task.deliver", authoring.key, { artifacts: [artifact] as unknown as Record<string, unknown>[] }, { task: taskId }),
  );

  // ---- 5. the hub runs the cases and settles; requester fetches the module ----
  const settled = await pollTask(client, taskId, (t) => t.state === "settled" || t.state === "failed", "settlement");
  const evidence = settled.report?.evidence as { passed?: number; total?: number } | undefined;
  log(
    `settled      ${settled.report?.outcome} — the hub ran the module against ${evidence?.passed ?? "?"}/${evidence?.total ?? "?"} cases → authoring-agent paid 12`,
  );
  const delivered = settled.artifacts?.find((a) => a.kind === "capability-module") as
    | Extract<Artifact, { kind: "capability-module" }>
    | undefined;
  if (!delivered) throw new Error("settled task carries no capability module");

  // ---- 6. owner-gated install into the real Macrokit registry ----
  const install = await installIntoRegistry(weak, delivered, ({ scopes, capability }) => {
    log(`install      owner approves scopes [${scopes.join(", ") || "none"}] for '${capability.name}' → yes`);
    return true;
  });

  // ---- 7. served locally, forever after ----
  const local = await weak.dispatcher.dispatch({ tool: "reverse_words", args: { text: "life in time in ability" } });
  const localAnswer = local.ok ? local.value : local.error;
  log(`person asks  again → served LOCALLY: ${JSON.stringify(localAnswer)}`);

  // ---- 8. and the purchased skill EARNS: a stranger registers (self-funds
  //         from onboarding) and hires the pocket-agent ----
  const strangerOwner = generateKeypair();
  const strangerKey = generateKeypair();
  const stranger = createAgent({
    manifest: createManifest(
      {
        id: strangerKey.id,
        name: "stranger-live",
        goal: { statement: "needs words reversed" },
        capabilities: [],
        endpoints: { inbox: "local:unreachable-phone" },
        mandate: {
          spend: { perTask: 10, perMonth: 50, currency: "credit" },
          commit: ["task.post", "task.verify", "task.cancel", "msg.send"],
          reserved: [],
        },
        succession: { successors: [], continuation: "wound-down" },
      },
      strangerOwner,
    ),
    key: strangerKey,
    ownerKey: strangerOwner,
  });
  stranger.connect(new HubClient(hubUrl));
  await stranger.register();
  const marketTask = await stranger.post({
    class: "reverse_words",
    intent: "reverse these words",
    input: { text: "goes attention where flows value" },
    budget: { max: 5, currency: "credit" },
    verification: { mode: "deterministic", tests: { equals: { reversed: "value flows where attention goes" } } },
  });
  await pollTask(client, marketTask, (t) => t.state === "open", "market task");
  await weak.agent.bid(marketTask, { price: 2, capability: "reverse_words", confidence: 0.9 });
  await pollTask(client, marketTask, (t) => t.bids.length > 0, "market bid");
  await stranger.award(marketTask, "auto");
  await pollTask(client, marketTask, (t) => t.award?.server === weak.key.id, "market award");
  const answer = await weak.agent.invoke("reverse_words", { text: "goes attention where flows value" });
  await client.send(
    createEnvelope("task.deliver", weak.key, { artifacts: [{ kind: "inline", data: answer }] }, { task: marketTask }),
  );
  const marketSettled = await pollTask(client, marketTask, (t) => t.state === "settled" || t.state === "failed", "market settlement");
  log(`market       pocket-agent serves reverse_words for a stranger → ${marketSettled.state}`);

  // ---- ledger truth from the live observatory ----
  bal = await balances(hubUrl);
  const weakBal = bal.get(weak.key.id) ?? 0;
  const authBal = bal.get(authoring.key.id) ?? 0;
  const conservationHolds = bal.get("__conservation__") === 1;
  log(`balances     pocket-agent ${weakBal} (100 − 12 skill + 2 earned) · authoring ${authBal} (100 + 12 sold) · stranger ${bal.get(strangerKey.id)} (100 − 2 hired)`);
  log(`conservation ${conservationHolds ? "holds ✓" : "VIOLATED ✗"} (from the live ledger)`);

  return {
    hub: hubUrl,
    escalationSettled: settled.state === "settled",
    installed: install.installed,
    servesLocally: weak.serves("reverse_words"),
    localAnswer,
    marketRoundSettled: marketSettled.state === "settled",
    weakBalance: weakBal,
    authoringBalance: authBal,
    conservationHolds,
  };
}

// CLI entry
if (process.argv[1] && /demo-live\.(js|ts)$/.test(process.argv[1])) {
  const hub = process.env["AW_HUB"] ?? "https://hub.macrokit.dev";
  const r = await runLiveEscalationDemo(hub, (l) => console.log(l));
  console.log(
    `\nescalation: ${r.escalationSettled} · installed: ${r.installed} · serves locally: ${r.servesLocally} · market round: ${r.marketRoundSettled} · conservation: ${r.conservationHolds}`,
  );
}
