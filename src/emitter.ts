// Emitter — builds + writes the oh-my-opencode.json assignment surface (W4.2).
// Emit shape (VERIFIED by schema inspection 2026-08-05/07, bundle §1.4): agents emit `fallback_models`
// (schema has NO `models` key for agents); categories emit `models` (non-deprecated — schema has both).
//
// W4.2 slot-level deep-merge (bundle §1.8): preserve the user's keys — prompt, prompt_append, tools,
// permission, skills, description, mode, color, displayName, temperature, etc. — and REPLACE only the
// optimizer-owned keys (model, variant, reasoning/reasoningEffort, models/fallback_models). Non-
// optimizer slots (and pinned slots skipped by the solver) keep their existing entries untouched.
// NOTE (bundle §1.8): `providerConcurrency` per-provider merging is a no-op for the omo v4.19.4
// schema — the top level is additionalProperties:false and has no providerConcurrency key; the
// optimizer never emits it, so the merge can only preserve it, and validation gates the result.
//
// Ordering discipline (validate-before-replace, bundle §1.9): build → validate against the LOCAL
// schema (PRIMARY gate, S5) → back up the pre-existing target → tmp+rename into place. A rejected
// (invalid) document never clobbers the target and never creates an orphan backup.
// W4.4: fallback lists are capped at 5 entries.
// Pinned sidecar: ~/.config/omo-plutus/pinned.json ({ version, slots: string[] }) — NEVER written
// into oh-my-opencode.json (schema additionalProperties:false at 3 levels, bundle §2 fact 1).
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Assignment } from "./types.ts";
import { assertValidConfig } from "./validate.ts";
import { pinnedSidecarPath } from "./config.ts";
import { PlutusError } from "./errors.ts";
import { EXIT } from "./types.ts";

/** W4.4 — maximum fallback entries emitted per slot. */
export const FALLBACK_CAP = 5;

/** omo.jsonc container-schema URL (the $schema the plugin's config loader recognizes). */
export const OMO_SCHEMA_URL = "https://raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/assets/omo.schema.json";

/** Optimizer-owned keys — the ONLY keys the merge replaces (bundle §1.8). */
const OWNED_KEYS = new Set(["model", "variant", "reasoning", "reasoningEffort", "models", "fallback_models"]);

export interface EmitResult {
  configPath: string;
  backupPath: string | null;
}

export interface EmitOptions {
  /** Deep-merge into the pre-existing target (bundle §1.8). Default true. */
  merge?: boolean;
}

function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Load the pinned-slots sidecar (~/.config/omo-plutus/pinned.json). Missing sidecar → []. */
export function loadPinnedSlots(path: string = pinnedSidecarPath()): string[] {
  if (!existsSync(path)) return [];
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { slots?: unknown };
    if (Array.isArray(doc.slots)) return doc.slots.filter((s): s is string => typeof s === "string");
  } catch {
    // Corrupt sidecar → treat as empty + loud warning (a broken pin must not silently pin nothing).
    console.warn(`[plutus] warning: pinned sidecar ${path} is corrupt — ignoring (no slots pinned)`);
  }
  return [];
}

/** Serialize one fallback entry the way the schema expects ({ model, variant? }). */
function fallbackEntry(model: string, variant?: string): Record<string, unknown> {
  const o: Record<string, unknown> = { model };
  if (variant) o.variant = variant;
  return o;
}

/**
 * Build the full emitted config document. With `existing`, performs the slot-level deep-merge:
 * user keys preserved, optimizer-owned keys replaced, non-optimizer/pinned slots untouched.
 */
export function buildConfig(assignments: Assignment[], existing?: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = { ...(existing ?? {}) };

  for (const a of assignments) {
    const section = a.kind === "agent" ? "agents" : "categories";
    const slots = ((config[section] ?? {}) as Record<string, unknown>);
    const prev = (slots[a.slot] ?? {}) as Record<string, unknown>;

    // Replace owned keys: drop the optimizer-owned set, then write the new values.
    const merged: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(prev)) if (!OWNED_KEYS.has(k)) merged[k] = v;
    merged.model = a.primary.model;
    if (a.primary.variant) merged.variant = a.primary.variant;
    const fbKey = a.kind === "agent" ? "fallback_models" : "models";
    merged[fbKey] = a.fallbacks.slice(0, FALLBACK_CAP).map((c) => fallbackEntry(c.model, c.variant));

    slots[a.slot] = merged;
    config[section] = slots;
  }

  // Ensure sections exist even when empty (schema has additionalProperties:false — empty objects ok).
  if (!config.agents) config.agents = {};
  if (!config.categories) config.categories = {};

  // Schema REQUIRES top-level git_master (verified against local schema 2026-08-07).
  // Emit the schema's own default block so the emitted config passes the LOCAL validation gate.
  if (!config.git_master) {
    config.git_master = { commit_footer: true, include_co_authored_by: true, git_env_prefix: "GIT_MASTER=1" };
  }
  return config;
}

