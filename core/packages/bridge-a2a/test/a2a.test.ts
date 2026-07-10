import { generateKeypair } from "@agentworld/identity";
import { createManifest } from "@agentworld/protocol";
import { createAgent } from "@agentworld/agent";
import { afterAll, describe, expect, it } from "vitest";
import { manifestToAgentCard, serveA2a, A2A_DIALECT } from "../src/index.js";

const servers: Array<{ close(): Promise<void> }> = [];
afterAll(async () => {
  for (const s of servers) await s.close();
});

function makeAgent() {
  const owner = generateKeypair();
  const key = generateKeypair();
  const manifest = createManifest(
    {
      id: key.id,
      name: "a2a-test",
      goal: { statement: "serve A2A clients" },
      capabilities: [
        {
          name: "shout",
          intent: "uppercase text",
          input: { type: "object", properties: { text: { type: "string" } } },
          output: { type: "object" },
          scopes: ["net:example.com"],
        },
      ],
      endpoints: { inbox: "local:" },
      mandate: { spend: { perTask: 0, perMonth: 0, currency: "credit" }, commit: [], reserved: [] },
      succession: { successors: [], continuation: "wound-down" },
    },
    owner,
  );
  const agent = createAgent({ manifest, key, ownerKey: owner });
  agent.capability("shout", async (input) => ({ text: String(input["text"]).toUpperCase() }));
  return agent;
}

describe("A2A bridge (spec 02 Appendix A)", () => {
  it("serves an AgentCard with skills from capabilities and the aw identity extension", async () => {
    const agent = makeAgent();
    const srv = await serveA2a(agent);
    servers.push(srv);
    const card = (await (await fetch(`${srv.url}/.well-known/agent.json`)).json()) as Record<string, never>;
    expect(card["name"]).toBe("a2a-test");
    expect(card["protocolVersion"]).toBe(A2A_DIALECT);
    expect(card["skills"]).toEqual([
      { id: "shout", name: "shout", description: "uppercase text", tags: ["net:example.com"] },
    ]);
    expect((card["extensions"] as { agentWorld: { id: string } }).agentWorld.id).toBe(agent.id);
    // pure projection is also exported
    expect(manifestToAgentCard(agent.manifest, "http://x").skills).toHaveLength(1);
  });

  it("message/send invokes the skill and returns a completed task with a data artifact", async () => {
    const srv = await serveA2a(makeAgent());
    servers.push(srv);
    const res = (await (
      await fetch(srv.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "message/send",
          params: { message: { parts: [{ kind: "data", data: { text: "hello a2a" } }], metadata: { skillId: "shout" } } },
        }),
      })
    ).json()) as { result: { status: { state: string }; artifacts: Array<{ parts: Array<{ data: unknown }> }> } };
    expect(res.result.status.state).toBe("completed");
    expect(res.result.artifacts[0]!.parts[0]!.data).toEqual({ text: "HELLO A2A" });
  });

  it("single-capability agents default the skill; unknown skills and methods error in-band", async () => {
    const srv = await serveA2a(makeAgent());
    servers.push(srv);
    const defaulted = (await (
      await fetch(srv.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "message/send",
          params: { message: { parts: [{ kind: "data", data: { text: "hi" } }] } },
        }),
      })
    ).json()) as { result: { status: { state: string } } };
    expect(defaulted.result.status.state).toBe("completed");

    const unknownSkill = (await (
      await fetch(srv.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "message/send",
          params: { message: { parts: [], metadata: { skillId: "nope" } } },
        }),
      })
    ).json()) as { error: { code: number } };
    expect(unknownSkill.error.code).toBe(-32602);

    const badMethod = (await (
      await fetch(srv.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tasks/resubscribe" }),
      })
    ).json()) as { error: { code: number } };
    expect(badMethod.error.code).toBe(-32601);
  });
});
