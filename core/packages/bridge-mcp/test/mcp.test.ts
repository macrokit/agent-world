import { generateKeypair } from "@agentworld/identity";
import { createManifest } from "@agentworld/protocol";
import { createAgent } from "@agentworld/agent";
import { describe, expect, it } from "vitest";
import { createMcpBridge, manifestToMcpTools, MCP_PROTOCOL_VERSION } from "../src/index.js";

function makeAgent() {
  const owner = generateKeypair();
  const key = generateKeypair();
  const manifest = createManifest(
    {
      id: key.id,
      name: "bridge-test",
      goal: { statement: "serve over MCP" },
      capabilities: [
        {
          name: "shout",
          intent: "uppercase text",
          input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
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

describe("MCP bridge (spec 02 Appendix A)", () => {
  it("projects capabilities to tools with scopes surfaced in the description", () => {
    const tools = manifestToMcpTools(makeAgent().manifest);
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("shout");
    expect(tools[0]!.description).toContain("uppercase text");
    expect(tools[0]!.description).toContain("net:example.com");
    expect(tools[0]!.inputSchema).toMatchObject({ type: "object" });
  });

  it("initialize → tools/list → tools/call round-trips", async () => {
    const bridge = createMcpBridge(makeAgent());

    const init = await bridge.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(init?.result).toMatchObject({ protocolVersion: MCP_PROTOCOL_VERSION });

    const list = await bridge.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((list?.result as { tools: unknown[] }).tools).toHaveLength(1);

    const call = await bridge.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "shout", arguments: { text: "hello mcp" } },
    });
    const result = call?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ text: "HELLO MCP" });
  });

  it("unknown tools are -32602; handler failures are in-band isError results", async () => {
    const agent = makeAgent();
    const bridge = createMcpBridge(agent);
    const unknown = await bridge.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } });
    expect(unknown?.error?.code).toBe(-32602);

    agent.capability("shout", async () => {
      throw new Error("surface offline");
    });
    const failing = await bridge.handle({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "shout", arguments: { text: "x" } },
    });
    const result = failing?.result as { isError: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("surface offline");
  });

  it("unknown methods are -32601; notifications get no response", async () => {
    const bridge = createMcpBridge(makeAgent());
    const bad = await bridge.handle({ jsonrpc: "2.0", id: 6, method: "resources/list" });
    expect(bad?.error?.code).toBe(-32601);
    const note = await bridge.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(note).toBeNull();
  });
});
