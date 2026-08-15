// Consumption-limit enforcement (v1 REQUIREMENT — promoted from v2 by user instruction).
//
// The v1 solver used `cap` only as a tiebreak and an overflow-only flag, so no capacity constraint
// existed anywhere: "best bang for buck within limits" was half-implemented. This module supplies the
// missing half.
//
// Accounting unit (math-slayer R1, bundle §3.3): consumption is NOT Σ tokens. It is
//     consumption(p) = Σ_{s: provider(m_s)=p} demand(s) · multiplier(m_s)
// where multiplier captures per-model quota weighting — opencode-go bills Kimi K3 at 2x
// ("Kimi K3 (2x usage)" in the live Go catalogue). Ignoring the multiplier under-counts the most
// expensive model on the largest provider, which is exactly the failure SPIKE-06 warned about.
//
// SPIKE-06 remains UNVERIFIED for opencode-go's request-tier boundaries. Until it resolves, Go is
// budgeted with a 1x over-estimate and flagged — never silently assumed correct.
//
// Demand source, in precedence order:
//   1. observed per-agent tokens from opencode.db (SPIKE-02 RESOLVED — tokens-history.ts)
//   2. declared `demand.per_slot_tokens` in inventory.yaml
//   3. `demand.default_tokens` flat fallback, flagged as ESTIMATED in the report
import type { Assignment, Candidate } from "./types.ts";

/** Per-model quota weighting. opencode-go bills Kimi K3 at 2x; everything else 1x until measured. */
export function quotaMultiplier(model: string): number {
  return model.startsWith("kimi-k3") ? 2 : 1;
}

/** USD cost of `tokens` on a model, using its blended per-Mtok price. */
export function dollarCost(tokens: number, blendedPricePerMtok: number | undefined): number {
  return blendedPricePerMtok === undefined ? 0 : (tokens / 1_000_000) * blendedPricePerMtok;
}

export interface BudgetInput {
  /** provider id → absolute window capacity in tokens; null/absent = unknown (untrusted). */
  windowTokens: Map<string, number | null>;
  /** provider id → window capacity in USD. opencode-go bills in dollars ($12/5h, $30/week,
   *  $60/month), so counting tokens against it is a unit error: Kimi K3 at $15/Mout consumes
   *  54x the budget of DeepSeek Flash at $0.28/Mout for identical token counts. */
  windowDollars?: Map<string, number | null>;
  /** provider id → remaining fraction 0..1 from quota discovery. */
  caps: Map<string, number | null>;
  /** slot → expected tokens per window. */
  demand: Map<string, number>;
  /** Safety factor applied to KNOWN capacity only — never to null (P1/math-slayer R1). */
  sigma?: number;
}

export interface ProviderBudget {
  provider: string; capacityTokens: number | null; remainingTokens: number | null;
  consumedTokens: number; trusted: boolean; overCommitted: boolean;
}

export interface BudgetResult {
  assignments: Assignment[];
  budgets: ProviderBudget[];
  /** Slots that could not get their first-choice model because capacity was exhausted. */
  demoted: Array<{ slot: string; from: string; to: string; reason: string }>;
  /** Slots assigned despite NO provider having room — the honest failure surface. */
  overCommitted: string[];
  enforced: boolean;
}

/** Effective usable tokens for a provider: capacity × remaining-fraction × sigma. Null stays null. */
export function usableTokens(
  capacityTokens: number | null, capFraction: number | null, sigma: number,
): number | null {
  if (capacityTokens === null || capacityTokens === undefined) return null;
  const frac = capFraction ?? 1;
  return capacityTokens * frac * sigma;
}

/**
 * Capacity-aware assignment. Slots are processed in descending (demand × quality) order — the
 * biggest, most valuable consumers claim scarce capacity first; low-value slots absorb the demotion.
 *
 * For each slot the ranked candidate list (already quality-sorted and forbidden-filtered by the
 * solver) is walked in order and the first candidate whose provider has room is taken. If none has
 * room, the slot keeps its top choice and is recorded in `overCommitted` — the tool reports the
 * breach rather than silently emitting a config that will blow the window.
 */
