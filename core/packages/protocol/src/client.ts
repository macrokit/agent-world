import { HubError, type HubLike, type TaskView } from "./hub.js";
import type { Envelope, Manifest, TaskState } from "./types.js";

/** HTTP client for a served hub — the remote counterpart of InMemoryHub. */
export class HubClient implements HubLike {
  constructor(private baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async send(envelope: Envelope): Promise<void> {
    const res = await fetch(`${this.baseUrl}/aw/v0/inbox`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      const code = (body.error?.code ?? "rejected") as HubError["code"];
      throw new HubError(code, body.error?.message ?? `hub returned ${res.status}`);
    }
  }

  async listTasks(query?: { status?: TaskState; class?: string }): Promise<TaskView[]> {
    const params = new URLSearchParams();
    if (query?.status) params.set("status", query.status);
    if (query?.class) params.set("class", query.class);
    const res = await fetch(`${this.baseUrl}/aw/v0/tasks?${params}`);
    if (!res.ok) throw new HubError("rejected", `hub returned ${res.status}`);
    return (await res.json()) as TaskView[];
  }

  async scores(): Promise<{ epsilon: number; minSamples: number; scores: unknown[] }> {
    const res = await fetch(`${this.baseUrl}/aw/v0/scores`);
    if (!res.ok) throw new HubError("rejected", `hub returned ${res.status}`);
    return (await res.json()) as { epsilon: number; minSamples: number; scores: unknown[] };
  }

  async searchAgents(query?: { capability?: string }): Promise<Manifest[][]> {
    const params = new URLSearchParams();
    if (query?.capability) params.set("capability", query.capability);
    const res = await fetch(`${this.baseUrl}/aw/v0/agents?${params}`);
    if (!res.ok) throw new HubError("rejected", `hub returned ${res.status}`);
    return (await res.json()) as Manifest[][];
  }
}
