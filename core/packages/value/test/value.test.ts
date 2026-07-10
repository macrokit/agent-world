import { describe, expect, it } from "vitest";
import {
  acceptanceScore,
  betaInv,
  categoricalMI,
  groupScores,
  ibeta,
  routeValuePrice,
  scoreFor,
  type ValueSample,
} from "../src/index.js";

describe("categorical Î (Tier A, spec 03 §5.2)", () => {
  it("a perfect channel saturates at ln K (normalized 1)", () => {
    const pairs = ["a", "b", "c"].flatMap((c) => Array(30).fill({ expected: c, delivered: c }));
    const m = categoricalMI(pairs);
    expect(m.k).toBe(3);
    expect(m.i).toBeCloseTo(Math.log(3), 2);
    expect(m.iNormalized).toBeCloseTo(1, 2);
  });

  it("delivered independent of expected → Î ≈ 0", () => {
    // delivered cycles regardless of expected: no information
    const pairs = [];
    const cats = ["a", "b"];
    for (let i = 0; i < 200; i++) {
      pairs.push({ expected: cats[i % 2]!, delivered: cats[(i >> 1) % 2]! });
    }
    const m = categoricalMI(pairs);
    expect(m.iNormalized).toBeLessThan(0.05);
  });

  it("clamps to [0, ln K] and handles the degenerate single-category case", () => {
    expect(categoricalMI([]).n).toBe(0);
    const single = categoricalMI(Array(10).fill({ expected: "a", delivered: "a" }));
    expect(single.i).toBe(0);
    expect(single.iNormalized).toBe(0); // one category: nothing to inform about
  });
});

describe("Beta acceptance score (Tier B, spec 03 §5.3)", () => {
  it("uniform prior; mean and lower bound move with evidence", () => {
    const empty = acceptanceScore([]);
    expect(empty.mean).toBeCloseTo(0.5, 6);

    const good = acceptanceScore(Array(8).fill({ outcome: "accepted", mode: "deterministic" }));
    expect(good.mean).toBeCloseTo(9 / 10, 6);
    expect(good.lower).toBeGreaterThan(0.6);

    const bad = acceptanceScore(Array(8).fill({ outcome: "rejected", mode: "deterministic" }));
    expect(bad.lower).toBeLessThan(0.05);
  });

  it("requester-mode evidence enters at half weight; partial uses quality", () => {
    const det = acceptanceScore([{ outcome: "accepted", mode: "deterministic" }]);
    const req = acceptanceScore([{ outcome: "accepted", mode: "requester" }]);
    expect(det.alpha).toBe(2);
    expect(req.alpha).toBe(1.5);
    const part = acceptanceScore([{ outcome: "partial", quality: 0.25, mode: "deterministic" }]);
    expect(part.alpha).toBeCloseTo(1.25, 6);
    expect(part.beta).toBeCloseTo(1.75, 6);
  });

  it("incomplete beta numerics are sane", () => {
    expect(ibeta(0.5, 1, 1)).toBeCloseTo(0.5, 9); // uniform CDF
    expect(ibeta(0.3, 2, 2)).toBeCloseTo(0.216, 3); // 3x²−2x³ at 0.3
    expect(betaInv(0.5, 5, 5)).toBeCloseTo(0.5, 4); // symmetric median
    expect(ibeta(betaInv(0.05, 9, 2), 9, 2)).toBeCloseTo(0.05, 6); // round-trip
  });
});

describe("scoreFor / groupScores", () => {
  const samples: ValueSample[] = [
    { server: "A", class: "route", outcome: "accepted", mode: "deterministic", categories: { expected: "x", delivered: "x" } },
    { server: "A", class: "route", outcome: "accepted", mode: "deterministic", categories: { expected: "y", delivered: "y" } },
    { server: "A", class: "other", outcome: "accepted", mode: "requester" },
    { server: "B", class: "route", outcome: "rejected", mode: "deterministic" },
  ];

  it("prefers Tier A when categorical evidence exists; per-(agent,class) only", () => {
    expect(scoreFor(samples, "A", "route").tier).toBe("A");
    expect(scoreFor(samples, "A", "other").tier).toBe("B");
    expect(scoreFor(samples, "B", "route").tier).toBe("B");
    const all = groupScores(samples);
    expect(all).toHaveLength(3); // (A,route) (A,other) (B,route) — no aggregate rows
  });
});

describe("value-price router (spec 03 §6)", () => {
  const history: ValueSample[] = [
    ...Array(6).fill({ server: "good", class: "c", outcome: "accepted", mode: "deterministic" }),
    ...Array(6).fill({ server: "bad", class: "c", outcome: "rejected", mode: "deterministic" }),
  ];
  const scoreOf = (server: string, cls: string) => {
    const s = scoreFor(history, server, cls);
    return { vhat: s.vhat, n: s.n };
  };

  it("awards to the best V̂/price even at a higher price", () => {
    const verdict = routeValuePrice(
      [
        { id: "b1", server: "bad", price: 1 },
        { id: "b2", server: "good", price: 6 },
      ],
      scoreOf,
      "c",
      { epsilon: 0, random: () => 1 },
    );
    expect(verdict.winner.server).toBe("good");
    expect(verdict.explored).toBe(false);
  });

  it("ties break toward the lower price", () => {
    const flat = (_s: string) => ({ vhat: 0.5, n: 10 });
    const verdict = routeValuePrice(
      [
        { id: "b1", server: "x", price: 4 },
        { id: "b2", server: "y", price: 4 },
        { id: "b3", server: "z", price: 2 },
      ],
      (s) => flat(s),
      "c",
      { epsilon: 0 },
    );
    expect(verdict.winner.id).toBe("b3");
  });

  it("ε-exploration routes to a low-sample novice", () => {
    const verdict = routeValuePrice(
      [
        { id: "b1", server: "good", price: 5 },
        { id: "b2", server: "novice", price: 5 },
      ],
      scoreOf,
      "c",
      { epsilon: 1, random: () => 0.3 }, // always explore; pick deterministic index
    );
    expect(verdict.winner.server).toBe("novice");
    expect(verdict.explored).toBe(true);
  });

  it("no novices → never explores even at ε=1", () => {
    const verdict = routeValuePrice(
      [
        { id: "b1", server: "good", price: 5 },
        { id: "b2", server: "bad", price: 5 },
      ],
      scoreOf,
      "c",
      { epsilon: 1, random: () => 0.0 },
    );
    expect(verdict.explored).toBe(false);
    expect(verdict.winner.server).toBe("good");
  });
});
