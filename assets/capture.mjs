/**
 * Run the escalation-market demo against the live hub, recording per-line
 * timing into transcript.json — the source data for generate.mjs.
 *
 *   node assets/capture.mjs            # against https://hub.macrokit.dev
 *   AW_HUB=http://... node assets/capture.mjs
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const { runLiveEscalationDemo } = await import(
  new URL("../adapters/macrokit/dist/demo-live.js", import.meta.url).href
);

const HUB = process.env.AW_HUB ?? "https://hub.macrokit.dev";
const lines = [];
const t0 = Date.now();
const log = (text) => {
  lines.push({ t: Date.now() - t0, text });
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${text}`);
};

const r = await runLiveEscalationDemo(HUB, log);
lines.push({
  t: Date.now() - t0,
  text: `escalation: ${r.escalationSettled} · installed: ${r.installed} · serves locally: ${r.servesLocally} · market round: ${r.marketRoundSettled} · conservation: ${r.conservationHolds}`,
});

writeFileSync(
  fileURLToPath(new URL("transcript.json", import.meta.url)),
  JSON.stringify({ hub: HUB, captured: new Date().toISOString(), lines }, null, 2),
);
console.log(`\ncaptured ${lines.length} lines over ${((Date.now() - t0) / 1000).toFixed(1)}s`);
