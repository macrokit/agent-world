/**
 * The value-price router (spec 03 §6): among eligible bids, award to the
 * highest V̂/price; ties break toward the lower price, then the earlier bid.
 * With probability ε, explore a low-sample bidder instead — new agents must
 * be able to acquire samples or the score system ossifies into an incumbency
 * machine (§6.3).
 */
export interface RouterBid {
  /** bid envelope id */
  id: string;
  server: string;
  price: number;
}

export interface RouterVerdict {
  winner: RouterBid;
  explored: boolean;
  /** the computed V̂/price per bid, for transparency */
  scores: Array<{ id: string; server: string; score: number; vhat: number; n: number }>;
}

export interface RouterOptions {
  /** exploration probability (published hub parameter; default 0.1) */
  epsilon?: number;
  /** a bidder with fewer samples than this is an exploration candidate (default 5) */
  minSamples?: number;
  /** injectable randomness for deterministic tests */
  random?: () => number;
}

export function routeValuePrice(
  bids: RouterBid[],
  scoreOf: (server: string, cls: string) => { vhat: number; n: number },
  cls: string,
  opts?: RouterOptions,
): RouterVerdict {
  if (bids.length === 0) throw new Error("router: no bids");
  const epsilon = opts?.epsilon ?? 0.1;
  const minSamples = opts?.minSamples ?? 5;
  const random = opts?.random ?? Math.random;

  const scored = bids.map((b) => {
    const s = scoreOf(b.server, cls);
    return { bid: b, vhat: s.vhat, n: s.n, score: s.vhat / b.price };
  });

  const novices = scored.filter((s) => s.n < minSamples);
  if (novices.length > 0 && random() < epsilon) {
    const pick = novices[Math.floor(random() * novices.length)]!;
    return {
      winner: pick.bid,
      explored: true,
      scores: scored.map((s) => ({ id: s.bid.id, server: s.bid.server, score: s.score, vhat: s.vhat, n: s.n })),
    };
  }

  let best = scored[0]!;
  for (const s of scored.slice(1)) {
    if (
      s.score > best.score ||
      (s.score === best.score && s.bid.price < best.bid.price)
    ) {
      best = s;
    }
  }
  return {
    winner: best.bid,
    explored: false,
    scores: scored.map((s) => ({ id: s.bid.id, server: s.bid.server, score: s.score, vhat: s.vhat, n: s.n })),
  };
}
