import { generateKeypair } from "@agentworld/identity";
import { InMemoryHub, serveHub, type Served } from "@agentworld/protocol";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { exportArchive, init, loadAgent, loadChain, register, sign, verify } from "../src/lib.js";

const dirs: string[] = [];
const servers: Served[] = [];
afterAll(async () => {
  for (const s of servers) await s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "aw-cli-"));
  dirs.push(d);
  return d;
}

describe("aw CLI lib", () => {
  it("init → verify: fresh agent with a verifying genesis chain and distinct keys", () => {
    const dir = join(tmp(), "my-agent");
    const manifest = init(dir, "my-agent");
    expect(manifest.seq).toBe(0);
    expect(manifest.id).not.toBe(manifest.owner);
    expect(verify(dir).id).toBe(manifest.id);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("*.key");
  });

  it("edit agent.json → sign: appends an owner-signed revision; verify catches uncommitted edits", () => {
    const dir = join(tmp(), "editable");
    init(dir, "editable");

    const manifestPath = join(dir, "agent.json");
    const edited = JSON.parse(readFileSync(manifestPath, "utf8"));
    edited.name = "renamed";
    edited.goal = { statement: "a real purpose now" };
    writeFileSync(manifestPath, JSON.stringify(edited, null, 2));

    expect(() => verify(dir)).toThrow(/aw sign/);
    const rev = sign(dir);
    expect(rev.seq).toBe(1);
    expect(rev.name).toBe("renamed");
    expect(verify(dir).goal.statement).toBe("a real purpose now");
    expect(loadChain(dir)).toHaveLength(2);
  });

  it("export writes the portability archive without keys", () => {
    const dir = join(tmp(), "exportable");
    init(dir, "exportable");
    const out = join(tmp(), "archive.json");
    exportArchive(dir, out);
    const archive = JSON.parse(readFileSync(out, "utf8"));
    expect(archive.format).toBe("aw-export/0.1");
    expect(archive.manifestChain).toHaveLength(1);
    expect(JSON.stringify(archive)).not.toContain("PRIVATE KEY");
  });

  it("register publishes the chain to a served hub; loadAgent attaches handlers.mjs", async () => {
    const hub = new InMemoryHub(generateKeypair());
    const hubSrv = await serveHub(hub);
    servers.push(hubSrv);

    const dir = join(tmp(), "registered");
    init(dir, "registered");
    sign(dir); // exercise multi-revision publish: edit-free revision
    await register(dir, hubSrv.url);

    const chains = await hub.searchAgents({ capability: "hello" });
    expect(chains).toHaveLength(1);
    expect(chains[0]).toHaveLength(2);

    const agent = await loadAgent(dir, { hub: hubSrv.url });
    expect(agent.id).toBe(chains[0]![1]!.id);
  });
});
