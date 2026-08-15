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

/** v2: per-MODEL published benchmark scores on task-matched axes. */
export interface ModelBenchmark {
  agentic_cli?: number; agentic_swe?: number;
  /** Multi-turn tool coherence (tau-bench family). The COMMUNICATOR axis. */
  tool_multiturn?: number;
  /** Expert reasoning depth (GPQA-D / HLE / AIME). The axis for execution-gating slots. */
  reasoning?: number;
  /** Screen and document understanding (OSWorld / OmniDocBench). The VISUAL axis. */
  vision?: number;
  axis_note?: string;
  harness: string;
  source_url: string; as_of: string; self_reported: boolean; note?: string;
  /** Per-axis override: a model can be independently scored on one axis and vendor-scored on
   *  another (GPT-5.6 Sol is independent on Terminal-Bench, vendor-aggregate on SWE-bench Pro).
   *  Falls back to `self_reported` when absent. */
  self_reported_cli?: boolean; self_reported_swe?: boolean;
  /** Published list price, USD per million tokens. */
  price_in_per_mtok?: number; price_out_per_mtok?: number;
}

export interface AxisSpec { benchmark: string; note: string; scale_min: number; scale_max: number; }

export interface Tiers {
  version: number; as_of: string;
  families: Record<string, TierEntry>;
  models?: Record<string, ModelBenchmark>;
  axes?: Record<string, AxisSpec>;
}

export type Axis = "agentic_cli" | "agentic_swe" | "tool_multiturn" | "reasoning" | "vision";

/**
 * Axis WEIGHTS per slot — a model's strength is multi-dimensional, and different agents load on
 * different dimensions. Derived from what each agent actually does (omo's guide) matched to what
 * each benchmark actually measures:
 *
 *  - Communicators (sisyphus, metis, atlas, sisyphus-junior, writing, unspecified-*) load mostly on
 *    tool_multiturn. Research finding that drove this: "models that look great on BFCL can fall
 *    apart on tau because BFCL grades single calls in isolation while tau grades multi-turn
 *    coherence." Sisyphus's prompt spans dozens of tool calls — coherence IS the job.
 *  - Deep specialists (hephaestus, deep) load on agentic_swe + agentic_cli: repo-level autonomous work.
 *  - Gating slots (oracle, momus, ultrabrain) load heavily on reasoning — their output gates
 *    execution, so being wrong is more expensive than being slow.
 *  - Visual slots load on vision, full stop.
 *  - Speed utilities load on agentic_cli (shell/grep competence); depth is not the constraint.
 */
const AXIS_WEIGHTS: Record<string, Partial<Record<Axis, number>>> = {
  sisyphus:            { tool_multiturn: 0.6, agentic_cli: 0.25, reasoning: 0.15 },
  metis:               { tool_multiturn: 0.45, reasoning: 0.4, agentic_cli: 0.15 },
  atlas:               { tool_multiturn: 0.6, agentic_cli: 0.25, agentic_swe: 0.15 },
  "sisyphus-junior":   { agentic_swe: 0.45, tool_multiturn: 0.35, agentic_cli: 0.2 },
  prometheus:          { reasoning: 0.45, tool_multiturn: 0.35, agentic_swe: 0.2 },
  writing:             { tool_multiturn: 0.5, reasoning: 0.5 },
  "unspecified-low":   { tool_multiturn: 0.5, agentic_cli: 0.5 },
  "unspecified-high":  { tool_multiturn: 0.45, reasoning: 0.3, agentic_swe: 0.25 },

  hephaestus:          { agentic_swe: 0.5, agentic_cli: 0.35, reasoning: 0.15 },
  deep:                { agentic_swe: 0.5, agentic_cli: 0.35, reasoning: 0.15 },
  oracle:              { reasoning: 0.6, agentic_swe: 0.25, agentic_cli: 0.15 },
  momus:               { reasoning: 0.6, agentic_swe: 0.25, tool_multiturn: 0.15 },
  ultrabrain:          { reasoning: 0.55, agentic_swe: 0.3, agentic_cli: 0.15 },

  "visual-engineering": { vision: 0.7, agentic_swe: 0.2, agentic_cli: 0.1 },
  artistry:             { vision: 0.8, reasoning: 0.2 },
  "multimodal-looker":  { vision: 0.85, reasoning: 0.15 },

  explore:             { agentic_cli: 0.7, tool_multiturn: 0.3 },
  librarian:           { agentic_cli: 0.6, tool_multiturn: 0.4 },
  quick:               { agentic_cli: 0.7, tool_multiturn: 0.3 },
};

/** Dominant axis, kept for reporting and for the single-axis fallback path. */
export function axisForSlot(slot: string): Axis {
  const w = AXIS_WEIGHTS[slot];
  if (!w) return "agentic_cli";
  return (Object.entries(w).sort((a, b) => b[1]! - a[1]!)[0]![0]) as Axis;
}

export function axisWeightsForSlot(slot: string): Partial<Record<Axis, number>> {
  return AXIS_WEIGHTS[slot] ?? { agentic_cli: 1 };
}

