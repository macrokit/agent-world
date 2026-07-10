import { createHash } from "node:crypto";
import type { Artifact, Capability } from "./types.js";

/**
 * The `aw-handler/0.1` capability-module profile (spec 02 §8.3):
 * a self-contained ES module (no imports) exporting `handler` — an async
 * function (input) => output. Shipped as a content-addressed data: URL;
 * the capability declaration, scopes, and test cases ride in the artifact.
 */
export const AW_HANDLER_PROFILE = "aw-handler/0.1";

export interface ModuleTestCase {
  input: Record<string, unknown>;
  expected: unknown;
}

export class ModuleError extends Error {}

export function sourceToDataUrl(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

export function sourceHash(source: string): string {
  return "sha256:" + createHash("sha256").update(source, "utf8").digest("hex");
}

/** Build an aw-handler/0.1 capability-module artifact from source text. */
export function buildHandlerModule(opts: {
  source: string;
  capability: Capability;
  cases: ModuleTestCase[];
}): Extract<Artifact, { kind: "capability-module" }> {
  return {
    kind: "capability-module",
    profile: AW_HANDLER_PROFILE,
    hash: sourceHash(opts.source),
    url: sourceToDataUrl(opts.source),
    capability: opts.capability,
    scopes: opts.capability.scopes,
    tests: { cases: opts.cases as unknown as Record<string, unknown>[] } as unknown as Record<string, unknown>,
  };
}

/**
 * Load an aw-handler module: decode the data: URL, verify the content hash
 * (content-addressing is what verification binds to — spec 02 §8), import,
 * and return the exported handler.
 *
 * SECURITY (v0): importing executes the module. The hub runs this to verify
 * before settlement, and an agent runs it only AFTER the owner approved the
 * declared scopes. Sandboxed execution is a v1 concern; v0 hubs are
 * single-operator and local.
 */
export async function loadHandlerModule(
  artifact: Extract<Artifact, { kind: "capability-module" }>,
): Promise<(input: Record<string, unknown>) => Promise<unknown>> {
  if (artifact.profile !== AW_HANDLER_PROFILE) {
    throw new ModuleError(`unsupported module profile: ${artifact.profile}`);
  }
  if (!artifact.url.startsWith("data:text/javascript;base64,")) {
    throw new ModuleError("aw-handler/0.1 modules must ship as base64 data: URLs");
  }
  const source = Buffer.from(artifact.url.slice("data:text/javascript;base64,".length), "base64").toString("utf8");
  if (sourceHash(source) !== artifact.hash) {
    throw new ModuleError("module content does not match its declared hash");
  }
  const mod = (await import(/* @vite-ignore */ artifact.url)) as { handler?: unknown };
  if (typeof mod.handler !== "function") {
    throw new ModuleError("module does not export a handler function");
  }
  return mod.handler as (input: Record<string, unknown>) => Promise<unknown>;
}

/** Run a module against its declared cases; returns per-case pass/fail. */
export async function runModuleCases(
  artifact: Extract<Artifact, { kind: "capability-module" }>,
  cases: ModuleTestCase[],
): Promise<{ passed: number; total: number; failures: Array<{ index: number; error?: string }> }> {
  const handler = await loadHandlerModule(artifact);
  let passed = 0;
  const failures: Array<{ index: number; error?: string }> = [];
  for (const [i, c] of cases.entries()) {
    try {
      const got = await handler(c.input);
      if (JSON.stringify(sortKeys(got)) === JSON.stringify(sortKeys(c.expected))) passed++;
      else failures.push({ index: i });
    } catch (e) {
      failures.push({ index: i, error: String(e) });
    }
  }
  return { passed, total: cases.length, failures };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}
