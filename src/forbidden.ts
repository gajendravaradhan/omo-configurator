// Forbidden-assignment data table (§3.1) as a HARD NOT-IN filter (W2.2).
// LOAD-BEARING (bundle §4 + patch P5 note): forbidden filtering is a SEPARATE hard pass, applied
// BEFORE scoring in the solver. It must NEVER be folded into the quality model — folding it in
// would make fit=0 reachable and let forbidden assignments into the output.
//
// Rules (bundle + patches, VERIFIED against omo 4.19.4 chain data 2026-08-07):
//   R1  (S6): hephaestus must NEVER be assigned a DeepSeek model (primary or fallback).
//   R1b (§3.1): hephaestus must NEVER be assigned a MiniMax model.
//   R1c (§3.1): oracle must NEVER be assigned a MiniMax model (sustained-reasoning slot).
//   R1d (§3.1): explore / librarian must NEVER be assigned a Claude Opus model (speed slots).
//   R2 (chain legality): a model may only be served by a provider listed in its chain entry's
//      `providers` array — arbitrary provider/model pairs are forbidden by construction.
//   R3 (schema contract): a model id that never appears in a slot's chain may not be force-assigned.
//      (Injected DeepSeek is the single sanctioned exception — see fallback.ts; it is family-matched.)
//
// INFEASIBLE §3.1 rows (documented, NOT enforced as rules — VERIFIED against live 4.19.4 chains):
//   - visual-engineering: "not Kimi / GLM / Claude-family" — the live chain itself contains
//     claude-opus-5, kimi-k3, glm-5.2. Enforcing the row would empty the slot AND break S2a's
//     brute-force enumeration (which asserts every chain entry is legal). Chain-legality (R2)
//     governs: whatever the chain ships is legal.
//   - artistry: "requires Gemini-family head" — the live chain has NO Gemini entry at all
//     (claude-fable-5, kimi-k3, claude-opus-5). Same infeasibility: the constraint contradicts
//     the installed chain, so it cannot be a hard filter. Re-open if the chain changes.
export interface ForbiddenRef {
  slot: string;
  model: string;
  provider: string;
}

/** Slot-scoped forbidden model prefixes. Runtime-enforced rules below. */
export interface ForbiddenRule {
  slot: string;
  modelPrefix: string;
  reason: string;
}

export const FORBIDDEN_RULES: ForbiddenRule[] = [
  { slot: "hephaestus", modelPrefix: "deepseek", reason: "S6: DeepSeek never injected into hephaestus" },
  { slot: "hephaestus", modelPrefix: "minimax", reason: "§3.1: MiniMax loses coherence on multi-step deep work" },
  { slot: "oracle", modelPrefix: "minimax", reason: "§3.1: oracle needs sustained reasoning; MiniMax drifts" },
  { slot: "explore", modelPrefix: "claude-opus", reason: "§3.1: explore is a speed slot; Opus is cost waste" },
  { slot: "librarian", modelPrefix: "claude-opus", reason: "§3.1: librarian is a speed slot; Opus is cost waste" },
];

/** True when (slot, model, provider) violates a forbidden rule. */
export function isForbidden(ref: ForbiddenRef): boolean {
  for (const rule of FORBIDDEN_RULES) {
    if (rule.slot === ref.slot && ref.model.startsWith(rule.modelPrefix)) return true;
  }
  return false;
}

/** Hard filter: drop every candidate violating a forbidden rule. Applied pre-scoring. */
export function filterForbidden<T extends { model: string }>(slot: string, candidates: T[]): T[] {
  return candidates.filter((c) => !isForbidden({ slot, model: c.model, provider: "" }));
}

/** Documentation of rule R2 — enforced in solver candidate construction (chain-entry providers). */
export const CHAIN_LEGALITY_NOTE =
  "R2: candidates are only built from chain entries' own provider lists — a model is never served by a provider outside its chain entry.";