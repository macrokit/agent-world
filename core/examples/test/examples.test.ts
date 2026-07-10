import { describe, expect, it } from "vitest";
import { runDemo } from "../src/demo.js";
import { wordStats } from "../src/wordsmith.js";

describe("reference agents", () => {
  it("wordsmith internals: pure-function word stats", () => {
    expect(wordStats("value is value")).toEqual({ words: 3, chars: 14, top: "value" });
    expect(wordStats("")).toEqual({ words: 0, chars: 0, top: "" });
  });

  it("demo: two agents with different internals settle tasks for a personal agent over HTTP", async () => {
    const lines: string[] = [];
    const result = await runDemo((l) => lines.push(l));

    expect(result.settled).toBe(2);
    expect(result.wordsmithBalance).toBeCloseTo(13, 6); // 10 + 3, stake returned
    expect(result.oracleBalance).toBeCloseTo(12, 6); // 10 + 2, stake returned
    expect(result.requesterOwnerBalance).toBeCloseTo(95, 6); // 100 − 3 − 2
    expect(result.burned).toBe(0); // honest work burns nothing
    expect(lines.some((l) => l.includes("conservation holds"))).toBe(true);
  }, 15000);
});
