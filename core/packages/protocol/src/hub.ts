import { createHash } from "node:crypto";
import { canonicalize, type Keypair } from "@agentworld/identity";
import { runModuleCases, type ModuleTestCase } from "./module.js";
import { groupScores, routeValuePrice, scoreFor, type CapabilityScore } from "@agentworld/value";
import { createEnvelope, verifyEnvelope, EnvelopeError } from "./envelope.js";
import { verifyManifestChain, ManifestError } from "./manifest.js";
import { transition, TERMINAL_STATES } from "./task.js";
import {
  artifactSchema,
  bidBodySchema,
  manifestSchema,
  taskBodySchema,
  verificationReportSchema,
  type Artifact,
  type BidBody,
  type Envelope,
  type Manifest,
  type TaskBody,
  type TaskState,
  type VerificationReport,
} from "./types.js";

export class HubError extends Error {
  constructor(
    public code: "invalid" | "unauthorized" | "duplicate" | "rejected",
    message: string,
  ) {
    super(message);
  }
}

export interface Bid {
  envelope: Envelope;
  body: BidBody;
}

export interface TaskRecord {
  id: string;
  requester: string;
  body: TaskBody;
  state: TaskState;
  escrow: number;
  bids: Map<string, Bid>;
  award?: { bidId: string; server: string; price: number; confidence: number; stake: number };
  accepted: boolean;
  artifacts?: Artifact[];
  report?: VerificationReport;
}

export interface OutcomeSample {
  server: string;
  class: string;
  mode: string;
  outcome: "accepted" | "partial" | "rejected";
  quality?: number;
  categories?: { expected: string; delivered: string };
}

export interface TaskView {
  id: string;
  state: TaskState;
  requester: string;
  body: TaskBody;
  bids: Array<{ id: string; from: string; body: BidBody }>;
  award?: TaskRecord["award"];
  report?: VerificationReport;
  /**
   * Delivered artifacts. Exposed in the view so a requester whose inbox was
   * unreachable at delivery time can still fetch what it paid for (spec 02 §3
   * delivery is best-effort). v0 tasks are public end-to-end, so this leaks
   * nothing the deliver envelope didn't; task-scoped access control arrives
   * with private tasks.
   */
  artifacts?: Artifact[];
}

/** Transport-agnostic hub surface; implemented by InMemoryHub and HubClient. */
export interface HubLike {
  send(envelope: Envelope): Promise<void>;
  listTasks(query?: { status?: TaskState; class?: string }): Promise<TaskView[]>;
  searchAgents(query?: { capability?: string }): Promise<Manifest[][]>;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * The reference hub (spec 02 §1, 03): registry, market, escrow ledger,
 * settlement, message relay. In-memory state; the HTTP binding wraps it
 * (see http.ts). Deliberately v0: no router (requester awards), no fees,
 * no kill fee, no bid/accept windows enforced.
 */
export class InMemoryHub implements HubLike {
  /** stake = κ · confidence · price (spec 03 §3.2) */
  readonly kappa: number;
  /** published ε-exploration probability of the default router (spec 03 §6.3) */
  readonly epsilon: number;
  /** below this sample count a bidder is an exploration candidate */
  readonly minSamples: number;
  /** contest window for guardian+hub succession (spec 01 §6.4; default 30 days) */
  readonly contestWindowMs: number;

  private key: Keypair;
  private balances = new Map<string, number>();
  private minted = 0;
  private burned = 0;
  private monthSpend = new Map<string, Map<string, number>>();
  private registry = new Map<string, Manifest[]>();
  private seen = new Set<string>();
  private tasks = new Map<string, TaskRecord>();
  private inboxes = new Map<string, (env: Envelope) => Promise<void>>();
  /** Outcome samples per settlement (spec 03 §4.3) — Phase-2 scores read these. */
  readonly samples: OutcomeSample[] = [];
  /** Failed inbox deliveries (best-effort transport; spec 02 §3 retry is v1). */
  readonly deliveryFailures: Array<{ to: string; envelope: string; error: string }> = [];
  private replaying = false;

