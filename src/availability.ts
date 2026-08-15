// Availability — which (provider, model) pairs are usable.
// Source: live ~/.cache/opencode/models.json (VERIFIED live structure: `models` is an OBJECT keyed
// by model id, NOT an array as the bundle §1.14 assumed — ground-truth discipline: we parse the
// live shape). Providers declared in inventory are also usable (user verified capacity).
// W0: presence check only. W2.3 maps capability flags from here + tiers.json.
import { existsSync, readFileSync } from "node:fs";
import { modelsCachePath } from "./config.ts";
import type { Inventory } from "./inventory.ts";

/** Capability-relevant model metadata read from the live models.json model entry (W2.3).
 *  Field names follow the live file shape (snake_case flags: `tool_call`, `reasoning`, `family`). */
export interface ModelMeta {
  family?: string; reasoning?: boolean; toolCall?: boolean;
  pricing?: { input?: number; output?: number };
}

export class Availability {
  /** provider id → set of available model ids. Empty set = provider declared but no specific models known. */
  readonly modelsByProvider: Map<string, Set<string>>;
  /** provider id → model id → capability metadata (from models.json). */
  readonly metaByProvider: Map<string, Map<string, ModelMeta>>;

  constructor(modelsByProvider: Map<string, Set<string>>, metaByProvider: Map<string, Map<string, ModelMeta>>) {
    this.modelsByProvider = modelsByProvider;
    this.metaByProvider = metaByProvider;
  }

  hasModel(provider: string, model: string): boolean {
    const set = this.modelsByProvider.get(provider);
    return Boolean(set && (set.size === 0 || set.has(model)));
  }

  /** Capability metadata for a (provider, model) pair; undefined when models.json lacks an entry. */
  modelMeta(provider: string, model: string): ModelMeta | undefined {
    return this.metaByProvider.get(provider)?.get(model);
  }

  /** Model ids known for a provider (empty for inventory-declared providers with no models.json hit). */
  modelsFor(provider: string): string[] {
    return [...(this.modelsByProvider.get(provider) ?? [])];
  }

  providers(): string[] {
    return [...this.modelsByProvider.keys()];
  }
}

interface RawModelEntry {
  family?: unknown; reasoning?: unknown; tool_call?: unknown; pricing?: unknown;
}

function parseMeta(raw: RawModelEntry): ModelMeta {
  const meta: ModelMeta = {};
  if (typeof raw.family === "string") meta.family = raw.family;
  if (typeof raw.reasoning === "boolean") meta.reasoning = raw.reasoning;
  if (typeof raw.tool_call === "boolean") meta.toolCall = raw.tool_call;
  if (raw.pricing && typeof raw.pricing === "object" && !Array.isArray(raw.pricing)) {
    const p = raw.pricing as Record<string, unknown>;
    const pricing: { input?: number; output?: number } = {};
    if (typeof p.input === "number") pricing.input = p.input;
    if (typeof p.output === "number") pricing.output = p.output;
    if (pricing.input !== undefined || pricing.output !== undefined) meta.pricing = pricing;
  }
  return meta;
}

export function availabilityFromModelsFile(path: string): {
  modelsByProvider: Map<string, Set<string>>; metaByProvider: Map<string, Map<string, ModelMeta>>;
} {
  const modelsByProvider = new Map<string, Set<string>>();
  const metaByProvider = new Map<string, Map<string, ModelMeta>>();
  const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, { models?: Record<string, RawModelEntry> }>;
  for (const [pid, block] of Object.entries(doc)) {
    const models = block?.models;
    if (typeof models !== "object" || models === null || Array.isArray(models)) continue;
    modelsByProvider.set(pid, new Set(Object.keys(models)));
    const metas = new Map<string, ModelMeta>();
    for (const [mid, entry] of Object.entries(models)) metas.set(mid, parseMeta(entry));
    metaByProvider.set(pid, metas);
  }
  return { modelsByProvider, metaByProvider };
}

/** Build Availability from models.json + inventory-declared providers. */
export function loadAvailability(inventory: Inventory, modelsPathOverride?: string): Availability {
  const modelsByProvider = new Map<string, Set<string>>();
  const metaByProvider = new Map<string, Map<string, ModelMeta>>();
  const modelsPath = modelsPathOverride ?? modelsCachePath();
  if (existsSync(modelsPath)) {
    try {
      const { modelsByProvider: models, metaByProvider: metas } = availabilityFromModelsFile(modelsPath);
      for (const [pid, set] of models) modelsByProvider.set(pid, set);
      for (const [pid, meta] of metas) metaByProvider.set(pid, meta);
    } catch {
      // Corrupt/missing cache → fall through to inventory-only availability (report notes this).
    }
  }
  // Inventory-declared providers are usable even without a models.json hit (empty set = any model).
  for (const pid of Object.keys(inventory.providers)) {
    if (!modelsByProvider.has(pid)) {
      modelsByProvider.set(pid, new Set<string>()); metaByProvider.set(pid, new Map<string, ModelMeta>());
    }
  }
  return new Availability(modelsByProvider, metaByProvider);
}