/**
 * Emit the config: deep-merge (when merge), validate against the LOCAL schema FIRST (primary gate —
 * an invalid document never clobbers the target and never creates a backup), then back up the
 * pre-existing target and tmp+rename into place.
 */
export function emitConfig(assignments: Assignment[], outputPath: string, opts: EmitOptions = {}): EmitResult {
  const merge = opts.merge ?? true;
  mkdirSync(dirname(outputPath), { recursive: true });

  let existing: Record<string, unknown> | undefined;
  if (merge && existsSync(outputPath)) {
    try {
      existing = JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, unknown>;
    } catch (e: unknown) {
      throw new PlutusError(
        `cannot merge into ${outputPath}: existing config is not valid JSON (${(e as Error).message}). ` +
          `Fix or remove it, or pass --no-merge to emit fresh.`,
        EXIT.RUNTIME,
      );
    }
  }

  const config = buildConfig(assignments, existing);
  assertValidConfig(config, "emitted oh-my-opencode.json"); // PRIMARY gate — never write invalid config

  let backupPath: string | null = null;
  if (existsSync(outputPath)) {
    backupPath = `${outputPath}.bak.${ts()}`;
    copyFileSync(outputPath, backupPath);
  }

  const tmp = `${outputPath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  renameSync(tmp, outputPath);

  return { configPath: outputPath, backupPath };
}

// ---- omo.jsonc emit path (the LIVE config OMO 4.19.4 reads: ~/.omo/omo.jsonc) ----
// The container document is { $schema: omo.schema.url, [opencode]: { agents, categories, ... }, ...otherTopLevel }.
// The [opencode] section uses the SAME oh-my-opencode schema the flat emitter validates against
// (verified: omo.schema.json's [opencode] property $id IS oh-my-opencode.schema.json), so the inner
// document is validated with the existing local-schema gate; the wrapper + preserved top-level keys
// are structural. JSONC output: JSON.stringify is valid JSONC (jsonc is a superset).

/** Preserved top-level keys that must survive a merge into an existing omo.jsonc document. */
const OMO_TOP_LEVEL_KEEP = new Set(["codegraph", "[senpi]", "[codex]", "teams", "profiles", "models", "task", "legacy_migrations", "_migrations"]);

/** Build the full omo.jsonc document: { $schema, [opencode]: flatDoc, ...preserved }.
 *  `existing` is the previous omo.jsonc document (wrapper + user keys). When absent, a fresh
 *  [opencode] section is built from scratch. */
export function buildOmoConfig(assignments: Assignment[], existing?: Record<string, unknown>): Record<string, unknown> {
  const container: Record<string, unknown> = {};
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    for (const [k, v] of Object.entries(existing)) {
      if (k === "$schema") continue; // we set the authoritative schema URL
      if (k === "[opencode]") continue; // replaced below
      if (OMO_TOP_LEVEL_KEEP.has(k)) container[k] = v;
    }
  }
  container.$schema = OMO_SCHEMA_URL;

  const prevOpencode = existing?.["[opencode]"] as Record<string, unknown> | undefined;
  const inner = buildConfig(assignments, prevOpencode);
  container["[opencode]"] = inner;
  return container;
}

/** Emit the omo.jsonc document atomically (validate inner [opencode] against the local schema FIRST,
 *  back up the existing target, tmp+rename). Returns { configPath, backupPath }. */
export function emitOmoConfig(assignments: Assignment[], outputPath: string, opts: EmitOptions = {}): EmitResult {
  const merge = opts.merge ?? true;
  mkdirSync(dirname(outputPath), { recursive: true });

  let existing: Record<string, unknown> | undefined;
  if (merge && existsSync(outputPath)) {
    try {
      existing = JSON.parse(readFileSync(outputPath, "utf8")) as Record<string, unknown>;
    } catch (e: unknown) {
      throw new PlutusError(
        `cannot merge into ${outputPath}: existing config is not valid JSON (${(e as Error).message}). ` +
          `Fix or remove it, or pass --no-merge to emit fresh.`,
        EXIT.RUNTIME,
      );
    }
  }

  const container = buildOmoConfig(assignments, existing);
  // PRIMARY gate: the [opencode] section must pass the local oh-my-opencode schema (S5).
  assertValidConfig(container["[opencode]"], "omo.jsonc [opencode] section");

  let backupPath: string | null = null;
  if (existsSync(outputPath)) {
    backupPath = `${outputPath}.bak.${ts()}`;
    copyFileSync(outputPath, backupPath);
  }

  const tmp = `${outputPath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(container, null, 2) + "\n", "utf8");
  renameSync(tmp, outputPath);

  return { configPath: outputPath, backupPath };
}
