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
  version: number;
  providers: Record<string, ProviderCapacity>;
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

  for (const key of FORBIDDEN_TOP_KEYS) {
    if (key in d) throw new PlutusError(`Inventory ${source} must not contain \`${key}\` (bundle §7 deletion)`, EXIT.VALIDATION);
  }

  const version = typeof d.version === "number" ? d.version : 1;
  const providersRaw = d.providers;
  if (typeof providersRaw !== "object" || providersRaw === null || Array.isArray(providersRaw)) {
    throw new PlutusError(`Inventory ${source} requires a \`providers\` mapping`, EXIT.VALIDATION);
  }

  const providers: Record<string, ProviderCapacity> = {};
  for (const [pid, p] of Object.entries(providersRaw as Record<string, unknown>)) {
    if (typeof p !== "object" || p === null || Array.isArray(p)) {
      throw new PlutusError(`Provider \`${pid}\` in ${source} must be a mapping`, EXIT.VALIDATION);
    }
    const pp = p as Record<string, unknown>;
    if ("reserve_policy" in pp || "promo" in pp) {
      throw new PlutusError(`Provider \`${pid}\` must not contain reserve_policy/promo (bundle §7 deletion)`, EXIT.VALIDATION);
    }
    const trust = pp.trust;
    if (typeof trust !== "string" || !TRUST_TAXONOMY.has(trust)) {
      throw new PlutusError(
        `Provider \`${pid}\` has invalid trust \`${String(trust)}\` — must be one of ${[...TRUST_TAXONOMY].join("|")} (bundle §4)`,
        EXIT.VALIDATION,
      );
    }
    const cap = pp.cap === undefined ? null : pp.cap;
    if (cap !== null && (typeof cap !== "number" || Number.isNaN(cap) || cap < 0 || cap > 1)) {
      throw new PlutusError(`Provider \`${pid}\` cap must be a number in [0,1] or null`, EXIT.VALIDATION);
    }
    const windowResets = typeof pp.window_resets === "string" ? pp.window_resets : null;
    providers[pid] = {
      provider: pid,
      cap: cap as number | null,
      windowResets,
      trust: trust as TrustSource,
    };
  }
  return { version, providers };
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