/** Accurate demotion reason. "window exhausted" is wrong for a provider that declared no window. */
function reasonFor(
  from: Candidate, need: number, dollarProviders: Set<string>, remaining: Map<string, number | null>,
): string {
  const rem = remaining.get(from.provider);
  if (rem === null || rem === undefined) {
    return `${from.provider} declares no capacity (unknown window) — overflow-only, used only when nothing else fits`;
  }
  if (dollarProviders.has(from.provider)) {
    return `${from.provider} window exhausted — needed $${dollarCost(need, from.blendedPrice).toFixed(2)}, $${rem.toFixed(2)} left`;
  }
  return `${from.provider} window exhausted — needed ${Math.round(need * quotaMultiplier(from.model)).toLocaleString()} tokens`;
}

export function enforceBudget(
  assignments: Assignment[], input: BudgetInput,
): BudgetResult {
  const sigma = input.sigma ?? 0.8;
  const remaining = new Map<string, number | null>();
  const capacity = new Map<string, number | null>();
  // Providers whose window is denominated in USD rather than tokens.
  const dollarProviders = new Set<string>();
  for (const [p, capTokens] of input.windowTokens) {
    const usable = usableTokens(capTokens, input.caps.get(p) ?? null, sigma);
    capacity.set(p, usable); remaining.set(p, usable);
  }
  for (const [p, capUsd] of input.windowDollars ?? []) {
    if (capUsd == null) continue;
    dollarProviders.add(p);
    const usable = usableTokens(capUsd, input.caps.get(p) ?? null, sigma);
    capacity.set(p, usable); remaining.set(p, usable);
  }
  const consumed = new Map<string, number>();

  const enforced = [...capacity.values()].some((v) => v !== null);
  if (!enforced) {
    return {
      assignments, demoted: [], overCommitted: [], enforced: false,
      budgets: [...input.caps.keys()].map((provider) => ({
        provider, capacityTokens: null, remainingTokens: null, consumedTokens: 0,
        trusted: false, overCommitted: false,
      })),
    };
  }

  const ordered = [...assignments].sort((a, b) => {
    const da = (input.demand.get(a.slot) ?? 0) * a.primary.quality;
    const db = (input.demand.get(b.slot) ?? 0) * b.primary.quality;
    return db - da || (a.slot < b.slot ? -1 : 1);
  });

  const demoted: BudgetResult["demoted"] = [];
  const overCommitted: string[] = [];
  const out = new Map<string, Assignment>();

  for (const asg of ordered) {
    const need = input.demand.get(asg.slot) ?? 0;
    const ranked: Candidate[] = [asg.primary, ...asg.fallbacks];
    let chosen: Candidate | undefined;

    for (const cand of ranked) {
      const rem = remaining.get(cand.provider);
      // Spend in the provider's OWN unit: USD for dollar-denominated windows, tokens otherwise.
      const cost = dollarProviders.has(cand.provider)
        ? dollarCost(need, cand.blendedPrice)
        : need * quotaMultiplier(cand.model);
      // Unknown capacity (null) is not a licence to spend — it is only usable when no
      // known-capacity candidate fits (overflow-only, per S3).
      if (rem === null || rem === undefined) continue;
      if (rem >= cost) { chosen = cand; break; }
    }
    if (!chosen) {
      const overflow = ranked.find((c) => (remaining.get(c.provider) ?? undefined) === null);
      if (overflow) chosen = overflow;
    }
    if (!chosen) { chosen = asg.primary; overCommitted.push(asg.slot); }

    if (chosen !== asg.primary) {
      demoted.push({
        slot: asg.slot, from: `${asg.primary.model} (${asg.primary.provider})`,
        to: `${chosen.model} (${chosen.provider})`,
        reason: reasonFor(asg.primary, need, dollarProviders, remaining),
      });
    }

    const rem = remaining.get(chosen.provider);
    const spend = dollarProviders.has(chosen.provider)
      ? dollarCost(need, chosen.blendedPrice)
      : need * quotaMultiplier(chosen.model);
    if (rem !== null && rem !== undefined) remaining.set(chosen.provider, rem - spend);
    consumed.set(chosen.provider, (consumed.get(chosen.provider) ?? 0) + spend);

    const rest = [asg.primary, ...asg.fallbacks].filter((c) => c !== chosen);
    out.set(asg.slot, { ...asg, primary: chosen, fallbacks: rest, budgetDemoted: chosen !== asg.primary });
  }

  const budgets: ProviderBudget[] = [...capacity.keys()].map((provider) => ({
    provider,
    capacityTokens: capacity.get(provider) ?? null,
    remainingTokens: remaining.get(provider) ?? null,
    consumedTokens: consumed.get(provider) ?? 0,
    trusted: capacity.get(provider) !== null,
    overCommitted: (remaining.get(provider) ?? 1) < 0,
  }));

  return {
    assignments: assignments.map((a) => out.get(a.slot) ?? a),
    budgets, demoted, overCommitted, enforced: true,
  };
}

