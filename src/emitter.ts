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
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Assignment } from "./types.ts";
import { assertValidConfig, validateOpencodeOwned } from "./validate.ts";
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
  configPath: string; backupPath: string | null;
}

export interface EmitOptions {
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
    console.warn(`[plutus] warning: pinned sidecar ${path} is corrupt — ignoring (no slots pinned)`);
  }
  return [];
}

/**
 * Qualify a model id with its provider: `provider/model`.
 *
 * OMO addresses models as `provider/model` (the live config reads `openai/gpt-5.6-sol`). Emitting a
 * bare id drops the provider the solver actually chose, and OpenCode then resolves it by its own
 * rules — landing on a different provider than intended, or one with no credentials, which surfaces
 * as "invalid API key". It also makes genuinely ambiguous ids unresolvable: `deepseek-v4-flash`
 * exists on BOTH opencode-go and the direct DeepSeek subscription, with completely different
 * economics.
 *
 * Ids that already carry a provider are passed through unchanged.
 */
function qualify(provider: string, model: string): string {
  return model.includes("/") ? model : `${provider}/${model}`;
}

/** Serialize one fallback entry the way the schema expects ({ model, variant? }). */
function fallbackEntry(model: string, variant?: string): Record<string, unknown> {
  return variant ? { model, variant } : { model };
}

/**
 * Build the full emitted config document. With `existing`, performs the slot-level deep-merge:
 * user keys preserved, optimizer-owned keys replaced, non-optimizer/pinned slots untouched.
 */