  constructor(
    key: Keypair,
    opts?: { kappa?: number; epsilon?: number; minSamples?: number; random?: () => number; contestWindowMs?: number },
  ) {
    this.key = key;
    this.kappa = opts?.kappa ?? 0.2;
    this.epsilon = opts?.epsilon ?? 0.1;
    this.minSamples = opts?.minSamples ?? 5;
    this.contestWindowMs = opts?.contestWindowMs ?? 30 * 24 * 60 * 60 * 1000;
    this.randomOverride = opts?.random;
  }

  /** Recorded death/incapacity attestations, per agent (spec 01 §6.1). */
  private attestations = new Map<string, { id: string; ts: string; guardian: string; contested: boolean }>();
  /** Public misconduct flags (e.g. a contested attestation flags the guardian). */
  readonly flags: Array<{ subject: string; reason: string; ref: string }> = [];

  attestationFor(agentId: string): { id: string; ts: string; guardian: string; contested: boolean } | undefined {
    return this.attestations.get(agentId);
  }

  private randomOverride?: () => number;

  /**
   * Router randomness must be a deterministic function of the (secret) hub key
   * and the award envelope — journal replay re-runs the router and MUST
   * reproduce the original decision. Keyed hashing keeps it unpredictable to
   * bidders while replay-stable. Tests may inject `random` instead.
   */
  private randomFor(envelopeId: string): () => number {
    if (this.randomOverride) return this.randomOverride;
    const secret = this.key.privateKey.export({ type: "pkcs8", format: "der" });
    let counter = 0;
    return () => {
      const h = createHash("sha256").update(secret).update(envelopeId).update(String(counter++)).digest();
      return h.readUIntBE(0, 6) / 2 ** 48;
    };
  }

  /**
   * Capability scores (spec 03 §5): per (agent, class) only, with `n`
   * published — never a cross-agent aggregate (prohibitions P1/P2).
   */
  scores(): CapabilityScore[] {
    return groupScores(this.samples);
  }

  get id(): string {
    return this.key.id;
  }

  // ---- ledger (spec 03 §1–2) ----

  /** Rule-stated minting only (spec 03 §2.3); the rule is the caller's policy. */
  mint(account: string, amount: number): void {
    if (amount <= 0) throw new HubError("invalid", "mint amount must be positive");
    this.balances.set(account, round(this.balance(account) + amount));
    this.minted = round(this.minted + amount);
  }

  balance(account: string): number {
    return this.balances.get(account) ?? 0;
  }

  /** Conservation invariant (spec 03 §2.2). Throws if violated. */
  assertConservation(): void {
    let escrowed = 0;
    for (const t of this.tasks.values()) {
      if (!TERMINAL_STATES.has(t.state)) {
        escrowed = round(escrowed + t.escrow + (t.award?.stake ?? 0));
      }
    }
    const balances = round([...this.balances.values()].reduce((a, b) => a + b, 0));
    const total = round(balances + escrowed + this.burned);
    if (Math.abs(total - this.minted) > 1e-6) {
      throw new HubError("invalid", `conservation violated: ${total} !== minted ${this.minted}`);
    }
  }

  totals(): { minted: number; burned: number; balances: number; escrowed: number } {
    let escrowed = 0;
    for (const t of this.tasks.values()) {
      if (!TERMINAL_STATES.has(t.state)) escrowed = round(escrowed + t.escrow + (t.award?.stake ?? 0));
    }
    const balances = round([...this.balances.values()].reduce((a, b) => a + b, 0));
    return { minted: this.minted, burned: this.burned, balances, escrowed };
  }

  private debit(account: string, amount: number, what: string): void {
    if (this.balance(account) < amount) {
      throw new HubError("rejected", `insufficient balance for ${what}: ${account} has ${this.balance(account)}, needs ${amount}`);
    }
    this.balances.set(account, round(this.balance(account) - amount));
  }

  private credit(account: string, amount: number): void {
    if (amount === 0) return;
    this.balances.set(account, round(this.balance(account) + amount));
  }

  private burn(amount: number): void {
    this.burned = round(this.burned + amount);
  }