/**
 * Build per-slot demand. Observed history wins; declared per-slot next; flat default last.
 * Returns the demand map plus the provenance so the report can label estimates honestly.
 */
export function buildDemand(
  slots: string[],
  observed: Map<string, number>,
  declared: Record<string, number> | undefined,
  defaultTokens: number,
): { demand: Map<string, number>; source: Map<string, "observed" | "declared" | "default"> } {
  const demand = new Map<string, number>(), source = new Map<string, "observed" | "declared" | "default">();
  for (const slot of slots) {
    const obs = observed.get(slot);
    if (obs !== undefined && obs > 0) { demand.set(slot, obs); source.set(slot, "observed"); continue; }
    const dec = declared?.[slot];
    if (dec !== undefined && dec > 0) { demand.set(slot, dec); source.set(slot, "declared"); continue; }
    demand.set(slot, defaultTokens); source.set(slot, "default");
  }
  return { demand, source };
}

// ---------------------------------------------------------------------------
// Burn-rate forecasting (prior art: PhilippPolterauer/opencode-quotas uses linear regression on
// usage history to predict exhaustion; day0ops/quota-management calls this "forecast exhaustion —
// burn-rate projection alerts when spend will exceed budget before the period ends").
//
// A static "does it fit" check is not enough: a window can have room RIGHT NOW and still blow before
// it resets. This projects observed burn to the reset boundary and reports the breach ahead of time.
// ---------------------------------------------------------------------------

export interface BurnForecast {
  provider: string;
  /** Tokens consumed per hour, from observed history over the sampled span. */
  burnPerHour: number;
  /** Hours until the window resets (from inventory `window_resets`). */
  hoursToReset: number | null;
  /** Projected additional consumption before reset at the current rate. */
  projectedTokens: number;
  /** Tokens available right now. */
  remainingTokens: number | null;
  /** True when projection exceeds what's left — the actionable alert. */
  willExhaust: boolean;
  /** Hours until exhaustion at the current rate; null when burn is zero or capacity unknown. */
  hoursToExhaustion: number | null;
}

/**
 * Project whether each provider's window survives to its reset at the observed burn rate.
 * `observedTokens` is total tokens seen for that provider over `observedSpanHours`.
 */
export function forecastBurn(
  budgets: ProviderBudget[],
  observedTokens: Map<string, number>,
  observedSpanHours: number,
  windowResets: Map<string, string | undefined>,
  now: Date = new Date(),
): BurnForecast[] {
  return budgets.map((b) => {
    const seen = observedTokens.get(b.provider) ?? 0;
    const burnPerHour = observedSpanHours > 0 ? seen / observedSpanHours : 0;
    const resetIso = windowResets.get(b.provider);
    const hoursToReset = resetIso
      ? Math.max(0, (Date.parse(resetIso) - now.getTime()) / 3_600_000)
      : null;
    const projectedTokens = hoursToReset === null ? 0 : burnPerHour * hoursToReset;
    const remaining = b.remainingTokens;
    // A zero burn rate can never exhaust anything. Without this guard an over-committed provider
    // (remaining < 0) trips the alert with 0 tok/h and an undefined ETA — noise that trains the
    // user to ignore real alerts. Over-commitment is reported by enforceBudget, not here.
    const willExhaust = burnPerHour > 0 && remaining !== null && remaining >= 0
      && hoursToReset !== null && projectedTokens > remaining;
    const hoursToExhaustion = remaining !== null && remaining >= 0 && burnPerHour > 0 ? remaining / burnPerHour : null;
    return {
      provider: b.provider, burnPerHour, hoursToReset, projectedTokens,
      remainingTokens: remaining, willExhaust, hoursToExhaustion,
    };
  });
}
