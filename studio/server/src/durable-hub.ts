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
type JournalEntry = EnvelopeEntry | MintEntry;

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
    for (const [i, line] of lines.entries()) {
      const entry = JSON.parse(line) as JournalEntry;
      if (entry.kind === "mint") {
        super.mint(entry.account, entry.amount);
      } else {
        try {
          await super.handle(entry.env, { replay: true });
        } catch (e) {
          // A journaled envelope was accepted once; failing on replay means
          // corruption or a semantics change — refuse to run on bad state.
          throw new Error(`journal replay failed at line ${i + 1}: ${e instanceof Error ? e.message : e}`);
        }
      }
    }
    this.assertConservation();
  }

  private append(entry: JournalEntry): void {
    appendFileSync(this.journalPath, JSON.stringify(entry) + "\n");
  }

  /** Journal-then-apply is wrong (a rejected envelope must not persist); apply-then-journal. */
  override async handle(raw: unknown, opts?: { replay?: boolean }): Promise<void> {
    await super.handle(raw, opts);
    if (!opts?.replay) this.append({ kind: "envelope", env: raw });
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
