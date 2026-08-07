// omo-plutus — core domain types.
// Caveat per bundle §4: forbidden filtering is a SEPARATE hard NOT-IN pass (W2.2).
// Never fold forbidden filtering into scoring — that would make fit=0 reachable and let
// forbidden assignments into the output. This coupling is load-bearing; document at the
// solver and the quality model both. See W2.3 in omo-plutus-build-plan.md.

/** Agent slot names that carry runtime fallback chains in oh-my-openagent. */
export type AgentSlot =
  | "sisyphus"
  | "hephaestus"
  | "oracle"
  | "librarian"
  | "explore"
  | "multimodal-looker"
  | "prometheus"
  | "metis"
  | "momus"
  | "atlas"
  | "sisyphus-junior";

/** Category slot names that carry runtime fallback chains. */
export type CategorySlot =
  | "visual-engineering"
  | "ultrabrain"
  | "deep"
  | "artistry"
  | "quick"
  | "unspecified-low"
  | "unspecified-high"
  | "writing";

/** Either kind of slot. 19 slots total carry runtime chains (bundle §1.13). */
export type SlotName = AgentSlot | CategorySlot;

export type SlotKind = "agent" | "category";

/** A single entry in a fallback chain — model + providers that can serve it. */
export interface ChainEntry {
  providers: string[];
  model: string;
  variant?: string;
  /** Position in the chain (0-indexed) — used for fit position-decay + tiebreak #3. */
  position: number;
}

/** A slot's full runtime requirements from oh-my-openagent. */
export interface SlotChain {
  kind: SlotKind;
  name: string;
  fallbackChain: ChainEntry[];
  requiresAnyModel?: boolean;
  requiresProvider?: string[];
}

/** A model entry from ~/.cache/opencode/models.json — provider+model metadata. */
export interface ModelEntry {
  id: string;
  /** Provider id from models.json (e.g. "openai", "opencode-go", "deepseek"). */
  provider: string;
  name?: string;
  // Capability flags live here per bundle §1.14. Captured loose; quality.ts interprets.
  contextWindow?: number;
  supportsToolCalling?: boolean;
  supportsImages?: boolean;
  reasoning?: boolean | string;
  pricing?: {
    input?: number;
    output?: number;
    // metered = per-token > 0 ; flat/subscription = 0 (see W2.3 tiebreak #1).
  } & Record<string, unknown>;
  // Preserve unknown capability fields — models.json is the live ground truth and grows.
  [k: string]: unknown;
}

/** A provider block from models.json: {id, env, npm, api, name, doc, models:[...]}. */
export interface ProviderBlock {
  id: string;
  env?: string;
  npm?: string;
  api?: string;
  name?: string;
  doc?: string;
  models: ModelEntry[];
  [k: string]: unknown;
}

/** Source of a capacity figure — bundle §4 trust taxonomy. */
export type TrustSource = "remote_api" | "local_estimation" | "user_declared";

/** A provider's capacity as declared in inventory.yaml. */
export interface ProviderCapacity {
  provider: string;
  /** Remaining subscription quota (0..1) for windowed (subscription) providers, or null=uncapped (metered/overflow-only). NEVER apply σ to null. */
  cap: number | null;
  /** Subscription window reset, ISO date string, or null for uncapped. */
  windowResets?: string | null;
  /** Projected cost-per-token (metered) in $; null/0 means flat/subscription. */
  meteredCost?: { input: number; output: number };
  trust: TrustSource;
}

/** One model+provider candidate for a slot, fully scored. */
export interface Candidate {
  entry: ChainEntry;
  /** Concrete provider chosen from entry.providers that is present in models.json/inventory. */
  provider: string;
  model: string;
  variant?: string;
  /** fit ∈ {1.0 head, 0.8 member, 0.5 family-match-only, 0 forbidden}. */
  fit: number;
  /** capability ∈ {1.0, 0.7, 0.4} from models.json flags + tiers.json. */
  capability: number;
  /** quality = fit × capability (weighted sum, P5 replacement of product). */
  quality: number;
  /** Projected metered $ per the entry; 0 for flat/subscription (tiebreak #1). */
  projectedCost: number;
  /** Remaining quota headroom on the model's provider (tiebreak #2). */
  quotaHeadroom: number;
  /** Whether the providing capability is trusted (non-null cap) — affects overflow-only rule. */
  trusted: boolean;
}

/** A solved assignment — primary model + fallback list for one slot. */
export interface Assignment {
  slot: string;
  kind: SlotKind;
  primary: Candidate;
  fallbacks: Candidate[];
  /** Why this primary won (quality score + binding constraint, for report). */
  rationale: string;
  /** P1: per-assignment untrusted marker — SUPPRESSED in all-untrusted degenerate case. */
  untrusted?: boolean;
}

/** The full solve result. */
export interface SolveResult {
  assignments: Assignment[];
  /** True when EVERY provider cap is null → single banner emitted, per-assignment markers suppressed. */
  allUntrusted: boolean;
  /** Pinned slots skipped (from sidecar pinned.json). */
  skippedPinned: string[];
}

/** Exit codes per bundle §1.11 — 0=ok, 1=runtime, 2=validation, 3=spike-unresolved/version-mismatch. */
export const EXIT = { OK: 0, RUNTIME: 1, VALIDATION: 2, SPIKE: 3 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Modes plutus supports. v1: absolute-best only; adaptive is a refusing stub (W6.2). */
export type OptimizeMode = "absolute-best" | "adaptive";