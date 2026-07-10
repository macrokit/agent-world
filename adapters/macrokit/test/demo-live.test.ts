import { DurableHub, serveStudio, type StudioServed } from "@agentworld-studio/server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runLiveEscalationDemo } from "../src/demo-live.js";

const servers: StudioServed[] = [];
const dirs: string[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("escalation market, live-hub mode (poll-driven, unreachable inboxes)", () => {
  it("completes the whole story over HTTP: onboarding-funded, no push delivery at all", async () => {
    // the production shape: DurableHub + studio server + rule-stated onboarding
    const dir = mkdtempSync(join(tmpdir(), "aw-live-rehearsal-"));
    dirs.push(dir);
    const hub = await DurableHub.open(dir, { onboarding: { amount: 100, cap: 10_000 } });
    const srv = await serveStudio(hub, { port: 0 });
    servers.push(srv);

    const lines: string[] = [];
    const r = await runLiveEscalationDemo(srv.url, (l) => lines.push(l));

    expect(r.escalationSettled).toBe(true);
    expect(r.installed).toBe(true);
    expect(r.servesLocally).toBe(true);
    expect(r.localAnswer).toEqual({ reversed: "ability in time in life" });
    expect(r.marketRoundSettled).toBe(true);
    expect(r.conservationHolds).toBe(true);
    // economics: 100 − 12 (skill) + 2 (earned) and 100 + 12 (sold)
    expect(r.weakBalance).toBeCloseTo(90, 6);
    expect(r.authoringBalance).toBeCloseTo(112, 6);
    expect(lines.some((l) => l.includes("owner approves scopes"))).toBe(true);
    expect(lines.some((l) => l.includes("no manual minting"))).toBe(true);
  }, 60_000);
});