  // ---- registry ----

  manifestOf(agentId: string): Manifest {
    const chain = this.registry.get(agentId);
    if (!chain) throw new HubError("rejected", `unknown agent: ${agentId}`);
    return chain[chain.length - 1]!;
  }

  chainOf(agentId: string): Manifest[] {
    const chain = this.registry.get(agentId);
    if (!chain) throw new HubError("rejected", `unknown agent: ${agentId}`);
    return chain;
  }

  async searchAgents(query?: { capability?: string }): Promise<Manifest[][]> {
    const out: Manifest[][] = [];
    for (const chain of this.registry.values()) {
      const head = chain[chain.length - 1]!;
      if (!query?.capability || head.capabilities.some((c) => c.name === query.capability)) {
        out.push(chain);
      }
    }
    return out;
  }

  // ---- market ----

  async listTasks(query?: { status?: TaskState; class?: string }): Promise<TaskView[]> {
    const out: TaskView[] = [];
    for (const t of this.tasks.values()) {
      if (query?.status && t.state !== query.status) continue;
      if (query?.class && t.body.class !== query.class) continue;
      out.push(this.view(t));
    }
    return out;
  }

  taskView(taskId: string): TaskView {
    const t = this.tasks.get(taskId);
    if (!t) throw new HubError("rejected", `unknown task: ${taskId}`);
    return this.view(t);
  }

  private view(t: TaskRecord): TaskView {
    return {
      id: t.id,
      state: t.state,
      requester: t.requester,
      body: t.body,
      bids: [...t.bids.entries()].map(([id, b]) => ({ id, from: b.envelope.from, body: b.body })),
      award: t.award,
      report: t.report,
      ...(t.artifacts ? { artifacts: t.artifacts } : {}),
    };
  }

  // ---- transport ----

  /** Local inbox registration (in-process agents / tests). HTTP inboxes are fetched. */
  registerInbox(agentId: string, handler: (env: Envelope) => Promise<void>): void {
    this.inboxes.set(agentId, handler);
  }

  /**
   * Best-effort delivery: an unknown recipient is a protocol error, but a
   * failing/offline inbox never wedges hub state (spec 02 §3 makes retries a
   * hub duty; v0 records the failure instead). Replay never re-delivers.
   */
  private async deliver(agentId: string, env: Envelope): Promise<void> {
    const manifest = this.manifestOf(agentId); // throws for unknown agents
    if (this.replaying) return;
    try {
      const local = this.inboxes.get(agentId);
      if (local) {
        await local(env);
        return;
      }
      const inbox = manifest.endpoints.inbox;
      if (!/^https?:/.test(inbox)) throw new Error(`no reachable inbox: ${inbox}`);
      const res = await fetch(inbox, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(env),
      });
      if (!res.ok) throw new Error(`inbox returned ${res.status}`);
    } catch (e) {
      this.deliveryFailures.push({ to: agentId, envelope: env.id, error: String(e) });
    }
  }

  // ---- the protocol ----

  async send(raw: unknown): Promise<void> {
    await this.handle(raw);
  }

  /** `replay: true` — journal recovery: signatures verified, freshness waived, no re-delivery. */
  async handle(raw: unknown, opts?: { replay?: boolean }): Promise<void> {
    if (opts?.replay) {
      this.replaying = true;
      try {
        return await this.handleVerified(raw, true);
      } finally {
        this.replaying = false;
      }
    }
    return this.handleVerified(raw, false);
  }