/** Normalize a raw benchmark score onto [0.35,1.0] using the axis scale, then apply the self-report discount. */
export function capabilityFromBenchmark(
  bench: ModelBenchmark, axis: Axis, tiers: Tiers, strict = false,
): number | undefined {
  // strict: return undefined rather than substituting a different axis. The weighted blend needs
  // this — silently swapping in a CLI score for a missing vision score would invent evidence.
  const raw = strict ? bench[axis] : (bench[axis] ?? bench.agentic_cli ?? bench.agentic_swe);
  if (raw === undefined) return undefined;
  const usedAxis: Axis = bench[axis] !== undefined ? axis : (bench.agentic_cli !== undefined ? "agentic_cli" : "agentic_swe");
  const spec = tiers.axes?.[usedAxis];
  const lo = spec?.scale_min ?? 40, hi = spec?.scale_max ?? 92;
  const norm = Math.max(0, Math.min(1, (raw - lo) / (hi - lo)));
  const scaled = 0.35 + norm * 0.65;
  const perAxis = usedAxis === "agentic_cli" ? bench.self_reported_cli
    : usedAxis === "agentic_swe" ? bench.self_reported_swe : undefined;
  const selfReported = perAxis ?? bench.self_reported;
  return Math.round(scaled * (selfReported ? 0.9 : 1.0) * 1000) / 1000;
}

/** Longest-prefix model lookup so `deepseek-v4-flash-0731` matches the `deepseek-v4-flash` entry. */
export function lookupModelBenchmark(tiers: Tiers, model: string): ModelBenchmark | undefined {
  const models = tiers.models; if (!models) return undefined;
  if (models[model]) return models[model];
  let best: ModelBenchmark | undefined, bestLen = 0;
  for (const [id, entry] of Object.entries(models)) {
    if (model.startsWith(id) && id.length > bestLen) { best = entry; bestLen = id.length; }
  }
  return best;
}

const DEFAULT_TIERS_PATH = join(import.meta.dir, "..", "tiers.json");

/** Load tiers.json (static data — no fetcher, per bundle §4). */
export function loadTiers(path: string = DEFAULT_TIERS_PATH): Tiers {
  return JSON.parse(readFileSync(path, "utf8")) as Tiers;
}

// Fit weighting. fit encodes PROMPT-PATH match (does this slot's prompt have a tuned path for this
// model family) — it is NOT a capability claim. The v1 spread (head 1.0 / member 0.8) was a 25%
// penalty that exceeded the entire capability range, so chain position decided almost every slot and
// real benchmark differences were inert: after tiers v2 landed, only 1 of 19 slots changed.
//
// FIT_MEMBER_DEFAULT narrows the spread so capability can actually decide between chain members,
// while the head still keeps a genuine edge. Override with PLUTUS_FIT_MEMBER to explore the
// trade-off, or settle it empirically per slot with `plutus challenge`.
export const FIT_HEAD = 1.0;
export const FIT_MEMBER_DEFAULT = 0.95;

export function fitMemberWeight(): number {
  const raw = process.env.PLUTUS_FIT_MEMBER;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : FIT_MEMBER_DEFAULT;
}

/** fit level for a chain entry by position (head=1.0, member=fitMemberWeight()). */
export function fitForChainEntry(position: number): number {
  return position === 0 ? FIT_HEAD : fitMemberWeight();
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
  ref: { provider: string; model: string; slot?: string },
  availability: Availability,
  tiers: Tiers,
): number {
  // B1: per-model published benchmark on the slot's task axis is the PRIMARY signal.
  const bench = lookupModelBenchmark(tiers, ref.model);
  if (bench) {
    // Weighted blend across the axes this slot actually loads on. Missing axes are dropped and the
    // remaining weights renormalized, so a model is never penalised for an unpublished benchmark —
    // only for a low one.
    const weights = axisWeightsForSlot(ref.slot ?? "");
    let num = 0, den = 0;
    for (const [axis, w] of Object.entries(weights)) {
      const v = capabilityFromBenchmark(bench, axis as Axis, tiers, true);
      if (v !== undefined) { num += v * (w as number); den += w as number; }
    }
    if (den > 0) return Math.round((num / den) * 1000) / 1000;
    const fromBench = capabilityFromBenchmark(bench, axisForSlot(ref.slot ?? ""), tiers);
    if (fromBench !== undefined) return fromBench;
  }
  // Fallback: models.json capability flags, floored by the family tier (v1 behaviour).
  const entry = availability.modelMeta(ref.provider, ref.model);
  let base = entry ? capabilityFromFlags(entry.reasoning, entry.toolCall) : 0.7;
  const family = typeof entry?.family === "string" ? entry.family : undefined;
  if (family) {
    const tier = tiers.families[family] ?? tiers.families[family.split("-")[0]!];
    if (tier) base = Math.min(base, tier.capability * (tier.self_reported ? 0.9 : 1.0));
  }
  return Math.round(base * 1000) / 1000;
}

