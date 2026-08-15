// Quality model (W2.3). Bundle §3.4 (math-slayer R1, CONCEDED):
//   quality = fit × capability with coarse discrete levels — the α/β product form is DELETED.
//   fit ∈ {1.0 head, 0.8 member, 0.5 family-match-only, 0 forbidden}
//   capability ∈ {1.0, 0.7, 0.4} from models.json flags + tiers.json
//   fit defined EXPLICITLY as family-match × prompt-path × position-decay (β=0 does NOT reproduce
//   chain-position-only — that claim was false).
// P5 (M5): coarse levels make ties the COMMON case → the tiebreak chain is the real decision
//   procedure. Total, deterministic order after `fit × capability`:
//     1. lower projected cost (metered $; flat = 0)
//     2. greater remaining quota headroom on the model's provider
//     3. earlier chain position
//     4. lexical model id (guarantees totality — never omit)
// P6 (M6): tiers.json carries provenance (source_url, as_of, self_reported, benchmark); apply a
//   0.9 discount when self_reported; flag entries older than 90 days in the report.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Availability } from "./availability.ts";
import type { Candidate } from "./types.ts";

export interface TierEntry {
  capability: number; source_url: string; as_of: string;
  self_reported: boolean; benchmark: string;
}

export interface Tiers {
  version: number; as_of: string; families: Record<string, TierEntry>;
}

const DEFAULT_TIERS_PATH = join(import.meta.dir, "..", "tiers.json");

/** Load tiers.json (static data — no fetcher, per bundle §4). */
export function loadTiers(path: string = DEFAULT_TIERS_PATH): Tiers {
  return JSON.parse(readFileSync(path, "utf8")) as Tiers;
}

/** fit level for a chain entry by position (head=1.0, member=0.8). */
export function fitForChainEntry(position: number): number {
  return position === 0 ? 1.0 : 0.8;
}

/** fit for an injected (family-match-only) candidate — S6 DeepSeek injection. */
export const FIT_INJECTED = 0.5;

/** True when the family name starts with gpt- or equals gpt (GPT family for S6 ordering). */
export function isGptFamily(model: string): boolean {
  return model.startsWith("gpt-");
}

/** True when the family name is minimax (S6 ordering boundary). */
export function isMinimaxFamily(model: string): boolean {
  return model.toLowerCase().includes("minimax");
}

/** Capability base from models.json flags: reasoning+tool_call → 1.0, one → 0.7, none → 0.4. */
function capabilityFromFlags(reasoning: unknown, toolCall: unknown): number {
  const r = Boolean(reasoning), t = Boolean(toolCall);
  if (r && t) return 1.0; if (r || t) return 0.7;
  return 0.4;
}

/** Capability from models.json flags + tiers.json family entry, with the 0.9 self-report discount. */
export function computeCapability(
  ref: { provider: string; model: string },
  availability: Availability,
  tiers: Tiers,
): number {
  const entry = availability.modelMeta(ref.provider, ref.model); let base = entry ? capabilityFromFlags(entry.reasoning, entry.toolCall) : 0.7;

  const family = typeof entry?.family === "string" ? entry.family : undefined;
  if (family) {
    const tier = tiers.families[family] ?? tiers.families[family.split("-")[0]!];
    if (tier) base = Math.min(base, tier.capability * (tier.self_reported ? 0.9 : 1.0));
  }
  return Math.round(base * 1000) / 1000;
}

/**
 * P5 total deterministic comparator. Negative → a is BETTER (sorts first).
 * Order: quality desc → cost asc → headroom desc → position asc → model id asc.
 */
export function compareCandidates(a: Candidate, b: Candidate): number {
  const order = b.quality - a.quality || a.projectedCost - b.projectedCost ||
    b.quotaHeadroom - a.quotaHeadroom || a.entry.position - b.entry.position;
  if (order) return order;
  return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
}

/** P6: entries older than 90 days → flagged in report. Returns family names that are stale. */
export function staleTierFamilies(tiers: Tiers, now: Date = new Date()): string[] {
  const cutoff = now.getTime() - 90 * 24 * 60 * 60 * 1000;
  return Object.entries(tiers.families)
    .filter(([, t]) => Date.parse(t.as_of) < cutoff)
    .map(([name]) => name);
}