export function buildConfig(assignments: Assignment[], existing?: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = { ...(existing ?? {}) };
  for (const a of assignments) {
    const section = a.kind === "agent" ? "agents" : "categories";
    const slots = (config[section] ?? {}) as Record<string, unknown>;
    const prev = (slots[a.slot] ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = Object.fromEntries(Object.entries(prev).filter(([k]) => !OWNED_KEYS.has(k)));
    merged.model = qualify(a.primary.provider, a.primary.model);
    if (a.primary.variant) merged.variant = a.primary.variant;
    const fbKey = a.kind === "agent" ? "fallback_models" : "models";
    merged[fbKey] = a.fallbacks.slice(0, FALLBACK_CAP).map((c) => fallbackEntry(qualify(c.provider, c.model), c.variant));

    slots[a.slot] = merged; config[section] = slots;
  }
  if (!config.agents) config.agents = {}; if (!config.categories) config.categories = {};
  if (!config.git_master) config.git_master = { commit_footer: true, include_co_authored_by: true, git_env_prefix: "GIT_MASTER=1" };
  return config;
}

/**
 * Emit the config: deep-merge (when merge), validate against the LOCAL schema FIRST (primary gate —
 * an invalid document never clobbers the target and never creates a backup), then back up the
 * pre-existing target and tmp+rename into place.
 */
export function emitConfig(assignments: Assignment[], outputPath: string, opts: EmitOptions = {}): EmitResult {
  const merge = opts.merge ?? true; mkdirSync(dirname(outputPath), { recursive: true });
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

  const config = buildConfig(assignments, existing); assertValidConfig(config, "emitted oh-my-opencode.json");
  let backupPath: string | null = null;
  if (existsSync(outputPath)) { backupPath = `${outputPath}.bak.${ts()}`; copyFileSync(outputPath, backupPath); }

  const tmp = `${outputPath}.tmp.${process.pid}`; writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8"); renameSync(tmp, outputPath);
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

/** Parse a JSONC document (strips // and /* *\/ comments AND trailing commas — both JSONC
 *  features OMO allows; string-aware so URLs like https:// survive). */
export function parseJsonc(raw: string): unknown {
  let out = "";
  let inString: "'" | '"' | null = null;
  let escaped = false, inLineComment = false, inBlockComment = false, pendingComma = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!, next = raw[i + 1];
    if (inLineComment) { if (c === "\n") { inLineComment = false; out += c; } continue; }
    if (inBlockComment) { if (c === "*" && next === "/") { inBlockComment = false; i++; } continue; }
    if (inString) {
      out += c; if (escaped) { escaped = false; continue; } if (c === "\\") { escaped = true; continue; }
      if (c === inString) inString = null; continue;
    }
    if (c === '"' || c === "'") { if (pendingComma) { out += ","; pendingComma = false; } inString = c; out += c; continue; }
    if (c === "/" && next === "/") { inLineComment = true; i++; continue; } if (c === "/" && next === "*") { inBlockComment = true; i++; continue; }
    // A comma immediately before a closing brace/bracket is a trailing comma — drop it.
    // Whitespace carries the pending comma (it must survive "a: 1, }" so the comma is
    // only flushed at the next significant token, and dropped if that token is a closer).
    if (c === ",") { pendingComma = true; continue; } if (c === "}" || c === "]") { pendingComma = false; out += c; continue; }
    if (/\s/.test(c)) { out += c; continue; }
    if (pendingComma) { out += ","; pendingComma = false; }
    out += c;
  }
  return JSON.parse(out);
}

/** Read an existing omo.jsonc (JSONC-tolerant) into a plain object. */
export function readOmoConfig(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  return parseJsonc(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/** Build the full omo.jsonc document: { $schema, [opencode]: flatDoc, ...preserved }.
 *  `existing` is the previous omo.jsonc document (wrapper + user keys). When absent, a fresh
 *  [opencode] section is built from scratch. */
export function buildOmoConfig(assignments: Assignment[], existing?: Record<string, unknown>): Record<string, unknown> {
  const container: Record<string, unknown> = {};
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    for (const [k, v] of Object.entries(existing)) {
      if (k !== "$schema" && k !== "[opencode]" && OMO_TOP_LEVEL_KEEP.has(k)) container[k] = v;
    }
  }
  container.$schema = OMO_SCHEMA_URL;
  const prevOpencode = existing?.["[opencode]"] as Record<string, unknown> | undefined;
  container["[opencode]"] = buildConfig(assignments, prevOpencode);
  return container;
}

/** Emit the omo.jsonc document atomically (validate inner [opencode] against the local schema FIRST,
 *  back up the existing target, tmp+rename). Returns { configPath, backupPath }. */
export function emitOmoConfig(assignments: Assignment[], outputPath: string, opts: EmitOptions = {}): EmitResult {
  const merge = opts.merge ?? true; mkdirSync(dirname(outputPath), { recursive: true });
  let existing: Record<string, unknown> | undefined;
  if (merge && existsSync(outputPath)) {
    try {
      existing = readOmoConfig(outputPath);
    } catch (e: unknown) {
      throw new PlutusError(
        `cannot merge into ${outputPath}: existing config is not valid JSONC (${(e as Error).message}). ` +
          `Fix or remove it, or pass --no-merge to emit fresh.`,
        EXIT.RUNTIME,
      );
    }
  }

  const container = buildOmoConfig(assignments, existing);
  // PRIMARY gate (S5): validate the OPTIMIZER-OWNED surface only — the agents/categories entries
  // Plutus replaced. Pre-existing user content (team_mode, ultrawork, etc.) is out of the gate:
  // OMO's runtime loader tolerates schema-loose content, and the gate must not reject the user's
  // own working config (verified 2026-08-07: live NAS omo.jsonc fails full-schema validation but
  // loads fine). See validateOpencodeOwned.
  const inner = container["[opencode]"] as Record<string, unknown>;
  const ownedAgents = assignments.filter((a) => a.kind === "agent").map((a) => a.slot);
  const ownedCategories = assignments.filter((a) => a.kind === "category").map((a) => a.slot);
  const ownedErrors = validateOpencodeOwned(inner, ownedAgents, ownedCategories);
  if (ownedErrors.length) throw new PlutusError(`Validation failed for optimizer-owned [opencode] slots:\n  - ${ownedErrors.join("\n  - ")}`, EXIT.VALIDATION);
  let backupPath: string | null = null;
  if (existsSync(outputPath)) { backupPath = `${outputPath}.bak.${ts()}`; copyFileSync(outputPath, backupPath); }

  const tmp = `${outputPath}.tmp.${process.pid}`; writeFileSync(tmp, JSON.stringify(container, null, 2) + "\n", "utf8");
  try {
    renameSync(tmp, outputPath);
  } catch (e: unknown) {
    // EBUSY = the target is a single-file bind mount (e.g. /root/.omo/omo.jsonc in the NAS
    // container) — rename over a mount point is impossible. Fall back to in-place write,
    // which is exactly how OMO itself writes its config; the backup above still protects us.
    if ((e as NodeJS.ErrnoException).code === "EBUSY") writeFileSync(outputPath, readFileSync(tmp, "utf8"), "utf8");
    else { rmSync(tmp, { force: true }); throw e; }
    rmSync(tmp, { force: true });
  }
  return { configPath: outputPath, backupPath };
}
