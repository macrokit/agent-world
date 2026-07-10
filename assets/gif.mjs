/**
 * Emit static per-event frames of the recording (for GIF/MP4 assembly).
 *
 *   node assets/gif.mjs <outdir>     # writes frame-000.svg … + frames.json
 *
 * One frame per state change — typing keystrokes, each output line at its
 * REAL captured offset, cursor blinks in the final hold — with per-frame
 * durations, so the assembled GIF carries the same authentic timing as the
 * animated SVG. Layout and palette mirror generate.mjs.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const { hub, lines } = JSON.parse(readFileSync(here("transcript.json"), "utf8"));
const outDir = process.argv[2] ?? here("frames");
mkdirSync(outDir, { recursive: true });

const CMD = "pnpm demo:live";
const TYPE_START = 0.6;
const TYPE_CPS = 16;
const RUN_START = TYPE_START + CMD.length / TYPE_CPS + 0.5;

// ---- tokenizing (mirrors generate.mjs) ----
const PREFIX_W = 13;
const RULES = [
  { re: /"[^"]*"|'[^']*'/, cls: "acc" },
  { re: /\b(accepted|holds ✓|yes|LOCALLY|settled|true)\b/, cls: "ok" },
  { re: /\bfalse\b/, cls: "warn" },
];
function tokenize(text) {
  const m = text.match(/^(\S+(?: \S+)?)(\s{2,})(.*)$/);
  const out = [];
  let rest;
  if (m && m[1].length <= PREFIX_W) {
    out.push({ cls: "dim", s: m[1] + m[2] });
    rest = m[3];
  } else rest = text;
  while (rest.length) {
    let best = null;
    for (const { re, cls } of RULES) {
      const hit = rest.match(re);
      if (hit && (best === null || hit.index < best.index)) best = { index: hit.index, len: hit[0].length, cls, s: hit[0] };
    }
    if (!best) {
      out.push({ cls: "txt", s: rest });
      break;
    }
    if (best.index > 0) out.push({ cls: "txt", s: rest.slice(0, best.index) });
    out.push({ cls: best.cls, s: best.s });
    rest = rest.slice(best.index + best.len);
  }
  return out;
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---- layout (mirrors generate.mjs) ----
const C = {
  bg: "#0e1116", chrome: "#161b22", line: "#262d38",
  txt: "#dbe2ea", dim: "#8b96a5", acc: "#5fb2ff", ok: "#4cc38a", warn: "#e5734f",
  title: "#8b96a5", prompt: "#4cc38a",
};
const FS = 13, LH = 22, PADX = 26, TOP = 64, W = 980;
const H = TOP + (lines.length + 2) * LH + 26;

function frameSvg(state) {
  // state: {typed: n chars, shown: n lines, endPrompt: bool, cursor: bool}
  let body = "";
  let y = TOP;
  const cmdShown = esc(CMD.slice(0, state.typed));
  const typingCursor = !state.endPrompt && state.cursor ? `<tspan class="txt">▊</tspan>` : "";
  body += `<text x="${PADX}" y="${y}"><tspan class="prompt">$ </tspan><tspan class="txt">${cmdShown}</tspan>${typingCursor}</text>\n`;
  for (let i = 0; i < state.shown; i++) {
    y += LH * (i === 0 ? 1.4 : 1);
    const tspans = tokenize(lines[i].text).map((t) => `<tspan class="${t.cls}">${esc(t.s)}</tspan>`).join("");
    body += `<text x="${PADX}" y="${y}">${tspans}</text>\n`;
  }
  if (state.endPrompt) {
    y += LH * 1.4;
    body += `<text x="${PADX}" y="${y}"><tspan class="prompt">$ </tspan>${state.cursor ? '<tspan class="txt">▊</tspan>' : ""}</text>\n`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="${FS}">
  <style>.txt{fill:${C.txt}}.dim{fill:${C.dim}}.acc{fill:${C.acc}}.ok{fill:${C.ok}}.warn{fill:${C.warn}}.prompt{fill:${C.prompt}}</style>
  <rect width="${W}" height="${H}" rx="12" fill="${C.bg}" stroke="${C.line}"/>
  <rect width="${W}" height="40" rx="12" fill="${C.chrome}"/><rect y="28" width="${W}" height="12" fill="${C.chrome}"/>
  <circle cx="24" cy="20" r="6" fill="#e5734f"/><circle cx="46" cy="20" r="6" fill="#e0b25f"/><circle cx="68" cy="20" r="6" fill="#4cc38a"/>
  <text x="${W / 2}" y="25" text-anchor="middle" fill="${C.title}" font-size="12">the escalation market — live against ${esc(hub.replace("https://", ""))}</text>
${body}</svg>`;
}

// ---- the event timeline → frames with durations ----
const frames = []; // {state, duration (s)}
const push = (state, duration) => frames.push({ state, duration });

push({ typed: 0, shown: 0, cursor: true, endPrompt: false }, TYPE_START); // opening prompt
for (let i = 1; i <= CMD.length; i++) {
  push({ typed: i, shown: 0, cursor: true, endPrompt: false }, 1 / TYPE_CPS);
}
push({ typed: CMD.length, shown: 0, cursor: true, endPrompt: false }, RUN_START - (TYPE_START + CMD.length / TYPE_CPS)); // enter
for (let j = 1; j <= lines.length; j++) {
  const t = lines[j - 1].t / 1000;
  const next = j < lines.length ? lines[j].t / 1000 : t + 0.6;
  push({ typed: CMD.length, shown: j, cursor: false, endPrompt: false }, Math.max(next - t, 0.06));
}
// final hold: prompt returns, cursor blinks 3× then rests
for (let b = 0; b < 6; b++) {
  push({ typed: CMD.length, shown: lines.length, cursor: b % 2 === 0, endPrompt: true }, 0.55);
}
push({ typed: CMD.length, shown: lines.length, cursor: true, endPrompt: true }, 1.4);

const manifest = [];
frames.forEach((f, i) => {
  const name = `frame-${String(i).padStart(3, "0")}.svg`;
  writeFileSync(join(outDir, name), frameSvg(f.state));
  manifest.push({ file: name, duration: Math.round(f.duration * 1000) });
});
writeFileSync(join(outDir, "frames.json"), JSON.stringify({ width: W, height: H, frames: manifest }, null, 2));
console.log(`${frames.length} frames → ${outDir} (${W}x${H}, total ${(frames.reduce((a, f) => a + f.duration, 0)).toFixed(1)}s)`);
