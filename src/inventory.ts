// Inventory loader. W0: minimal YAML parse + shape/trust guards.
// W3.2 replaces with a full schemas/inventory.yaml + loader (valid load, §7 deletions enforced).
// Bundle §4: trust taxonomy = {remote_api, local_estimation, user_declared}; NO reserve_policy/promo;
// NO `subscription_flat` trust (Claude-deletion §7). cap=null means uncapped — NEVER apply σ to null.
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { ProviderCapacity, TrustSource } from "./types.ts";
import { PlutusError } from "./errors.ts";
import { EXIT } from "./types.ts";

const TRUST_TAXONOMY: ReadonlySet<string> = new Set(["remote_api", "local_estimation", "user_declared"]);
const FORBIDDEN_TOP_KEYS = ["reserve_policy", "promo", "anthropic_flat", "subscription_flat"];

export interface Inventory {
  version: number; providers: Record<string, ProviderCapacity>;
  /** Consumption-limit demand profile (optional).*/
  demand?: { per_slot_tokens?: Record<string, number>; default_tokens?: number; sigma?: number; observed_span_hours?: number };
}

/** Parse inventory.yaml text into an Inventory; throws PlutusError(VALIDATION) on shape violations. */
export function parseInventory(raw: string, source = "inventory"): Inventory {
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (e: unknown) {
    throw new PlutusError(`Inventory ${source} is not valid YAML: ${(e as Error).message}`, EXIT.VALIDATION);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new PlutusError(`Inventory ${source} must be a YAML mapping`, EXIT.VALIDATION);
  }
  const d = doc as Record<string, unknown>;

  for (const key of FORBIDDEN_TOP_KEYS) if (key in d) throw new PlutusError(`Inventory ${source} must not contain \`${key}\` (bundle §7 deletion)`, EXIT.VALIDATION);

  const version = typeof d.version === "number" ? d.version : 1;
  const providersRaw = d.providers;
  if (typeof providersRaw !== "object" || providersRaw === null || Array.isArray(providersRaw)) {
    throw new PlutusError(`Inventory ${source} requires a \`providers\` mapping`, EXIT.VALIDATION);
  }

  const providers: Record<string, ProviderCapacity> = {};
  for (const [pid, p] of Object.entries(providersRaw as Record<string, unknown>)) {
    if (typeof p !== "object" || p === null || Array.isArray(p)) throw new PlutusError(`Provider \`${pid}\` in ${source} must be a mapping`, EXIT.VALIDATION);
    const pp = p as Record<string, unknown>;
    // Bundle §7 deletions hold at EVERY nesting level — not just the document top level.
    // The anthropic provider was deleted for claiming subscription-flat model access; the
    // prohibition applies inside provider blocks too.
    for (const key of FORBIDDEN_TOP_KEYS) if (key in pp) throw new PlutusError(`Provider \`${pid}\` must not contain \`${key}\` (bundle §7 deletion)`, EXIT.VALIDATION);
    const trust = pp.trust;
    if (typeof trust !== "string" || !TRUST_TAXONOMY.has(trust)) throw new PlutusError(`Provider \`${pid}\` has invalid trust \`${String(trust)}\` — must be one of ${[...TRUST_TAXONOMY].join("|")} (bundle §4)`, EXIT.VALIDATION);
    const cap = pp.cap === undefined ? null : pp.cap;
    if (cap !== null && (typeof cap !== "number" || Number.isNaN(cap) || cap < 0 || cap > 1)) throw new PlutusError(`Provider \`${pid}\` cap must be a number in [0,1] or null`, EXIT.VALIDATION);
    const windowResets = typeof pp.window_resets === "string" ? pp.window_resets : null;
    // Consumption-limit input. Absent/null = UNKNOWN -> provider stays untrusted + overflow-only.
    // A guessed capacity poisons every downstream recommendation, so it is never inferred.
    const wtRaw = pp.window_tokens;
    if (wtRaw !== undefined && wtRaw !== null && (typeof wtRaw !== "number" || !Number.isFinite(wtRaw) || wtRaw <= 0)) {
      throw new PlutusError(`Provider \`${pid}\` window_tokens must be a positive number or null`, EXIT.VALIDATION);
    }
    const windowTokens = typeof wtRaw === "number" ? wtRaw : null;
    const wdRaw = pp.window_dollars;
    if (wdRaw !== undefined && wdRaw !== null && (typeof wdRaw !== "number" || !Number.isFinite(wdRaw) || wdRaw <= 0)) {
      throw new PlutusError(`Provider \`${pid}\` window_dollars must be a positive number or null`, EXIT.VALIDATION);
    }
    const windowDollars = typeof wdRaw === "number" ? wdRaw : null;
    if (windowDollars !== null && windowTokens !== null) {
      throw new PlutusError(`Provider \`${pid}\` cannot declare BOTH window_tokens and window_dollars — pick the unit the provider actually bills in`, EXIT.VALIDATION);
    }
    const metered = pp.metered === true;
    if (metered && windowTokens !== null) {
      throw new PlutusError(`Provider \`${pid}\` cannot be both metered and declare window_tokens`, EXIT.VALIDATION);
    }
    providers[pid] = { provider: pid, cap: cap as number | null, windowResets, windowTokens, windowDollars, metered, trust: trust as TrustSource };
  }
  const demandRaw = (doc as Record<string, unknown>).demand;
  return { version, providers, demand: (demandRaw ?? undefined) as Inventory["demand"] };
}

