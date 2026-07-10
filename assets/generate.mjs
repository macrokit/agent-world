/**
 * Generate the announcement assets from a captured live-demo transcript.
 *
 *   node assets/capture.mjs      # run the demo against the live hub, record timings
 *   node assets/generate.mjs     # transcript.json → escalation-market.svg + .cast
 *
 * The SVG is a self-contained animated terminal (CSS keyframes, loops) that
 * renders anywhere an <img> does — GitHub READMEs included. The .cast is
 * asciinema v2, uploadable to asciinema.org or embeddable with asciinema-player.
 * Timing in both is the REAL timing of the captured run against the live hub.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const { hub, captured, lines } = JSON.parse(readFileSync(here("transcript.json"), "utf8"));

const CMD = "pnpm demo:live";
const TYPE_START = 0.6; // s — when typing begins
const TYPE_CPS = 16; // typing speed
const RUN_START = TYPE_START + CMD.length / TYPE_CPS + 0.5; // enter pressed
const HOLD = 4.5; // s of stillness before the loop restarts

// ---------------------------------------------------------------------------
// semantic tokenizing (shared by SVG + ANSI)
// ---------------------------------------------------------------------------
const PREFIX_W = 13; // the aligned label column in demo output
const RULES = [
  { re: /"[^"]*"|'[^']*'/, cls: "acc" }, // quoted strings
  { re: /\b(accepted|holds ✓|yes|LOCALLY|settled|true)\b/, cls: "ok" },
  { re: /\bfalse\b/, cls: "warn" },
];

function tokenize(text) {
  // split off the aligned prefix column
  const m = text.match(/^(\S+(?: \S+)?)(\s{2,})(.*)$/);
  const out = [];
  let rest;
  if (m && m[1].length <= PREFIX_W) {
    out.push({ cls: "dim", s: m[1] + m[2] });
    rest = m[3];
  } else {
    rest = text;
  }
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

// ---------------------------------------------------------------------------
// the animated SVG terminal
// ---------------------------------------------------------------------------
const C = {
  bg: "#0e1116", chrome: "#161b22", line: "#262d38",
  txt: "#dbe2ea", dim: "#8b96a5", acc: "#5fb2ff", ok: "#4cc38a", warn: "#e5734f",
  title: "#8b96a5", promptGreen: "#4cc38a",
};
const FS = 13; // font size
const LH = 22; // line height
const PADX = 26;
const TOP = 64; // below chrome bar
const W = 980;

const rows = []; // {t (s), tspans:[{cls,s}], isCmdChar?}
rows.push({ t: 0.15, tspans: [{ cls: "prompt", s: "$ " }] });
const totalDur = RUN_START + lines[lines.length - 1].t / 1000 + HOLD;

const H = TOP + (lines.length + 2) * LH + 26;

let svgRows = "";
let styles = "";
let anim = 0;
const pct = (s) => ((s / totalDur) * 100).toFixed(3);
function reveal(id, atSec) {
  styles += `#${id}{opacity:0;animation:r${id} ${totalDur}s steps(1,end) infinite}@keyframes r${id}{0%{opacity:0}${pct(atSec)}%{opacity:0}${pct(atSec + 0.02)}%{opacity:1}98.6%{opacity:1}100%{opacity:0}}\n`;
}

// prompt + per-char typed command
let y = TOP;
svgRows += `<text x="${PADX}" y="${y}" id="p0"><tspan class="prompt">$ </tspan>`;
reveal("p0", 0.15);
[...CMD].forEach((ch, i) => {
  const id = `c${i}`;
  svgRows += `<tspan id="${id}" class="txt">${esc(ch)}</tspan>`;
  reveal(id, TYPE_START + i / TYPE_CPS);
});
svgRows += `</text>\n`;

// output lines at their real captured offsets
lines.forEach((ln, i) => {
  y += LH * (i === 0 ? 1.4 : 1);
  const id = `l${anim++}`;
  const tspans = tokenize(ln.text)
    .map((t) => `<tspan class="${t.cls}">${esc(t.s)}</tspan>`)
    .join("");
  svgRows += `<text x="${PADX}" y="${y}" id="${id}">${tspans}</text>\n`;
  reveal(id, RUN_START + ln.t / 1000);
});

// trailing prompt with blinking cursor after the run completes
y += LH * 1.4;
const endAt = RUN_START + lines[lines.length - 1].t / 1000 + 0.6;
svgRows += `<text x="${PADX}" y="${y}" id="pend"><tspan class="prompt">$ </tspan><tspan id="cursor" class="txt">▊</tspan></text>\n`;
reveal("pend", endAt);
styles += `#cursor{animation:blink 1.1s steps(1,end) infinite}@keyframes blink{50%{opacity:0}}\n`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="${FS}">
  <title>The escalation market, live: a weak agent buys a skill from a stranger and earns with it — ${hub}</title>
  <style>
    .txt{fill:${C.txt}} .dim{fill:${C.dim}} .acc{fill:${C.acc}} .ok{fill:${C.ok}} .warn{fill:${C.warn}} .prompt{fill:${C.promptGreen}}
    ${styles}
  </style>
  <rect width="${W}" height="${H}" rx="12" fill="${C.bg}" stroke="${C.line}"/>
  <rect width="${W}" height="40" rx="12" fill="${C.chrome}"/>
  <rect y="28" width="${W}" height="12" fill="${C.chrome}"/>
  <circle cx="24" cy="20" r="6" fill="#e5734f"/><circle cx="46" cy="20" r="6" fill="#e0b25f"/><circle cx="68" cy="20" r="6" fill="#4cc38a"/>
  <text x="${W / 2}" y="25" text-anchor="middle" fill="${C.title}" font-size="12">the escalation market — live against ${hub.replace("https://", "")}</text>
${svgRows}</svg>
`;
writeFileSync(here("escalation-market.svg"), svg);

// ---------------------------------------------------------------------------
// asciinema v2 cast (ANSI-colored, same real timing)
// ---------------------------------------------------------------------------
const A = { txt: "[0m", dim: "[90m", acc: "[36m", ok: "[32m", warn: "[33m", prompt: "[32m" };
const events = [];
events.push([0.15, "o", `${A.prompt}$ ${A.txt}`]);
[...CMD].forEach((ch, i) => events.push([TYPE_START + i / TYPE_CPS, "o", ch]));
events.push([RUN_START - 0.1, "o", "\r\n"]);
lines.forEach((ln) => {
  const ansi = tokenize(ln.text).map((t) => `${A[t.cls] ?? A.txt}${t.s}`).join("") + A.txt;
  events.push([RUN_START + ln.t / 1000, "o", ansi + "\r\n"]);
});
events.push([endAt, "o", `${A.prompt}$ ${A.txt}`]);

const cast =
  JSON.stringify({
    version: 2,
    width: 120,
    height: lines.length + 6,
    timestamp: Math.floor(new Date(captured).getTime() / 1000),
    title: `Agent World — the escalation market, live against ${hub}`,
    env: { SHELL: "/bin/zsh", TERM: "xterm-256color" },
  }) +
  "\n" +
  events.map((e) => JSON.stringify(e)).join("\n") +
  "\n";
writeFileSync(here("escalation-market.cast"), cast);

console.log(`wrote escalation-market.svg (${(svg.length / 1024).toFixed(1)} KB, ${totalDur.toFixed(1)}s loop)`);
console.log(`wrote escalation-market.cast (${events.length} events)`);
