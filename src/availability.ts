// Availability — which (provider, model) pairs are usable.
// Source: live ~/.cache/opencode/models.json (VERIFIED live structure: `models` is an OBJECT keyed
// by model id, NOT an array as the bundle §1.14 assumed — ground-truth discipline: we parse the
// live shape). Providers declared in inventory are also usable (user verified capacity).
// W0: presence check only. W2.3 maps capability flags from here + tiers.json.
import { existsSync, readFileSync } from "node:fs";
import { modelsCachePath } from "./config.ts";
import type { Inventory } from "./inventory.ts";

export class Availability {
  /** provider id → set of available model ids. Empty set = provider declared but no specific models known. */
  readonly modelsByProvider: Map<string, Set<string>>;

  constructor(modelsByProvider: Map<string, Set<string>>) {
    this.modelsByProvider = modelsByProvider;
  }

  hasModel(provider: string, model: string): boolean {
    const set = this.modelsByProvider.get(provider);
    if (!set) return false;
    if (set.size === 0) return true; // provider declared (inventory) — any chain model on it is usable
    return set.has(model);
  }

  providers(): string[] {
    return [...this.modelsByProvider.keys()];
  }
}

export function availabilityFromModelsFile(path: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const raw = readFileSync(path, "utf8");
  const doc = JSON.parse(raw) as Record<string, { models?: Record<string, unknown> }>;
  for (const [pid, block] of Object.entries(doc)) {
    const models = block?.models;
    if (typeof models !== "object" || models === null || Array.isArray(models)) continue;
    map.set(pid, new Set(Object.keys(models)));
  }
  return map;
}

/** Build Availability from models.json + inventory-declared providers. */
export function loadAvailability(inventory: Inventory, modelsPathOverride?: string): Availability {
  const map = new Map<string, Set<string>>();
  const modelsPath = modelsPathOverride ?? modelsCachePath();
  if (existsSync(modelsPath)) {
    try {
      const fromFile = availabilityFromModelsFile(modelsPath);
      for (const [pid, set] of fromFile) map.set(pid, set);
    } catch {
      // Corrupt/missing cache → fall through to inventory-only availability (report notes this).
    }
  }
  // Inventory-declared providers are usable even without a models.json hit (empty set = any model).
  for (const pid of Object.keys(inventory.providers)) {
    if (!map.has(pid)) map.set(pid, new Set<string>());
  }
  return new Availability(map);
}