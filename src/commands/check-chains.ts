// W1.3 — check-chains: diff parsed chains vs the vendored snapshot; warn on drift with delta;
// exit 3 on unresolved drift (bundle §1.1 pin + drift discipline; W1.4/P8 version-mismatch → exit 3).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractChains, pinnedChainSha, installedOmoVersion, assertOmoVersion } from "../chain.ts";
import { PlutusError } from "../errors.ts";
import { EXIT } from "../types.ts";

export const SNAPSHOT_PATH = join(import.meta.dir, "..", "..", "snapshots", "chains.json");

/** Snapshot path — OMO_PLUTUS_SNAPSHOT_PATH env override for drift tests. */
export function snapshotPath(): string {
  return process.env.OMO_PLUTUS_SNAPSHOT_PATH ?? SNAPSHOT_PATH;
}

export interface DriftResult {
  ok: boolean; sha: string; snapshotSha: string; delta: string[];
}

interface SnapshotSlot {
  kind: string; name: string; fallbackChain: Array<{ providers: string[]; model: string; variant?: string }>;
}

/** Compare current parsed chains against the vendored snapshot. */
export function diffChains(): DriftResult {
  const sha = pinnedChainSha(); const snapshot = JSON.parse(readFileSync(snapshotPath(), "utf8")) as { pinned_sha?: string; slots: SnapshotSlot[] }; const current = extractChains();

  const delta: string[] = []; const snapSlots = new Map(snapshot.slots.map((s) => [`${s.kind}:${s.name}`, s])); const curSlots = new Map(current.map((s) => [`${s.kind}:${s.name}`, s]));

  for (const key of curSlots.keys()) if (!snapSlots.has(key)) delta.push(`+ slot added: ${key}`);
  for (const key of snapSlots.keys()) if (!curSlots.has(key)) delta.push(`- slot removed: ${key}`);
  for (const key of curSlots.keys()) {
    const s = snapSlots.get(key);
    const c = curSlots.get(key);
    if (!s || !c) continue;
    // Normalize to vendor-relevant fields (providers/model/variant) — position is derived at parse time.
    const norm = (e: { providers: string[]; model: string; variant?: string }) => JSON.stringify({ providers: e.providers, model: e.model, ...(e.variant ? { variant: e.variant } : {}) });
    const sChain = s.fallbackChain.map(norm); const cChain = c.fallbackChain.map(norm);
    if (sChain.length !== cChain.length) delta.push(`~ slot ${key}: chain length ${sChain.length} → ${cChain.length}`);
    else for (let i = 0; i < sChain.length; i++) if (sChain[i] !== cChain[i]) delta.push(`~ slot ${key} entry ${i}: ${sChain[i]} → ${cChain[i]}`);
  }
  return { ok: delta.length === 0, sha, snapshotSha: snapshot.pinned_sha ?? "(missing)", delta };
}

/** `plutus check-chains` command body. */
export async function checkChains(): Promise<void> {
  if (!existsSync(snapshotPath())) {
    throw new PlutusError(`No vendor snapshot at ${snapshotPath()}. Run \`bun run scripts/vendor-snapshot.ts\` first.`, EXIT.RUNTIME);
  }
  const installed = installedOmoVersion();
  try {
    assertOmoVersion(installed);
  } catch (e: unknown) {
    // P8: emit-shape decision was made against a different omo version — unresolved drift → exit 3.
    throw new PlutusError((e as Error).message, EXIT.SPIKE);
  }
  const d = diffChains();
  console.log(`[check-chains] installed omo v${installed}; pinned SHA ${d.sha.slice(0, 12)}…`);
  if (d.ok) {
    if (d.sha !== d.snapshotSha) {
      // Same chains, but the source content hash drifted (comment/format change) — informational.
      console.warn(`[check-chains] chain content hash drifted (snapshot ${d.snapshotSha.slice(0, 12)}… vs parsed ${d.sha.slice(0, 12)}…) — chains structurally identical`);
    }
    console.log("[check-chains] OK — parsed chains match vendored snapshot"); return;
  }
  for (const line of d.delta.slice(0, 50)) console.warn(`[check-chains] DRIFT ${line}`);
  if (d.delta.length > 50) console.warn(`[check-chains] …and ${d.delta.length - 50} more drift lines`);
  throw new PlutusError(
    `Chain drift: parsed chains differ from the vendored snapshot (${d.delta.length} differences). ` +
      `Re-extract with \`bun run scripts/vendor-snapshot.ts\` after reviewing the delta.`,
    EXIT.SPIKE,
  );
}
