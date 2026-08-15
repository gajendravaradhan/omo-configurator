// omo-plutus — core domain types.
// Caveat per bundle §4: forbidden filtering is a SEPARATE hard NOT-IN pass (W2.2).
// Never fold forbidden filtering into scoring — that would make fit=0 reachable and let
// forbidden assignments into the output. This coupling is load-bearing; document at the
// solver and the quality model both. See W2.3 in omo-plutus-build-plan.md.

/** Agent slot names that carry runtime fallback chains in oh-my-openagent. */
export type AgentSlot =
  | "sisyphus" | "hephaestus" | "oracle" | "librarian" | "explore" | "multimodal-looker"
  | "prometheus" | "metis" | "momus" | "atlas" | "sisyphus-junior";

/** Category slot names that carry runtime fallback chains. */
export type CategorySlot =
  | "visual-engineering" | "ultrabrain" | "deep" | "artistry" | "quick"
  | "unspecified-low" | "unspecified-high" | "writing";

/** Either kind of slot. 19 slots total carry runtime chains (bundle §1.13). */
export type SlotName = AgentSlot | CategorySlot;

export type SlotKind = "agent" | "category";

/** A single entry in a fallback chain — model + providers that can serve it. */
export interface ChainEntry {
  providers: string[]; model: string; variant?: string; position: number;
}

/** A slot's full runtime requirements from oh-my-openagent. */
export interface SlotChain {
  kind: SlotKind; name: string; fallbackChain: ChainEntry[];
  requiresAnyModel?: boolean; requiresProvider?: string[];
}

/** A model entry from ~/.cache/opencode/models.json — provider+model metadata. */
export interface ModelEntry {
  id: string; provider: string; name?: string;
  // Capability flags live here per bundle §1.14. Captured loose; quality.ts interprets.
  contextWindow?: number; supportsToolCalling?: boolean; supportsImages?: boolean;
  reasoning?: boolean | string;
  pricing?: { input?: number; output?: number } & Record<string, unknown>;
  // Preserve unknown capability fields — models.json is the live ground truth and grows.
  [k: string]: unknown;
}

/** A provider block from models.json: {id, env, npm, api, name, doc, models:[...]}. */
export interface ProviderBlock {
  id: string; env?: string; npm?: string; api?: string; name?: string; doc?: string;
  models: ModelEntry[];
  [k: string]: unknown;
}

/** Source of a capacity figure — bundle §4 trust taxonomy. */
export type TrustSource = "remote_api" | "local_estimation" | "user_declared";

/** A provider's capacity as declared in inventory.yaml. */
export interface ProviderCapacity {
  provider: string; cap: number | null; windowResets?: string | null;
  meteredCost?: { input: number; output: number }; trust: TrustSource;
}

/** One model+provider candidate for a slot, fully scored. */
export interface Candidate {
  entry: ChainEntry; provider: string; model: string; variant?: string;
  fit: number; capability: number; quality: number; projectedCost: number;
  quotaHeadroom: number; trusted: boolean; injected?: boolean;
}

/** A solved assignment — primary model + fallback list for one slot. */
export interface Assignment {
  slot: string; kind: SlotKind; primary: Candidate; fallbacks: Candidate[];
  rationale: string; untrusted?: boolean;
}

/** The full solve result. */
export interface SolveResult {
  assignments: Assignment[]; allUntrusted: boolean; skippedPinned: string[];
}

/** Exit codes per bundle §1.11 — 0=ok, 1=runtime, 2=validation, 3=spike-unresolved/version-mismatch. */
export const EXIT = { OK: 0, RUNTIME: 1, VALIDATION: 2, SPIKE: 3 } as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Modes plutus supports. v1: absolute-best only; adaptive is a refusing stub (W6.2). */
export type OptimizeMode = "absolute-best" | "adaptive";
