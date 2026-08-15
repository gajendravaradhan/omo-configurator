// Per-slot rule-table argmax solver (W2.4). Bundle §3: solver at launch = per-slot argmax (rule
// table); no MMCKP, no α/β, no hill-climb. Slots are independent (separable — no cross-slot coupling).
//
// Quality model (W2.3, bundle §3.4 math-slayer R1 CONCEDED): quality = fit × capability with coarse
// discrete levels. fit ∈ {1.0 head, 0.8 member, 0.5 injected/family-match-only}; capability from
// models.json flags + tiers.json (0.9 self-report discount, P6) — see quality.ts.
//
// P5 total deterministic order after `fit × capability`: 1. lower projected cost (metered $; flat=0)
// → 2. greater quota headroom → 3. earlier chain position → 4. lexical model id (totality). The coarse
// levels make ties the COMMON case, so this tiebreak chain is the real decision procedure.
//
// LOAD-BEARING (bundle §4 / patch P5 note): forbidden-assignment filtering is a SEPARATE hard NOT-IN
// pass (W2.2, src/forbidden.ts), applied BEFORE scoring. It must NEVER be folded into the quality
// model — folding it in would make fit=0 reachable and let forbidden assignments into the output.
//
// S3/S3b overflow-only: a cap=null (untrusted) provider is assigned ONLY when no trusted candidate
// exists for the slot (assigned after trusted windows fill). σ is NEVER applied to null. When the
// trusted-capacity set is EMPTY (P1/S3b) overflow-only is undefined → pure fit × capability argmax
// with no capacity term; per-assignment untrusted markers are SUPPRESSED (single banner emitted by
// the report; banner-per-line is noise).
//
// S6 DeepSeek injection: GPT-family legal slots (oracle, deep, ultrabrain, prometheus) whose chain
// carries a gpt-* model get available deepseek models injected into the FALLBACK list only — after
// GPT entries, before MiniMax entries, fit 0.5. hephaestus NEVER (hard-blocked by forbidden R1 and
// excluded from the legal slot set).
import type { Availability } from "./availability.ts";
import { filterForbidden } from "./forbidden.ts";
import { compareCandidates, computeCapability, FIT_INJECTED, isGptFamily, isMinimaxFamily, type Tiers } from "./quality.ts";
import type { Assignment, Candidate, ChainEntry, SlotChain, SolveResult } from "./types.ts";

export interface SolveInput {
  chains: SlotChain[]; availability: Availability; caps: Map<string, number | null>; tiers: Tiers; skipPinned?: string[];
}

/** S6: GPT-family legal slots that receive DeepSeek injection. */
const GPT_FAMILY_SLOTS: ReadonlySet<string> = new Set(["oracle", "deep", "ultrabrain", "prometheus"]);

function isDeepseekModel(model: string): boolean {
  return model.startsWith("deepseek");
}

/** Projected metered $ per entry: per-token input+output sum; absent/zero pricing → flat → 0 (P5 #1). */
function projectedCost(pricing: { input?: number; output?: number } | undefined): number {
  return (pricing?.input ?? 0) + (pricing?.output ?? 0);
}

/** Chain-position fit: head = 1.0, member = 0.8 (0.5 is reserved for injected candidates). */
function fitForPosition(position: number): number {
  return position === 0 ? 1.0 : 0.8;
}

/**
 * One candidate per (entry, available provider) — route(s→p) = 1[provider(m_s)=p]. A chain entry
 * listing several providers yields one candidate per usable provider so the P5 tiebreaks (cost,
 * headroom, trust) can distinguish providers serving the same model.
 */
function candidatesForEntry(
  entry: ChainEntry,
  availability: Availability,
  caps: Map<string, number | null>,
  tiers: Tiers,
): Candidate[] {
  const out: Candidate[] = [];
  for (const provider of entry.providers) {
    if (!availability.hasModel(provider, entry.model)) continue;
    const cap = caps.get(provider);
    const fit = fitForPosition(entry.position);
    const capability = computeCapability({ provider, model: entry.model }, availability, tiers);
    out.push({
      entry,
      provider,
      model: entry.model,
      variant: entry.variant,
      fit,
      capability,
      quality: fit * capability,
      projectedCost: projectedCost(availability.modelMeta(provider, entry.model)?.pricing),
      quotaHeadroom: cap ?? 0,
      trusted: cap !== null,
    });
  }
  return out;
}

