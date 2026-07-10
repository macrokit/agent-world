/**
 * @agentworld/adapter-macrokit — the bridge between the two estates.
 *
 * Macrokit standardizes what happens INSIDE one agent (macros, deterministic
 * dispatch, capability-declared tool surfaces). Agent World standardizes the
 * boundary BETWEEN agents. This adapter is the thin 1:1 projection the
 * founding design predicted (DESIGN.md §7):
 *
 *   macro           → capability declaration
 *   dispatcher      → capability handler (with real D-017 enforcement)
 *   "needs authoring — send back to the authoring machine"
 *                   → an authoring task on the market (the escalation market)
 *   delivered module → a new macro in the registry (purchased reflex)
 *
 * agent-world/core stays macrokit-free; this package is where the two meet.
 */
import { Dispatcher, MacroRegistry, SessionLog, type Macro } from "@macrokit/runtime";
import type { AuthoredMacro } from "@macrokit/authoring";
import { generateKeypair, type Keypair } from "@agentworld/identity";
import {
  buildHandlerModule,
  createManifest,
  runModuleCases,
  type Artifact,
  type Capability,
  type Manifest,
  type ModuleTestCase,
} from "@agentworld/protocol";
import { createAgent, type Agent, type CapabilityHandler } from "@agentworld/agent";

/** The market task class an escalation posts, and authoring agents declare. */
export const AUTHORING_CLASS = "macro_authoring";

// ---------------------------------------------------------------------------
// macro → capability projection
// ---------------------------------------------------------------------------

/** Any macro shape defineMacro produces (generics erased — the adapter treats macros uniformly). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMacro = Macro<any, any> | AuthoredMacro<any, any>;

/** A Macrokit macro projects 1:1 onto an Agent World capability declaration. */
export function macroToCapability(macro: AnyMacro, opts?: { ask?: number }): Capability {
  const jsonSchema = (macro.schema as { jsonSchema?: Record<string, unknown> }).jsonSchema;
  return {
    name: macro.name,
    intent: macro.intent,
    input: jsonSchema ?? { type: "object" },
    output: { type: "object" },
    // D-017 tool-surface declarations become x- scopes the buyer can judge
    scopes: (macro.capabilities ?? []).map((k) => `x-tool-${k.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`),
    ...(opts?.ask !== undefined ? { pricing: { ask: opts.ask, currency: "credit" as const } } : {}),
    verification: ["deterministic", "requester"],
  };
}

// ---------------------------------------------------------------------------
// wrap a Macrokit project as an Agent World agent
// ---------------------------------------------------------------------------

export interface MacrokitAgentOptions {
  name: string;
  goal: string;
  macros: AnyMacro[];
  /** tool surfaces wired into the dispatcher (ctx.tools) */
  tools?: Record<string, unknown>;
  inboxUrl?: string;
  /** per-macro asking prices */
  asks?: Record<string, number>;
  /** perTask/perMonth spend the owner mandates (escalation budgets draw on this) */
  spend?: { perTask: number; perMonth: number };
}

export interface MacrokitAgent {
  agent: Agent;
  owner: Keypair;
  key: Keypair;
  registry: MacroRegistry;
  dispatcher: Dispatcher;
  sessionLog: SessionLog;
  /** true iff a registered macro serves this capability name */
  serves(name: string): boolean;
}

export function createMacrokitAgent(opts: MacrokitAgentOptions): MacrokitAgent {
  const owner = generateKeypair();
  const key = generateKeypair();
  const sessionLog = new SessionLog();
  const registry = new MacroRegistry();
  for (const m of opts.macros) registry.register(m as Macro);
  const dispatcher = new Dispatcher({ registry, log: sessionLog, toolSurfaces: opts.tools ?? {} });

  const manifest: Manifest = createManifest(
    {
      id: key.id,
      name: opts.name,
      goal: { statement: opts.goal },
      capabilities: opts.macros.map((m) => macroToCapability(m, { ask: opts.asks?.[m.name] })),
      endpoints: { inbox: opts.inboxUrl ?? "local:" },
      mandate: {
        spend: { perTask: opts.spend?.perTask ?? 20, perMonth: opts.spend?.perMonth ?? 100, currency: "credit" },
        commit: ["task.post", "task.bid", "task.accept", "task.deliver", "task.verify", "task.cancel", "msg.send"],
        reserved: [],
      },
      succession: { successors: [], frame: "sealed", continuation: "wound-down" },
    },
    owner,
  );

  const agent = createAgent({ manifest, key, ownerKey: owner });
  for (const m of opts.macros) {
    agent.capability(m.name, dispatchHandler(dispatcher, m.name));
  }

  return {
    agent,
    owner,
    key,
    registry,
    dispatcher,
    sessionLog,
    serves: (name) => registry.lookup(name) !== undefined,
  };
}