  private async handleVerified(raw: unknown, replay: boolean): Promise<void> {
    let env: Envelope;
    try {
      env = verifyEnvelope(raw, { skipFreshness: replay });
    } catch (e) {
      if (e instanceof EnvelopeError) {
        throw new HubError(e.code === "unauthorized" ? "unauthorized" : "invalid", e.message);
      }
      throw e;
    }
    if (this.seen.has(env.id)) throw new HubError("duplicate", `duplicate envelope: ${env.id}`);
    this.seen.add(env.id);

    switch (env.type) {
      case "manifest.publish":
        return this.onManifestPublish(env);
      case "task.post":
        return this.onTaskPost(env);
      case "task.bid":
        return this.onTaskBid(env);
      case "task.award":
        return this.onTaskAward(env);
      case "task.accept":
        return this.onTaskAccept(env);
      case "task.deliver":
        return this.onTaskDeliver(env);
      case "task.verify":
        return this.onTaskVerify(env);
      case "task.cancel":
        return this.onTaskCancel(env);
      case "msg.send":
        return this.onMsgSend(env);
      case "succession.attest":
        return this.onSuccessionAttest(env);
      case "succession.contest":
        return this.onSuccessionContest(env);
      default:
        throw new HubError("rejected", `unsupported envelope type: ${env.type}`);
    }
  }

  /** Mandate check (spec 01 §5.1) for an agent's owner-committing act. */
  private requireMandate(agentId: string, type: string): Manifest {
    const head = this.manifestOf(agentId);
    if (!(head.mandate.commit as string[]).includes(type)) {
      throw new HubError("unauthorized", `act '${type}' is outside ${agentId}'s mandate`);
    }
    return head;
  }

  private onManifestPublish(env: Envelope): void {
    const parsed = manifestSchema.safeParse(env.body["manifest"]);
    if (!parsed.success) throw new HubError("invalid", `invalid manifest: ${parsed.error.message}`);
    const manifest = env.body["manifest"] as Manifest;
    if (env.from !== manifest.owner) {
      throw new HubError("unauthorized", "manifest.publish must come from the manifest owner");
    }
    const existing = this.registry.get(manifest.id) ?? [];

    // Succession policy (spec 01 §6): an owner change needs a recorded,
    // uncontested attestation — and, in guardian+hub mode, an elapsed contest
    // window. Timing compares envelope timestamps (attest → publish), never
    // wall-clock, so journal replay reproduces the decision.
    const head = existing[existing.length - 1];
    if (head && manifest.owner !== head.owner) {
      const attestation = this.attestations.get(manifest.id);
      if (!attestation || attestation.id !== manifest.attestation) {
        throw new HubError("rejected", "succession requires a recorded attestation for this agent");
      }
      if (attestation.contested) {
        throw new HubError("rejected", "the attestation was contested by the owner (spec 01 §6.4)");
      }
      const mode = head.succession.attestation ?? "guardian+hub";
      if (mode === "m-of-n") throw new HubError("rejected", "m-of-n attestation is not supported in v0");
      if (mode === "guardian+hub") {
        const elapsed = new Date(env.ts).getTime() - new Date(attestation.ts).getTime();
        if (elapsed < this.contestWindowMs) {
          throw new HubError(
            "rejected",
            `contest window not elapsed: ${Math.ceil((this.contestWindowMs - elapsed) / 1000)}s remain (spec 01 §6.4)`,
          );
        }
      }
    }

    const candidate = [...existing, manifest];
    try {
      verifyManifestChain(candidate);
    } catch (e) {
      if (e instanceof ManifestError) throw new HubError("rejected", e.message);
      throw e;
    }
    this.registry.set(manifest.id, candidate);
  }

  /** Guardian attests the principal's death/incapacity (spec 01 §6.1). */
  private onSuccessionAttest(env: Envelope): void {
    const agentId = env.body["agent"];
    if (typeof agentId !== "string") throw new HubError("invalid", "succession.attest requires body.agent");
    const head = this.manifestOf(agentId);
    if (head.succession.guardian !== env.from) {
      throw new HubError("unauthorized", "only the designated guardian may attest (spec 01 §6.1)");
    }
    const existing = this.attestations.get(agentId);
    if (existing && !existing.contested) {
      throw new HubError("rejected", "an uncontested attestation is already recorded");
    }
    this.attestations.set(agentId, { id: env.id, ts: env.ts, guardian: env.from, contested: false });
  }