/** S6: available deepseek models for a legal GPT-family slot (fallbacks only — fit 0.5, injected flag). */
function injectedDeepseek(
  chain: SlotChain,
  availability: Availability,
  caps: Map<string, number | null>,
  tiers: Tiers,
): Candidate[] {
  if (!GPT_FAMILY_SLOTS.has(chain.name)) return [];
  if (!chain.fallbackChain.some((e) => isGptFamily(e.model))) return [];
  const injected: Candidate[] = [];
  for (const provider of availability.providers()) {
    if (!provider.toLowerCase().includes("deepseek")) continue;
    for (const model of availability.modelsFor(provider)) {
      if (!isDeepseekModel(model)) continue;
      const cap = caps.get(provider);
      const capability = computeCapability({ provider, model }, availability, tiers);
      const entry: ChainEntry = { providers: [provider], model, position: chain.fallbackChain.length + injected.length };
      injected.push({
        entry,
        provider,
        model,
        fit: FIT_INJECTED,
        capability,
        quality: FIT_INJECTED * capability,
        projectedCost: projectedCost(availability.modelMeta(provider, model)?.pricing),
        quotaHeadroom: cap ?? 0,
        trusted: cap !== null,
        injected: true,
      });
    }
  }
  injected.sort(compareCandidates);
  return injected;
}

/** Insert injected candidates after the last gpt-* entry and before the first minimax-* entry (S6). */
function insertInjected(list: Candidate[], injected: Candidate[]): Candidate[] {
  if (injected.length === 0) return list;
  let gptEnd = -1, miniStart = -1;
  for (let i = 0; i < list.length; i++) {
    if (isGptFamily(list[i]!.model)) gptEnd = i;
    if (miniStart === -1 && isMinimaxFamily(list[i]!.model)) miniStart = i;
  }
  const at = miniStart >= 0 ? (gptEnd >= 0 ? Math.min(gptEnd + 1, miniStart) : miniStart) : Math.max(gptEnd + 1, 0);
  const copy = [...list];
  copy.splice(at, 0, ...injected);
  return copy;
}

/** Dedupe by model keeping the first (best-scoring) occurrence — the emitted config keys models, not providers. */
function dedupeByModel(list: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return list.filter((c) => !seen.has(c.model) && Boolean(seen.add(c.model)));
}

/** Solve every slot by independent per-slot argmax with the P5 tiebreak chain (deterministic). */
export function solveChains(input: SolveInput): SolveResult {
  const { chains, availability, caps, tiers, skipPinned = [] } = input;
  const assignments: Assignment[] = [];
  // P1/S3b: the trusted-capacity set is EMPTY when every declared cap is null.
  const allUntrusted = caps.size > 0 && [...caps.values()].every((c) => c === null);

  for (const chain of chains) {
    if (skipPinned.includes(chain.name)) continue;

    let candidates = filterForbidden(chain.name, chain.fallbackChain.flatMap((entry) => candidatesForEntry(entry, availability, caps, tiers))); const injected = injectedDeepseek(chain, availability, caps, tiers);
    // 4. S3 overflow-only: while a trusted candidate exists for the slot, untrusted (cap=null)
    //    providers are assigned only after trusted windows fill. S3b (allUntrusted): capacity is
    //    undefined → pure quality argmax, no capacity term.
    if (!allUntrusted && candidates.some((c) => c.trusted)) candidates = candidates.filter((c) => c.trusted);
    if (candidates.length === 0) continue; // unresolved slot — reported by verify/doctor soft-check
    candidates.sort(compareCandidates); candidates = dedupeByModel(insertInjected(candidates, injected));
    const primary = candidates.find((c) => !c.injected) ?? candidates[0]!;
    const fallbacks = candidates.filter((c) => c !== primary);
    const rationale = `quality=${primary.quality.toFixed(3)} (fit=${primary.fit} × capability=${primary.capability}) provider=${primary.provider}`;
    assignments.push({ slot: chain.name, kind: chain.kind, primary, fallbacks, rationale, untrusted: allUntrusted ? undefined : !primary.trusted });
  }
  return { assignments, allUntrusted, skippedPinned: [...skipPinned] };
}
