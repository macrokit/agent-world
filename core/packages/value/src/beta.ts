/**
 * Tier-B capability score (spec 03 §5.3): a Beta posterior over
 * quality-weighted acceptance. Uniform prior; requester-mode evidence enters
 * at weight ½; published as posterior mean + a 5th-percentile lower credible
 * bound. Honestly a *proxy* — it bounds nothing, it aggregates verified
 * outcomes correctly.
 */
export interface AcceptanceSample {
  outcome: "accepted" | "partial" | "rejected";
  quality?: number;
  /** verification mode the sample came from (spec 02 §6) */
  mode: string;
}

export interface BetaScore {
  mean: number;
  /** 5th-percentile lower credible bound (S⁻ in spec 03 §5.3) */
  lower: number;
  n: number;
  alpha: number;
  beta: number;
}

export function acceptanceScore(samples: AcceptanceSample[]): BetaScore {
  let alpha = 1;
  let beta = 1;
  for (const s of samples) {
    const w = s.mode === "requester" ? 0.5 : 1;
    const q = s.outcome === "accepted" ? 1 : s.outcome === "partial" ? (s.quality ?? 0) : 0;
    alpha += w * q;
    beta += w * (1 - q);
  }
  return {
    mean: alpha / (alpha + beta),
    lower: betaInv(0.05, alpha, beta),
    n: samples.length,
    alpha,
    beta,
  };
}

// ---- regularized incomplete beta + inverse (standard numerics) ----

function lgamma(x: number): number {
  // Lanczos approximation
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = 0.99999999999980993;
  const t = x + 7.5;
  for (let i = 0; i < g.length; i++) a += g[i]! / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta (Lentz's algorithm). */
function betacf(x: number, a: number, b: number): number {
  const EPS = 1e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function ibeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const ln = lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const front = Math.exp(ln);
  if (x < (a + 1) / (a + b + 2)) return (front * betacf(x, a, b)) / a;
  return 1 - (front * betacf(1 - x, b, a)) / b;
}

/** Inverse: the p-quantile of Beta(a, b), by bisection. */
export function betaInv(p: number, a: number, b: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (ibeta(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
