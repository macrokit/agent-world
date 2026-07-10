import { randomUUID } from "node:crypto";
import type { Keypair } from "@agentworld/identity";
import {
  createEnvelope,
  serveInbox,
  verifyEnvelope,
  type Artifact,
  type BidBody,
  type Envelope,
  type HubLike,
  type InMemoryHub,
  type Manifest,
  type Served,
  type TaskBody,
  type VerificationReport,
} from "@agentworld/protocol";

export class MandateError extends Error {}

/**
 * A capability handler — ANY async function (spec 01 boundary-only rule).
 * What runs inside is the agent owner's business: a local model, a Macrokit
 * runtime, an API call, a human queue.
 */
export type CapabilityHandler = (
  input: Record<string, unknown>,
  ctx: { task: string; body: TaskBody },
) => Promise<Record<string, unknown> | Artifact[]>;

export interface AgentOptions {
  manifest: Manifest;
  /** the agent key — signs runtime acts */
  key: Keypair;
  /** the owner key — needed only for register(); omit on servers that never publish */
  ownerKey?: Keypair;
}

export function createAgent(opts: AgentOptions): Agent {
  return new Agent(opts);
}

export class Agent {
  readonly manifest: Manifest;
  readonly id: string;
  private key: Keypair;
  private ownerKey?: Keypair;
  private hub?: HubLike;
  private handlers = new Map<string, CapabilityHandler>();
  private messageHandler?: (env: Envelope) => Promise<void> | void;

  constructor(opts: AgentOptions) {
    if (opts.key.id !== opts.manifest.id) {
      throw new Error("agent key does not match manifest id");
    }
    if (opts.ownerKey && opts.ownerKey.id !== opts.manifest.owner) {
      throw new Error("owner key does not match manifest owner");
    }
    if (opts.ownerKey && opts.ownerKey.id === opts.key.id) {
      throw new Error("owner key and agent key must be distinct (spec 01 §1)");
    }
    this.manifest = opts.manifest;
    this.id = opts.manifest.id;
    this.key = opts.key;
    this.ownerKey = opts.ownerKey;
  }

  /** Attach the handler for a declared capability. */
  capability(name: string, handler: CapabilityHandler): this {
    if (!this.manifest.capabilities.some((c) => c.name === name)) {
      throw new Error(`capability '${name}' is not declared in the manifest`);
    }
    this.handlers.set(name, handler);
    return this;
  }

  onMessage(handler: (env: Envelope) => Promise<void> | void): this {
    this.messageHandler = handler;
    return this;
  }

  /** Connect to a hub (HubClient over HTTP, or an InMemoryHub in-process). */
  connect(hub: HubLike): this {
    this.hub = hub;
    return this;
  }

  private requireHub(): HubLike {
    if (!this.hub) throw new Error("agent is not connected to a hub — call connect() first");
    return this.hub;
  }

  /** Publish the manifest (owner-signed act; spec 02 §5 manifest.publish). */
  async register(): Promise<void> {
    if (!this.ownerKey) throw new Error("register() requires the owner key");
    await this.requireHub().send(
      createEnvelope("manifest.publish", this.ownerKey, {
        manifest: this.manifest as unknown as Record<string, unknown>,
      }),
    );
  }

  /**
   * Local mandate pre-check (spec 01 §5.1) — the hub enforces authoritatively;
   * checking locally means an honest agent never emits a void act.
   */
  private assertMandate(type: string, spend?: number): void {
    if (!(this.manifest.mandate.commit as string[]).includes(type)) {
      throw new MandateError(`act '${type}' is outside this agent's mandate`);
    }
    if (spend !== undefined && spend > this.manifest.mandate.spend.perTask) {
      throw new MandateError(`spend ${spend} exceeds mandate perTask ${this.manifest.mandate.spend.perTask}`);
    }
  }

  async post(body: TaskBody, taskId = randomUUID()): Promise<string> {
    this.assertMandate("task.post", body.budget.max);
    await this.requireHub().send(
      createEnvelope("task.post", this.key, body as unknown as Record<string, unknown>, { task: taskId }),
    );
    return taskId;
  }

  async bid(taskId: string, bid: BidBody): Promise<void> {
    this.assertMandate("task.bid");
    await this.requireHub().send(
      createEnvelope("task.bid", this.key, bid as unknown as Record<string, unknown>, { task: taskId }),
    );
  }

  async award(taskId: string, bidEnvelopeId: string): Promise<void> {
    await this.requireHub().send(createEnvelope("task.award", this.key, { bid: bidEnvelopeId }, { task: taskId }));
  }

  async verify(taskId: string, report: VerificationReport): Promise<void> {
    this.assertMandate("task.verify");
    await this.requireHub().send(
      createEnvelope("task.verify", this.key, report as unknown as Record<string, unknown>, { task: taskId }),
    );
  }

  async cancel(taskId: string): Promise<void> {
    this.assertMandate("task.cancel");
    await this.requireHub().send(createEnvelope("task.cancel", this.key, {}, { task: taskId }));
  }

  async message(to: string, text: string, task?: string): Promise<void> {
    this.assertMandate("msg.send");
    await this.requireHub().send(createEnvelope("msg.send", this.key, { text, ...(task ? { task } : {}) }, { to, task }));
  }

  /**
   * The inbox: verifies every incoming envelope, auto-serves awards
   * (accept → run the capability handler → deliver), relays messages.
   */
  readonly handleEnvelope = async (raw: unknown): Promise<void> => {
    const env = verifyEnvelope(raw);
    switch (env.type) {
      case "task.award":
        return this.onAward(env);
      case "msg.send":
        await this.messageHandler?.(env);
        return;
      case "task.deliver":
        // deliveries to us as requester; surfaced via onMessage for v0
        await this.messageHandler?.(env);
        return;
      default:
        return; // ignore-unknown (README conventions)
    }
  };

  private async onAward(env: Envelope): Promise<void> {
    const taskId = env.task;
    if (!taskId) return;
    const bid = env.body["bid"] as { body?: { capability?: string } } | undefined;
    const taskBody = env.body["taskBody"] as TaskBody | undefined;
    const capName = bid?.body?.capability;
    if (!capName || !taskBody) return;

    const handler = this.handlers.get(capName);
    if (!handler) return; // declared but unhandled: let the deadline fail it honestly

    this.assertMandate("task.accept");
    await this.requireHub().send(createEnvelope("task.accept", this.key, {}, { task: taskId }));

    const result = await handler(taskBody.input, { task: taskId, body: taskBody });
    const artifacts: Artifact[] = Array.isArray(result) ? result : [{ kind: "inline", data: result }];

    this.assertMandate("task.deliver");
    await this.requireHub().send(
      createEnvelope("task.deliver", this.key, { artifacts: artifacts as unknown as Record<string, unknown>[] }, { task: taskId }),
    );
  }

  /** In-process attachment (tests, single-box setups). */
  attachLocal(hub: InMemoryHub): this {
    hub.registerInbox(this.id, this.handleEnvelope);
    return this;
  }

  /** HTTP inbox (spec 02 §3). The manifest's endpoints.inbox should point here. */
  async listen(port = 0): Promise<Served> {
    return serveInbox(this.handleEnvelope, port);
  }
}