/** B1 audit surface: which models in the emitted config had NO published benchmark. */
export function modelsWithoutBenchmark(tiers: Tiers, models: string[]): string[] {
  return [...new Set(models.filter((m) => !lookupModelBenchmark(tiers, m)))].sort();
}

/**
 * P5 total deterministic comparator. Negative → a is BETTER (sorts first).
 * Order: quality desc → cost asc → headroom desc → position asc → model id asc.
 */
export function compareCandidates(a: Candidate, b: Candidate): number {
  // Rank by density when the slot is value-seeking; density === quality when lambda is 0, so this
  // reduces to pure-quality ordering for quality-first slots.
  const da = a.density ?? a.quality, db = b.density ?? b.quality;
  const order = db - da || b.quality - a.quality || a.projectedCost - b.projectedCost ||
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


// ---------------------------------------------------------------------------
// VALUE DENSITY — quality per unit of spend.
//
// Quality alone always picks the flagship. On a flat subscription both flagship and budget model
// have projectedCost 0, so the cost tiebreak never fires and the optimizer reaches for the most
// expensive model by default. That is how you exhaust a window early while paying for capability
// you did not need on slots that never needed it.
//
// Worked example: GPT-5.6 Sol scores 64.6 on SWE-bench Pro at $5/$30 per Mtok; GPT-5.6 Luna scores
// 62.7 at $0.20/$1.20 — 97% of the score for ~4% of the output price, a 25x price ratio. On a
// high-volume slot that trade is obviously correct; on `oracle` it is obviously wrong. Density makes
// the difference explicit instead of leaving it to a human to notice.
//
//   density(m) = quality(m) / blendedPrice(m)^lambda
//
// lambda is the cost-aversion knob: 0 reproduces pure-quality ranking, 1 is strongly value-seeking.
// Blended price weights output 3x — agentic workloads are output-dominated, and output is where the
// price spread between tiers is widest.
// ---------------------------------------------------------------------------

/** Blended $/Mtok with output weighted 3x. Returns undefined when the model has no published price. */
export function blendedPrice(bench: ModelBenchmark | undefined): number | undefined {
  if (!bench) return undefined;
  const i = bench.price_in_per_mtok, o = bench.price_out_per_mtok;
  if (i === undefined && o === undefined) return undefined;
  return ((i ?? 0) + 3 * (o ?? 0)) / 4;
}

/**
 * Median published blended price across the catalogue — used to impute a price for models with no
 * published figure.
 *
 * Treating an unpriced model as price-neutral (density = quality) was a BUG: under density ranking
 * it made missing data an ADVANTAGE, so unpriced models beat priced ones outright. Observed live:
 * MiniMax M3 (unpriced, capability 0.643) displaced Kimi K3 (priced, capability 0.713) on `atlas`
 * and `sisyphus-junior`. Imputing the median makes absent data neutral in the intended sense —
 * neither rewarded nor punished — and the report flags every imputation.
 */
export function medianBlendedPrice(tiers: Tiers): number | undefined {
  const priced = Object.values(tiers.models ?? {})
    .map((m) => blendedPrice(m)).filter((p): p is number => p !== undefined && p > 0)
    .sort((a, b) => a - b);
  if (priced.length === 0) return undefined;
  const mid = Math.floor(priced.length / 2);
  return priced.length % 2 ? priced[mid]! : (priced[mid - 1]! + priced[mid]!) / 2;
}

/**
 * Value density. `lambda` 0 => pure quality; higher => stronger preference for cheap capability.
 * An undefined price is IMPUTED to the catalogue median by the caller — never treated as free.
 */
export function valueDensity(quality: number, price: number | undefined, lambda: number): number {
  if (lambda <= 0 || price === undefined || price <= 0) return quality;
  return quality / Math.pow(price, lambda);
}

/** Models in the emitted config whose price was imputed rather than published (report surface). */
export function modelsWithImputedPrice(tiers: Tiers, models: string[]): string[] {
  return [...new Set(models.filter((m) => blendedPrice(lookupModelBenchmark(tiers, m)) === undefined))].sort();
}

// Cost-aversion per slot. This is an OPT-IN WHITELIST, deliberately.
//
// The first cut used a blacklist of quality-first slots, which meant any slot not explicitly listed
// defaulted to cost-cutting. Observed live: `atlas` and `sisyphus-junior` — both of which do real
// implementation work — were handed MiniMax M3 (capability 0.643) over Kimi K3 (0.858) to save
// money. Downgrading a working agent is a worse failure than overspending on it, so the default is
// now quality and a slot must be named to become value-seeking.
//
// These are the genuinely high-volume, low-stakes slots: search, retrieval, and trivial dispatch.
// They run constantly, their output feeds another agent that will catch errors, and they are where
// the Luna-over-Sol trade (97% of the score at ~4% of the price) is unambiguously correct.
const VALUE_SEEKING_SLOTS: ReadonlySet<string> = new Set([
  "explore", "librarian", "quick", "unspecified-low",
]);
export function lambdaForSlot(slot: string, base: number): number {
  return VALUE_SEEKING_SLOTS.has(slot) ? base : 0;
}