  /** A live owner cancels an attestation — the ultimate liveness proof (spec 01 §6.4). */
  private onSuccessionContest(env: Envelope): void {
    const agentId = env.body["agent"];
    if (typeof agentId !== "string") throw new HubError("invalid", "succession.contest requires body.agent");
    const head = this.manifestOf(agentId);
    if (head.owner !== env.from) {
      throw new HubError("unauthorized", "only the current owner may contest an attestation");
    }
    const attestation = this.attestations.get(agentId);
    if (!attestation || attestation.contested) {
      throw new HubError("rejected", "no active attestation to contest");
    }
    attestation.contested = true;
    // a contested attestation publicly flags the guardian (spec 01 §6.4)
    this.flags.push({ subject: attestation.guardian, reason: "attestation contested by living owner", ref: env.id });
  }

  private monthKey(ts: string): string {
    return ts.slice(0, 7);
  }

  private onTaskPost(env: Envelope): void {
    const head = this.requireMandate(env.from, "task.post");
    const parsed = taskBodySchema.safeParse(env.body);
    if (!parsed.success) throw new HubError("invalid", `invalid task: ${parsed.error.message}`);
    const body = parsed.data;
    if (!env.task) throw new HubError("invalid", "task.post requires a task id");
    if (this.tasks.has(env.task)) throw new HubError("duplicate", `task already exists: ${env.task}`);

    // Spend limits (spec 01 §5.1, 03 §2.4)
    if (body.budget.max > head.mandate.spend.perTask) {
      throw new HubError("unauthorized", `budget ${body.budget.max} exceeds mandate perTask ${head.mandate.spend.perTask}`);
    }
    const mk = this.monthKey(env.ts);
    const spent = this.monthSpend.get(env.from)?.get(mk) ?? 0;
    if (spent + body.budget.max > head.mandate.spend.perMonth) {
      throw new HubError("unauthorized", `budget would exceed mandate perMonth ${head.mandate.spend.perMonth}`);
    }

    // Escrow before OPEN (spec 03 §3.1): debit the acting agent's OWN operating
    // account — the same account its stakes and earnings use (spec 03 §1.2). The
    // mandate spend-limits (checked above) bound how much of the principal's trust
    // the agent commits; the owner account is the principal's separate reserve.
    this.debit(env.from, body.budget.max, `escrow for task ${env.task}`);
    const byMonth = this.monthSpend.get(env.from) ?? new Map<string, number>();
    byMonth.set(mk, round(spent + body.budget.max));
    this.monthSpend.set(env.from, byMonth);

    this.tasks.set(env.task, {
      id: env.task,
      requester: env.from,
      body,
      state: "open",
      escrow: body.budget.max,
      bids: new Map(),
      accepted: false,
    });
  }

  private taskFor(env: Envelope): TaskRecord {
    if (!env.task) throw new HubError("invalid", `${env.type} requires a task id`);
    const t = this.tasks.get(env.task);
    if (!t) throw new HubError("rejected", `unknown task: ${env.task}`);
    return t;
  }

  private onTaskBid(env: Envelope): void {
    const head = this.requireMandate(env.from, "task.bid");
    const t = this.taskFor(env);
    if (t.state !== "open") throw new HubError("rejected", `task is ${t.state}, not open`);
    const parsed = bidBodySchema.safeParse(env.body);
    if (!parsed.success) throw new HubError("invalid", `invalid bid: ${parsed.error.message}`);
    const bid = parsed.data;

    if (t.body.visibility === "direct" && !(t.body.servers ?? []).includes(env.from)) {
      throw new HubError("unauthorized", "task is direct-visibility and bidder is not invited");
    }
    if (bid.price > t.body.budget.max) {
      throw new HubError("rejected", `bid price ${bid.price} exceeds budget ${t.body.budget.max}`);
    }
    const cap = head.capabilities.find((c) => c.name === bid.capability);
    if (!cap) throw new HubError("rejected", `bidder does not declare capability '${bid.capability}'`);
    if (t.body.class !== "open" && cap.name !== t.body.class) {
      throw new HubError("rejected", `capability '${cap.name}' does not match task class '${t.body.class}'`);
    }
    t.bids.set(env.id, { envelope: env, body: bid });
  }

