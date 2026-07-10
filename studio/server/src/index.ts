#!/usr/bin/env node
import { DurableHub } from "./durable-hub.js";
import { serveStudio } from "./serve.js";

export { DurableHub } from "./durable-hub.js";
export { serveStudio, type StudioServed } from "./serve.js";

const USAGE = `aw-hub — the Agent World hub (durable, journal-backed)

  aw-hub --dir <state-dir> [--port <n>] [--mint <awId>:<amount>:<rule>]

  --dir    where journal.jsonl and hub.key live (created if missing)
  --port   HTTP port (default 7800)
  --mint   one-off rule-stated mint, then exit (onboarding grants etc.)
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<void> {
  const dir = flag(argv, "dir");
  if (!dir || argv.includes("--help")) {
    console.log(USAGE);
    process.exitCode = dir ? 0 : 1;
    return;
  }

  // Fixed onboarding grant (spec 03 §2.3): each new principal, once, up to a cap.
  const grantAmount = flag(argv, "onboarding") ?? process.env["AW_ONBOARDING"];
  const grantCap = flag(argv, "onboarding-cap") ?? process.env["AW_ONBOARDING_CAP"];
  const onboarding = grantAmount
    ? { amount: Number(grantAmount), ...(grantCap ? { cap: Number(grantCap) } : {}) }
    : undefined;

  const hub = await DurableHub.open(dir, onboarding ? { onboarding } : undefined);

  const mint = flag(argv, "mint");
  if (mint) {
    const [account, amount, ...ruleParts] = mint.split(":");
    const rule = ruleParts.join(":") || "manual grant";
    hub.mintWithRule(account!, Number(amount), rule);
    console.log(`minted ${amount} to ${account} (rule: ${rule})`);
    console.log(`totals: ${JSON.stringify(hub.totals())}`);
    return;
  }

  const port = Number(flag(argv, "port") ?? process.env["AW_HUB_PORT"] ?? 7800);
  // Behind a reverse proxy by default; --host 0.0.0.0 for containers.
  const host = flag(argv, "host") ?? process.env["AW_HUB_HOST"] ?? "127.0.0.1";
  const served = await serveStudio(hub, {
    port,
    host,
    log: (e) => console.log(`${e.ip} ${e.method} ${e.path} ${e.status} ${e.ms}ms`),
  });
  console.log(`aw-hub ${hub.id}`);
  console.log(`  inbox:       ${served.url}/aw/v0/inbox`);
  console.log(`  observatory: ${served.url}/`);
  console.log(`  health:      ${served.url}/healthz  ·  ${served.url}/readyz`);
  console.log(`  state:       ${hub.dir}`);
  console.log(`  totals:      ${JSON.stringify(hub.totals())}`);
  if (onboarding) {
    console.log(`  onboarding:  ${onboarding.amount} ¢r/principal${onboarding.cap ? `, cap ${onboarding.cap}` : ""} — ${JSON.stringify(hub.onboardingStatus())}`);
  }

  // Graceful shutdown: drain in-flight requests, then exit (systemd/Docker SIGTERM).
  let closing = false;
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      if (closing) return;
      closing = true;
      console.log(`\n${sig} — draining…`);
      void served.close().then(() => process.exit(0));
    });
  }
}

// Run as CLI only (not on library import)
if (process.argv[1] && /aw-hub|studio\/server\/dist\/index\.js$/.test(process.argv[1])) {
  await main(process.argv.slice(2));
}