/** Load inventory.yaml from disk. */
export function loadInventory(path: string): Inventory {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e: unknown) {
    throw new PlutusError(`Cannot read inventory at ${path}: ${(e as Error).message}`, EXIT.RUNTIME);
  }
  return parseInventory(raw, path);
}

/** Map of provider id → cap (null = uncapped). */
export function capMap(inv: Inventory): Map<string, number | null> {
  return new Map(Object.entries(inv.providers).map(([pid, p]) => [pid, p.cap]));
}

/** True when the trusted-capacity set is EMPTY (bundle P1 → S3b all-untrusted degenerate case). */
export function trustedSetEmpty(inv: Inventory): boolean {
  return Object.values(inv.providers).every((p) => p.cap === null);
}


// ---- Consumption-limit inputs (user requirement) ---------------------------------------------
// window_tokens is the ABSOLUTE window capacity. Absent/null = unknown -> that provider stays
// untrusted and overflow-only; a guessed number here would silently poison every recommendation,
// so `plutus discover` must populate it or the user must declare it.

/** provider id -> absolute window capacity in tokens (null = unknown). */
export function windowTokensMap(inv: Inventory): Map<string, number | null> {
  const m = new Map<string, number | null>();
  for (const [pid, p] of Object.entries(inv.providers)) {
    // Metered providers are UNBOUNDED, not unknown: Infinity, so the capacity constraint never
    // binds and selection is governed by $ cost via value density instead.
    // Dollar-denominated providers are handled by dollarWindowMap; token map ignores them.
    m.set(pid, p.metered ? Number.POSITIVE_INFINITY : (p.windowDollars != null ? null : (p.windowTokens ?? null)));
  }
  return m;
}

/** provider id -> ISO window reset timestamp (for burn-rate forecasting). */
export function windowResetsMap(inv: Inventory): Map<string, string | undefined> {
  const m = new Map<string, string | undefined>();
  for (const [pid, p] of Object.entries(inv.providers)) {
    m.set(pid, p.windowResets ?? undefined);
  }
  return m;
}

export interface DemandProfile {
  perSlot?: Record<string, number>; defaultTokens: number; sigma: number; observedSpanHours: number;
}

/** Demand block from inventory.yaml, with conservative defaults. */
export function demandProfile(inv: Inventory): DemandProfile {
  const d = inv.demand as Record<string, unknown> | undefined;
  const num = (v: unknown, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
  return {
    perSlot: (d?.per_slot_tokens as Record<string, number>) ?? undefined,
    defaultTokens: num(d?.default_tokens, 250_000),
    sigma: Math.min(1, num(d?.sigma, 0.8)),
    observedSpanHours: num(d?.observed_span_hours, 168),
  };
}


/** provider id -> USD window capacity (opencode-go bills in dollars, not tokens). */
export function windowDollarsMap(inv: Inventory): Map<string, number | null> {
  const m = new Map<string, number | null>();
  for (const [pid, p] of Object.entries(inv.providers)) m.set(pid, p.windowDollars ?? null);
  return m;
}
