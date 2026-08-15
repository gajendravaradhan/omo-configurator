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
import { scheduledBlendedPrice } from "./pricing.ts";
import { fitFor, isExcluded, gatesExecution, fitRationale, AGENT_PROFILES } from "./fit-model.ts";
import { filterForbidden } from "./forbidden.ts";
import { blendedPrice, medianBlendedPrice, lambdaForSlot, lookupModelBenchmark, valueDensity, compareCandidates, computeCapability, fitForChainEntry, FIT_INJECTED, isGptFamily, isMinimaxFamily, type Tiers } from "./quality.ts";
import type { Assignment, Candidate, ChainEntry, SlotChain, SolveResult } from "./types.ts";

// INJECTION REMOVED (user decision, 2026-08-15).
//
// Two forms existed: S6 (DeepSeek forced into GPT-family slots, from the original plan §6.4) and
// S6b (any high-capability unchained model). Both were hand-coded vendor preferences bolted on top
// of the scoring model — S6 named one vendor outright; S6b picked eligible slots by hand.
//
// Candidates now come from ONE source: the slot's own chain, extracted from the installed
// oh-my-openagent package. Selection is decided end-to-end by the model we derived together:
//   fit (chain position / prompt-path match) x capability (published benchmarks, task-matched axis)
//     -> value density (quality per unit spend, per-slot lambda)
//     -> hard forbidden filter (pre-scoring)
//     -> capacity constraint in each provider's own billing unit (tokens, USD, or unbounded)
// Nothing more.
//
// CONSEQUENCE, stated plainly: a model absent from a slot's chain can never be selected for it,
// however well it benchmarks. Qwen3.8 Max posts the highest SWE-bench Pro figure on this stack and
// will not appear anywhere. If that becomes the binding limitation, the honest fixes are upstream
// (omo's chains) or empirical (plutus challenge) — not a preference re-introduced here.


export interface SolveInput {
  chains: SlotChain[]; availability: Availability; caps: Map<string, number | null>; tiers: Tiers; skipPinned?: string[];
  /** Cost-aversion base (0 = pure quality). Quality-first slots always use 0 — see lambdaForSlot. */
  costAversion?: number;
  /** Valuation instant. Drives DeepSeek peak/off-peak rates. Defaults to now; --at overrides. */
  at?: Date;
}

/** Projected metered $ per entry: per-token input+output sum; absent/zero pricing → flat → 0 (P5 #1). */
function projectedCost(pricing: { input?: number; output?: number } | undefined): number {
  return (pricing?.input ?? 0) + (pricing?.output ?? 0);
}

/** Chain-position fit — single source of truth in quality.ts (see FIT_MEMBER_DEFAULT rationale). */
function fitForPosition(position: number): number {
  return fitForChainEntry(position);
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
  slotName: string,
  lambda = 0,
  at: Date = new Date(),
): Candidate[] {
  const out: Candidate[] = [];
  // Price resolution order: time-aware schedule (DeepSeek peak/off-peak) -> static tier price
  // -> catalogue median. Unpriced models are imputed so missing data is never an advantage.
  const staticBp = blendedPrice(lookupModelBenchmark(tiers, entry.model)) ?? medianBlendedPrice(tiers);
  for (const provider of entry.providers) {
    if (!availability.hasModel(provider, entry.model)) continue;
    // Per-provider: the SAME model can carry different economics. DeepSeek via the metered direct
    // subscription is exposed to peak surcharges; DeepSeek via opencode-go is a flat subscription
    // and is not. That asymmetry is the point of resolving price per (provider, model).
    const bp = scheduledBlendedPrice(provider, entry.model, at) ?? staticBp;
    const cap = caps.get(provider);
    const fit = fitForPosition(entry.position);
    const capability = computeCapability({ provider, model: entry.model, slot: slotName }, availability, tiers);
    out.push({
      entry,
      provider,
      model: entry.model,
      variant: entry.variant,
      fit,
      capability,
      quality: fit * capability,
      blendedPrice: bp,
      density: valueDensity(fit * capability, bp, lambda),
      projectedCost: projectedCost(availability.modelMeta(provider, entry.model)?.pricing),
      quotaHeadroom: cap ?? 0,
      trusted: cap !== null,
    });
  }
  return out;
}