/** Serve a capability through the REAL Macrokit dispatcher (D-017 enforced). */
function dispatchHandler(dispatcher: Dispatcher, tool: string): CapabilityHandler {
  return async (input) => {
    const result = await dispatcher.dispatch({ tool, args: input });
    if (!result.ok) {
      throw new Error(`${result.error.code}: ${result.error.message}`);
    }
    const v = result.value;
    return (v && typeof v === "object" && !Array.isArray(v) ? v : { result: v }) as Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// escalation — "needs authoring" becomes a market task
// ---------------------------------------------------------------------------

export interface EscalationRequest {
  /** the capability the agent wants to be taught */
  wanted: Capability;
  /** deterministic io examples the delivered module must pass (spec 02 §8.3) */
  cases: ModuleTestCase[];
  budget: number;
  intent?: string;
}

/**
 * Post an authoring task: the aw form of Macrokit's "needs authoring — send
 * back to the authoring machine" banner. Deterministic verification with the
 * requester's own cases; the deliverable is a capability module.
 */
export async function escalate(mk: MacrokitAgent, req: EscalationRequest): Promise<string> {
  return mk.agent.post({
    class: AUTHORING_CLASS,
    intent: req.intent ?? `author a capability: ${req.wanted.intent}`,
    input: { wanted: req.wanted as unknown as Record<string, unknown>, cases: req.cases as unknown as Record<string, unknown>[] } as Record<string, unknown>,
    budget: { max: req.budget, currency: "credit" },
    verification: { mode: "deterministic", tests: { cases: req.cases as unknown as Record<string, unknown>[] } as unknown as Record<string, unknown> },
  });
}

/**
 * Install a purchased module INTO the Macrokit registry — deliberation
 * compiled into reflex, bought across ownership boundaries. The module
 * becomes a real macro (permissive schema, empty tool-surface declaration:
 * an aw-handler module is self-contained by construction), and the aw
 * capability handler routes through the dispatcher like any native macro.
 */
export async function installIntoRegistry(
  mk: MacrokitAgent,
  artifact: Extract<Artifact, { kind: "capability-module" }>,
  approve: (info: { scopes: string[]; capability: Capability }) => boolean | Promise<boolean>,
): Promise<{ installed: boolean }> {
  return mk.agent.installModule(artifact, {
    approve,
    bind: (raw) => {
      const macro: Macro = {
        name: artifact.capability.name,
        intent: artifact.capability.intent,
        schema: { parse: (x: unknown) => x },
        handler: async (args) => raw(args as Record<string, unknown>),
        capabilities: [], // self-contained: touches no tool surfaces (dispatcher-enforced)
      };
      mk.registry.register(macro);
      return dispatchHandler(mk.dispatcher, macro.name);
    },
  });
}

// ---------------------------------------------------------------------------
// a reference authoring agent (the strong side of the escalation market)
// ---------------------------------------------------------------------------

export interface AuthoringSolution {
  /** capability names this solution can teach */
  teaches: string;
  /** self-contained aw-handler/0.1 module source */
  source: string;
}

export interface AuthoringAgentOptions {
  name?: string;
  inboxUrl?: string;
  /**
   * The solution library. In production this is where the strong model
   * (design-time deliberation) plugs in; the reference agent authors from
   * a curated library and NEVER ships a solution it has not verified
   * against the requester's cases locally first.
   */
  solutions: AuthoringSolution[];
  ask?: number;
}

export function createAuthoringAgent(opts: AuthoringAgentOptions): {
  agent: Agent;
  owner: Keypair;
  key: Keypair;
  /** validate a posted authoring task locally; returns a bid confidence or null */
  appraise(input: Record<string, unknown>): Promise<number | null>;
  /** author the module for a task input (locally verified) — poll-driven flows deliver this themselves */
  solve(input: Record<string, unknown>): Promise<Extract<Artifact, { kind: "capability-module" }> | null>;
} {
  const owner = generateKeypair();
  const key = generateKeypair();
  const manifest = createManifest(
    {
      id: key.id,
      name: opts.name ?? "authoring-agent",
      goal: { statement: "compile deliberation into reflexes others can own" },
      capabilities: [
        {
          name: AUTHORING_CLASS,
          intent: "author a self-contained capability module that passes the requester's cases",
          input: { type: "object", properties: { wanted: { type: "object" }, cases: { type: "array" } } },
          output: { type: "object" },
          scopes: [],
          pricing: { ask: opts.ask ?? 15, currency: "credit" },
          verification: ["deterministic"],
        },
      ],
      endpoints: { inbox: opts.inboxUrl ?? "local:" },
      mandate: {
        spend: { perTask: 0, perMonth: 0, currency: "credit" },
        commit: ["task.bid", "task.accept", "task.deliver"],
        reserved: [],
      },
      succession: { successors: [], frame: "sealed", continuation: "wound-down" },
    },
    owner,
  );
  const agent = createAgent({ manifest, key, ownerKey: owner });

  async function solve(input: Record<string, unknown>): Promise<Extract<Artifact, { kind: "capability-module" }> | null> {
    const wanted = input["wanted"] as Capability | undefined;
    const cases = input["cases"] as ModuleTestCase[] | undefined;
    if (!wanted || !cases?.length) return null;
    for (const s of opts.solutions) {
      if (s.teaches !== wanted.name) continue;
      const artifact = buildHandlerModule({ source: s.source, capability: wanted, cases });
      const check = await runModuleCases(artifact, cases); // due diligence BEFORE shipping
      if (check.passed === check.total) return artifact;
    }
    return null;
  }

  agent.capability(AUTHORING_CLASS, async (input) => {
    const artifact = await solve(input);
    if (!artifact) throw new Error("cannot author this capability honestly — no verified solution");
    return [artifact];
  });

  return {
    agent,
    owner,
    key,
    // Appraisal = the honest-confidence mechanism: verified locally → high
    // confidence (and a big stake it can afford); unverifiable → don't bid.
    appraise: async (input) => ((await solve(input)) ? 0.95 : null),
    solve,
  };
}
