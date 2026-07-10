import { z } from "zod";
import { defineMacro } from "@macrokit/authoring";
import { generateKeypair } from "@agentworld/identity";
import { InMemoryHub } from "@agentworld/protocol";
import { describe, expect, it } from "vitest";
import { createMacrokitAgent, macroToCapability } from "../src/index.js";
import { runEscalationDemo } from "../src/demo.js";

describe("macro → capability projection", () => {
  const macro = defineMacro({
    name: "rank_papers",
    intent: "rank papers against a stated interest",
    schema: z.object({ interest: z.string(), titles: z.array(z.string()) }),
    handler: async () => ({ ranked: [] }),
    capabilities: ["github", "Browser API"],
  });

  it("projects name, intent, real JSON Schema, and D-017 surfaces as x- scopes", () => {
    const cap = macroToCapability(macro, { ask: 4 });
    expect(cap.name).toBe("rank_papers");
    expect(cap.intent).toBe(macro.intent);
    const input = cap.input as { properties?: Record<string, unknown>; required?: string[] };
    expect(Object.keys(input.properties ?? {})).toEqual(["interest", "titles"]);
    expect(cap.scopes).toEqual(["x-tool-github", "x-tool-browser-api"]);
    expect(cap.pricing).toEqual({ ask: 4, currency: "credit" });
  });
});

describe("createMacrokitAgent — the real runtime behind the boundary", () => {
  it("serves a market task through the Macrokit dispatcher", async () => {
    const hub = new InMemoryHub(generateKeypair());
    const mk = createMacrokitAgent({
      name: "mk-agent",
      goal: "test",
      macros: [
        defineMacro({
          name: "shout",
          intent: "uppercase text",
          schema: z.object({ text: z.string() }),
          handler: async ({ text }) => ({ text: text.toUpperCase() }),
          capabilities: [],
        }),
      ],
    });
    mk.agent.connect(hub).attachLocal(hub);
    await mk.agent.register();
    hub.mint(mk.key.id, 10);

    // schema violations are refused by the macro's own zod schema via dispatch
    const bad = await mk.dispatcher.dispatch({ tool: "shout", args: { nope: 1 } });
    expect(bad.ok).toBe(false);

    const good = await mk.dispatcher.dispatch({ tool: "shout", args: { text: "hi" } });
    expect(good).toMatchObject({ ok: true, value: { text: "HI" } });
    expect(mk.serves("shout")).toBe(true);
    expect(mk.serves("whisper")).toBe(false);
  });

  it("D-017 enforcement carries through: undeclared tool surfaces throw capability_violation", async () => {
    const mk = createMacrokitAgent({
      name: "sneaky",
      goal: "test",
      macros: [
        defineMacro({
          name: "sneaky_reach",
          intent: "tries to touch an undeclared surface",
          schema: z.object({}),
          handler: async (_args, ctx) => {
            const surface = (ctx.tools as Record<string, { do(): string }>)["github"];
            return { got: surface.do() };
          },
          capabilities: [], // declares NOTHING — reaching for github must throw
        }),
      ],
      tools: { github: { do: () => "data" } },
    });
    const result = await mk.dispatcher.dispatch({ tool: "sneaky_reach", args: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("capability_violation");
  });
});

describe("the escalation market (end-to-end)", () => {
  it("novelty → authoring task → verified module → owner-gated install → serves locally and earns", async () => {
    const lines: string[] = [];
    const r = await runEscalationDemo((l) => lines.push(l));

    expect(r.escalationSettled).toBe(true);
    expect(r.installed).toBe(true);
    expect(r.servesLocally).toBe(true);
    expect(r.localAnswer).toEqual({ reversed: "ability in time in life" });
    expect(r.marketRoundSettled).toBe(true);

    // the economics of the story: bought for 12, already earning it back
    expect(r.weakAgentSpent).toBe(12);
    expect(r.weakAgentEarned).toBe(2);
    expect(r.authoringEarned).toBe(12);

    // the owner saw the scopes before anything installed
    expect(lines.some((l) => l.includes("owner approves scopes"))).toBe(true);
  });
});
