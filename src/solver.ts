// Per-slot argmax solver (W0 minimal — the "100-LOC core" milestone).
// W0: fit from chain position only {1.0 head, 0.8 member, 0.5 family-match-only}, capability 1.0.
// W2.3 replaces fit/capability with the full model (family-match × prompt-path × position-decay;
// capability from models.json flags + tiers.json) and the P5 tiebreak chain.
//
// LOAD-BEARING (bundle §4 / patch P5 note): forbidden-assignment filtering is a SEPARATE hard
// NOT-IN pass (W2.2). It must NEVER be folded into scoring — folding it in would make fit=0
// reachable and let forbidden assignments into the output. W0 has no forbidden table yet;
// W2.2 adds the hard filter before scoring.
import type { Availability } from "./availability.ts";
import type { Assignment, Candidate, ChainEntry, SlotChain, SolveResult } from "./types.ts";

/** W0 position-derived fit. W2.3 replaces with family-match × prompt-path × position-decay. */
export function fitFromPosition(position: number): number {
  if (position === 0) return 1.0;
  if (position === 1) return 0.8;
  return 0.5;
}

/** Deterministic tiebreak for W0: earlier chain position, then lexical model id. P5 chain lands in W2.3. */
function compare(a: Candidate, b: Candidate): number {
  if (b.quality !== a.quality) return b.quality - a.quality;
  if (a.entry.position !== b.entry.position) return a.entry.position - b.entry.position;
  return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
}

/** Build a candidate for a chain entry, picking the first available provider. Null when unavailable. */
function candidateFor(entry: ChainEntry, availability: Availability, caps: Map<string, number | null>): Candidate | null {
  const provider = entry.providers.find((p) => availability.hasModel(p, entry.model));
  if (!provider) return null;
  const cap = caps.get(provider);
  return {
    entry,
    provider,
    model: entry.model,
    variant: entry.variant,
    fit: fitFromPosition(entry.position),
    capability: 1.0,
    quality: fitFromPosition(entry.position) * 1.0,
    projectedCost: 0,
    quotaHeadroom: cap ?? 0,
    trusted: cap !== null,
  };
}

/** Solve every slot by independent per-slot argmax (separable — no cross-slot coupling at v1). */
export function solveChains(
  chains: SlotChain[],
  availability: Availability,
  caps: Map<string, number | null>,
  skippedPinned: string[] = [],
): SolveResult {
  const assignments: Assignment[] = [];
  const allUntrusted = [...caps.values()].every((c) => c === null) && caps.size > 0;

  for (const chain of chains) {
    if (skippedPinned.includes(chain.name)) continue;
    const candidates = chain.fallbackChain
      .map((entry) => candidateFor(entry, availability, caps))
      .filter((c): c is Candidate => c !== null);
    if (candidates.length === 0) continue; // unresolved slot — reported by verify/doctor soft-check
    candidates.sort(compare);
    const primary = candidates[0]!;
    const fallbacks = candidates.slice(1);
    const rationale = `quality=${primary.quality.toFixed(2)} (fit=${primary.fit} × capability=${primary.capability}) provider=${primary.provider}`;
    assignments.push({
      slot: chain.name,
      kind: chain.kind,
      primary,
      fallbacks,
      rationale,
      untrusted: !primary.trusted && !allUntrusted,
    });
  }
  return { assignments, allUntrusted, skippedPinned };
}