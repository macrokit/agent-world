import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  generateKeypair,
  keypairFromPem,
  privateKeyToPem,
  type Keypair,
} from "@agentworld/identity";
import { InMemoryHub } from "@agentworld/protocol";

interface EnvelopeEntry {
  kind: "envelope";
  env: unknown;
}
interface MintEntry {
  kind: "mint";
  account: string;
  amount: number;
  rule: string;
  ts: string;
}
/** Marks a journaled envelope that was subsequently rejected — skipped on replay. */
interface RejectedEntry {
  kind: "rejected";
  id: string;
}
type JournalEntry = EnvelopeEntry | MintEntry | RejectedEntry;

/**
 * The durable hub: InMemoryHub semantics behind an append-only JSONL journal.
 *
 * Every state-changing input (accepted envelope, rule-stated mint) is appended
 * to `journal.jsonl`; recovery is deterministic replay — the same property the
 * spec gives the ledger (03 §2.1: append-only, envelope-referenced) applied to
 * the whole hub. The hub keypair persists in `hub.key`.
 *
 * v0 storage is a flat journal, not Postgres: recovery correctness first,
 * storage engine later — swapping the journal for a database changes this
 * file only.
 */
export class DurableHub extends InMemoryHub {
  readonly dir: string;
  private journalPath: string;

  private constructor(dir: string, key: Keypair, opts?: { kappa?: number }) {
    super(key, opts);
    this.dir = dir;
    this.journalPath = join(dir, "journal.jsonl");
  }

  static async open(dir: string, opts?: { kappa?: number }): Promise<DurableHub> {
    mkdirSync(dir, { recursive: true });
    const keyPath = join(dir, "hub.key");
    let key: Keypair;
    if (existsSync(keyPath)) {
      key = keypairFromPem(readFileSync(keyPath, "utf8"));
    } else {
      key = generateKeypair();
      writeFileSync(keyPath, privateKeyToPem(key.privateKey), { mode: 0o600 });
    }
    const hub = new DurableHub(dir, key, opts);
    await hub.replay();
    return hub;
  }

  private async replay(): Promise<void> {
    if (!existsSync(this.journalPath)) return;
    const lines = readFileSync(this.journalPath, "utf8").split("\n").filter(Boolean);
    const entries = lines.map((l) => JSON.parse(l) as JournalEntry);
    const rejected = new Set(entries.flatMap((e) => (e.kind === "rejected" ? [e.id] : [])));
    for (const [i, entry] of entries.entries()) {
      if (entry.kind === "rejected") continue;
      if (entry.kind === "mint") {
        super.mint(entry.account, entry.amount);
        continue;
      }
      const id = (entry.env as { id?: string }).id;
      if (id && rejected.has(id)) continue;
      try {
        await super.handle(entry.env, { replay: true });
      } catch (e) {
        // A journaled, non-rejected envelope was accepted once; failing on
        // replay means corruption or a semantics change — refuse to run.
        throw new Error(`journal replay failed at line ${i + 1}: ${e instanceof Error ? e.message : e}`);
      }
    }
    this.assertConservation();
  }

  private append(entry: JournalEntry): void {
    appendFileSync(this.journalPath, JSON.stringify(entry) + "\n");
  }

  /**
   * Journal-on-verify, apply, tombstone-on-reject.
   *
   * Appending AFTER apply looks cleaner (rejected envelopes never persist)
   * but breaks causal ordering: an in-process award triggers nested
   * accept/deliver envelopes whose handles COMPLETE (and would append)
   * before the award's own append — replaying that order applies effects
   * before their cause. Appending at verify time preserves cause-first
   * order; a rejection appends a tombstone the replay skips. (The crash
   * window between append and tombstone is a known v0 limit — a WAL/txn
   * storage engine closes it later, in this one file.)
   */
  override async handle(raw: unknown, opts?: { replay?: boolean }): Promise<void> {
    if (opts?.replay) return super.handle(raw, opts);
    this.append({ kind: "envelope", env: raw });
    try {
      await super.handle(raw, opts);
    } catch (e) {
      const id = (raw as { id?: string })?.id;
      if (id) this.append({ kind: "rejected", id });
      throw e;
    }
  }

  /** Rule-stated minting (spec 03 §2.3): the rule is recorded with the entry. */
  override mint(account: string, amount: number): void {
    this.mintWithRule(account, amount, "unstated (dev)");
  }

  mintWithRule(account: string, amount: number, rule: string): void {
    super.mint(account, amount);
    this.append({ kind: "mint", account, amount, rule, ts: new Date().toISOString() });
  }
}
