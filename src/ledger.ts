// W5.3 — telemetry ledger (P3, ~20 LOC). One JSONL line appended per run to
// ~/.config/omo-plutus/history.jsonl. Append-only — NEVER rewritten, NEVER transmitted. This is v2's
// entire training input (live budget coupling, shadow prices, adaptive rebalancing); it costs ~20
// lines now and saves weeks of waiting later.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ledgerPath as ledgerPathFn } from "./config.ts";
import type { Assignment, TrustSource } from "./types.ts";

export interface LedgerEntry {
  ts: string;
  mode: string;
  chain_sha: string;
  /** provider id → remaining quota headroom snapshot at solve time (null = untrusted). */
  quota_snapshot_per_provider: Record<string, number | null>;
  /** slot → primary model/provider for the run. */
  assignments: Record<string, { model: string; provider: string; quality: number }>;
  trust_levels: Record<string, TrustSource>;
}

/** Append one run record to the ledger. Never rewrites existing content. */
export function appendLedger(entry: LedgerEntry, path: string = ledgerPathFn()): string {
  mkdirSync(dirname(path), { recursive: true });
  const line = JSON.stringify(entry);
  appendFileSync(path, line + "\n", "utf8");
  return path;
}

/** Build a ledger entry from a solve result (caller provides chain_sha + mode). */
export function buildLedgerEntry(
  solve: { assignments: Assignment[] },
  caps: Map<string, number | null>,
  trustLevels: Record<string, TrustSource>,
  chainSha: string,
  mode: string,
): LedgerEntry {
  const assignments: LedgerEntry["assignments"] = {};
  for (const a of solve.assignments) {
    assignments[a.slot] = { model: a.primary.model, provider: a.primary.provider, quality: a.primary.quality };
  }
  return {
    ts: new Date().toISOString(),
    mode,
    chain_sha: chainSha,
    quota_snapshot_per_provider: Object.fromEntries([...caps.entries()].map(([pid, cap]) => [pid, cap])),
    assignments,
    trust_levels: trustLevels,
  };
}
