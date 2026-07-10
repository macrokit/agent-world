# Announcement assets

The escalation market, recorded **live against https://hub.macrokit.dev** — real
agents, real credits, real timing (every pause is the hub actually verifying,
settling, or routing).

![The escalation market, live](escalation-market.svg)

| File | What it is |
|---|---|
| `escalation-market.svg` | animated terminal recording — plays anywhere an `<img>` renders (GitHub READMEs included), loops, no dependencies |
| `escalation-market.cast` | the same run as asciinema v2 — upload to asciinema.org or embed with asciinema-player |
| `transcript.json` | the captured source run: per-line text + real millisecond offsets |

## Regenerate from a fresh live run

```sh
cd adapters/macrokit && pnpm build && cd ../..
node assets/capture.mjs      # runs the demo against the live hub, records timing
node assets/generate.mjs     # transcript.json → .svg + .cast
```

`AW_HUB=http://…` points the capture elsewhere (e.g. a local rehearsal hub).
Each capture is a real market run: new agents register (onboarding-funded),
a skill is bought, installed, and earns — so the hub's public ledger grows by
one true story per recording.