/** Dedupe by model keeping the first (best-scoring) occurrence — the emitted config keys models, not providers. */
function dedupeByModel(list: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return list.filter((c) => !seen.has(c.model) && Boolean(seen.add(c.model)));
}

/** Solve every slot by independent per-slot argmax with the P5 tiebreak chain (deterministic). */
export function solveChains(input: SolveInput): SolveResult {
  const { chains, availability, caps, tiers, skipPinned = [], costAversion = 0, at = new Date() } = input;
  const assignments: Assignment[] = [];
  // P1/S3b: the trusted-capacity set is EMPTY when every declared cap is null.
  const allUntrusted = caps.size > 0 && [...caps.values()].every((c) => c === null);

  for (const chain of chains) {
    if (skipPinned.includes(chain.name)) continue;

    // Candidates = EVERY model available on a declared provider, scored by omo's own philosophy
    // (see fit-model.ts). Chain membership is no longer a gate: omo's catalogue moves faster than
    // its docs, and a model absent from a chain is not thereby unfit — Qwen3.8 Max is the model
    // omo's guide names the right family for ("Use Qwen" for visual work) yet lists nowhere.
    // Chain position still contributes: being the chain head is evidence the author judged this
    // model best for the slot, so it earns a bonus on top of archetype fit.
    const chainPos = new Map<string, number>();
    chain.fallbackChain.forEach((e, i) => { if (!chainPos.has(e.model)) chainPos.set(e.model, i); });
    const lambda = gatesExecution(chain.name) ? 0 : lambdaForSlot(chain.name, costAversion);

    let candidates: Candidate[] = [];
    for (const provider of availability.providers()) {
      for (const model of availability.modelsFor(provider)) {
        if (isExcluded(chain.name, model)) continue;
        if (!lookupModelBenchmark(tiers, model)) continue; // unscored models are not assignable
        const baseFit = fitFor(chain.name, model);
        if (baseFit <= 0) continue;
        const pos = chainPos.get(model);
        // Chain evidence: head +8%, any chain member +4%, capped at 1.0.
        const chainBonus = pos === undefined ? 1.0 : pos === 0 ? 1.08 : 1.04;
        const fit = Math.min(1, baseFit * chainBonus);
        const capability = computeCapability({ provider, model, slot: chain.name }, availability, tiers);
        const bp = scheduledBlendedPrice(provider, model, at)
          ?? blendedPrice(lookupModelBenchmark(tiers, model)) ?? medianBlendedPrice(tiers);
        const cap = caps.get(provider);
        candidates.push({
          entry: { providers: [provider], model, position: pos ?? 99 },
          provider, model,
          variant: pos !== undefined ? chain.fallbackChain[pos]!.variant : undefined,
          fit, capability, quality: fit * capability,
          blendedPrice: bp, density: valueDensity(fit * capability, bp, lambda),
          projectedCost: projectedCost(availability.modelMeta(provider, model)?.pricing),
          quotaHeadroom: cap ?? 0, trusted: cap !== null,
        });
      }
    }
    candidates = filterForbidden(chain.name, candidates);
    // 4. S3 overflow-only: while a trusted candidate exists for the slot, untrusted (cap=null)
    //    providers are assigned only after trusted windows fill. S3b (allUntrusted): capacity is
    //    undefined → pure quality argmax, no capacity term.
    if (!allUntrusted && candidates.some((c) => c.trusted)) candidates = candidates.filter((c) => c.trusted);
    if (candidates.length === 0) continue; // unresolved slot — reported by verify/doctor soft-check
    candidates.sort(compareCandidates); candidates = dedupeByModel(candidates);
    const primary = candidates[0]!;
    const fallbacks = candidates.filter((c) => c !== primary);
    const rationale = `quality=${primary.quality.toFixed(3)} (fit=${primary.fit} × capability=${primary.capability}) provider=${primary.provider} — ${fitRationale(chain.name, primary.model)}`;
    assignments.push({ slot: chain.name, kind: chain.kind, primary, fallbacks, rationale, untrusted: allUntrusted ? undefined : !primary.trusted });
  }
  return { assignments, allUntrusted, skippedPinned: [...skipPinned] };
}