  private async onTaskAward(env: Envelope): Promise<void> {
    const t = this.taskFor(env);
    if (env.from !== t.requester) throw new HubError("unauthorized", "only the requester awards");

    let bidId: string;
    if (env.body["auto"] === true) {
      // Requester delegates matching → the value-price router (spec 03 §6)
      if (t.bids.size === 0) throw new HubError("rejected", "no bids to route among");
      const verdict = routeValuePrice(
        [...t.bids.entries()].map(([id, b]) => ({ id, server: b.envelope.from, price: b.body.price })),
        (server, cls) => {
          const s = scoreFor(this.samples, server, cls);
          return { vhat: s.vhat, n: s.n };
        },
        t.body.class,
        { epsilon: this.epsilon, minSamples: this.minSamples, random: this.randomFor(env.id) },
      );
      bidId = verdict.winner.id;
    } else {
      const explicit = env.body["bid"];
      if (typeof explicit !== "string") throw new HubError("invalid", "award body requires bid envelope id or auto:true");
      bidId = explicit;
    }
    const bid = t.bids.get(bidId);
    if (!bid) throw new HubError("rejected", `unknown bid: ${bidId}`);

    // Stake before AWARDED (spec 03 §3.2): from the server's OWN account.
    const stake = round(this.kappa * bid.body.confidence * bid.body.price);
    const server = bid.envelope.from;
    this.debit(server, stake, `stake for task ${t.id}`);

    t.state = transition(t.state, "task.award");
    t.award = { bidId, server, price: bid.body.price, confidence: bid.body.confidence, stake };

    // Notify the server (spec 02 §5): hub-signed award carrying the winning bid
    // and the task body, so the server can execute without a second round-trip.
    const award = createEnvelope(
      "task.award",
      this.key,
      {
        bid: bid.envelope as unknown as Record<string, unknown>,
        price: bid.body.price,
        escrow: t.escrow,
        taskBody: t.body as unknown as Record<string, unknown>,
      },
      { to: server, task: t.id },
    );
    await this.deliver(server, award);
  }

  private onTaskAccept(env: Envelope): void {
    this.requireMandate(env.from, "task.accept");
    const t = this.taskFor(env);
    if (t.state !== "awarded" || t.award?.server !== env.from) {
      throw new HubError("rejected", "task is not awarded to this agent");
    }
    t.accepted = true;
  }

  private async onTaskDeliver(env: Envelope): Promise<void> {
    this.requireMandate(env.from, "task.deliver");
    const t = this.taskFor(env);
    if (t.state !== "awarded" || t.award?.server !== env.from) {
      throw new HubError("rejected", "task is not awarded to this agent");
    }
    const artifacts = env.body["artifacts"];
    if (!Array.isArray(artifacts) || artifacts.length === 0) {
      throw new HubError("invalid", "task.deliver requires artifacts");
    }
    const parsed = artifacts.map((a) => {
      const p = artifactSchema.safeParse(a);
      if (!p.success) throw new HubError("invalid", `invalid artifact: ${p.error.message}`);
      return p.data;
    });
    t.artifacts = parsed;
    t.state = transition(t.state, "task.deliver");

    // Relay to the requester (spec 02 §4.2 DELIVER)
    await this.deliver(t.requester, env);

    // Deterministic mode: the hub runs the declared test and settles (spec 02 §6.1).
    if (t.body.verification.mode === "deterministic") {
      this.settle(t, await this.runDeterministic(t, parsed));
    }
  }

  /**
   * v0 deterministic checker: `tests.equals` is deep JSON equality against the
   * first inline artifact's data; `tests.category` compares `data.category`
   * (feeds Tier-A samples); `tests.cases` runs a delivered capability module
   * against declared (input → expected) pairs before settlement (spec 02 §8.3).
   */
  private async runDeterministic(t: TaskRecord, artifacts: Artifact[]): Promise<VerificationReport> {
    const tests = t.body.verification.tests ?? {};
    const inline = artifacts.find((a) => a.kind === "inline");
    const data = inline?.kind === "inline" ? inline.data : undefined;

    if ("cases" in tests) {
      const module = artifacts.find((a) => a.kind === "capability-module");
      if (module?.kind !== "capability-module") {
        return { outcome: "rejected", evidence: { error: "tests.cases requires a capability-module artifact" } };
      }
      try {
        const result = await runModuleCases(module, tests["cases"] as ModuleTestCase[]);
        // all-or-nothing: a partially working skill must not be installable
        return {
          outcome: result.passed === result.total ? "accepted" : "rejected",
          evidence: { check: "cases", passed: result.passed, total: result.total, failures: result.failures },
        };
      } catch (e) {
        return { outcome: "rejected", evidence: { check: "cases", error: String(e) } };
      }
    }

    if ("equals" in tests) {
      const pass = data !== undefined && canonicalize(data) === canonicalize(tests["equals"]);
      return { outcome: pass ? "accepted" : "rejected", evidence: { check: "equals", pass } };
    }
    if ("category" in tests) {
      const expected = String(tests["category"]);
      const delivered = String((data as Record<string, unknown> | undefined)?.["category"] ?? "");
      return {
        outcome: expected === delivered ? "accepted" : "rejected",
        categories: { expected, delivered },
        evidence: { check: "category" },
      };
    }
    return { outcome: "rejected", evidence: { error: "no supported deterministic test declared" } };
  }

  private onTaskVerify(env: Envelope): void {
    const t = this.taskFor(env);
    if (t.body.verification.mode !== "requester") {
      throw new HubError("rejected", `mode ${t.body.verification.mode} does not accept external task.verify in v0`);
    }
    if (env.from !== t.requester) throw new HubError("unauthorized", "only the requester verifies in requester mode");
    if (t.state !== "delivered") throw new HubError("rejected", `task is ${t.state}, not delivered`);
    const parsed = verificationReportSchema.safeParse(env.body);
    if (!parsed.success) throw new HubError("invalid", `invalid report: ${parsed.error.message}`);
    this.settle(t, parsed.data);
  }

  /** Settlement (spec 03 §4): exactly one per task; burns are destroyed. */
  private settle(t: TaskRecord, report: VerificationReport): void {
    const award = t.award!;
    // Both parties operate from their own agent accounts (spec 03 §1.2):
    // the server earns to its account; the requester's escrow remainder
    // refunds to its account.
    if (report.outcome === "accepted") {
      this.credit(award.server, award.price);
      this.credit(t.requester, round(t.escrow - award.price));
      this.credit(award.server, award.stake);
    } else if (report.outcome === "partial") {
      const q = report.quality ?? 0;
      const pay = round(q * award.price);
      this.credit(award.server, pay);
      this.credit(t.requester, round(t.escrow - pay));
      this.credit(award.server, round(q * award.stake));
      this.burn(round((1 - q) * award.stake));
    } else {
      this.credit(t.requester, t.escrow);
      this.burn(award.stake);
    }

    t.escrow = 0;
    t.report = report;
    t.state = transition(t.state, `task.verify:${report.outcome}`);

    this.samples.push({
      server: award.server,
      class: t.body.class,
      mode: t.body.verification.mode,
      outcome: report.outcome,
      ...(report.quality !== undefined ? { quality: report.quality } : {}),
      ...(report.categories ? { categories: report.categories } : {}),
    });
  }

  private onTaskCancel(env: Envelope): void {
    this.requireMandate(env.from, "task.cancel");
    const t = this.taskFor(env);
    if (env.from !== t.requester) throw new HubError("unauthorized", "only the requester cancels");
    if (t.state === "open") {
      this.credit(t.requester, t.escrow);
    } else if (t.state === "awarded") {
      // v0: no kill fee; stake returns, escrow refunds (spec 02 §4.2 notes a hub-configured kill fee)
      this.credit(t.requester, t.escrow);
      this.credit(t.award!.server, t.award!.stake);
    }
    t.escrow = 0;
    t.state = transition(t.state, "task.cancel");
  }

  private async onMsgSend(env: Envelope): Promise<void> {
    this.requireMandate(env.from, "msg.send");
    if (!env.to) throw new HubError("invalid", "msg.send requires a recipient");
    await this.deliver(env.to, env);
  }
}
