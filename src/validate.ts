// Schema validation — the PRIMARY gate per bundle §2 fact 7 / §5 "Doctor as gate".
// Local, version-locked: require.resolve("oh-my-openagent/schema.json") resolves through the
// package exports map to dist/oh-my-opencode.schema.json (VERIFIED 2026-08-05). The unpinned
// dev-branch URL in $id is recorded in the report; never used as the runtime source.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { PlutusError } from "./errors.ts";
import { EXIT } from "./types.ts";

const require = createRequire(import.meta.url);

/** Resolve the local oh-my-opencode schema path (through package exports). */
export function localSchemaPath(): string {
  return require.resolve("oh-my-openagent/schema.json");
}

export interface SchemaInfo {
  path: string; id: string; contentHash: string;
}

/** Load schema metadata ($id + sha256 content hash) for the report (bundle §2 fact 7). */
export function schemaInfo(): SchemaInfo {
  const path = localSchemaPath(); const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as { $id?: string; $schema?: string };
  return { path, id: parsed.$id ?? parsed.$schema ?? "(none)", contentHash: createHash("sha256").update(raw).digest("hex") };
}

type Compiled = (data: unknown) => boolean;

let _ajv: Ajv | null = null;
let _validate: Compiled | null = null;

/** Lazily compile the local schema. AJV attaches `errors` to the compiled function on each call. */
function getCompiled(): Compiled {
  if (!_validate) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = JSON.parse(readFileSync(localSchemaPath(), "utf8"));
    _validate = ajv.compile(schema) as Compiled;
    _ajv = ajv;
  }
  return _validate;
}

export interface ValidationResult {
  valid: boolean; errors: string[];
}

/** Validate a config against the LOCAL schema. Returns {valid, errors}. */
export function validateConfig(config: unknown): ValidationResult {
  const validate = getCompiled(); const valid = validate(config);
  const errs = (validate as Compiled & { errors?: ErrorObject[] }).errors;
  return { valid, errors: valid ? [] : (errs ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()) };
}

/** Throw a PlutusError(exit 2) when the config is invalid — the S5 regression surface. */
export function assertValidConfig(config: unknown, what = "config"): void {
  const validate = getCompiled(); const valid = validate(config);
  if (!valid) {
    const errs = (validate as Compiled & { errors?: ErrorObject[] }).errors ?? [];
    const detail = errs.map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()).join("\n  - ");
    throw new PlutusError(`Validation failed for ${what}:\n  - ${detail}`, EXIT.VALIDATION);
  }
}

/**
 * Validate ONLY the optimizer-owned surface of an omo.jsonc [opencode] section: the specific keys
 * Plutus writes on the slots it replaced (model, variant, reasoning/reasoningEffort,
 * models/fallback_models). Pre-existing user content — both whole entries Plutus didn't touch
 * (team_mode) and user sub-keys inside owned slots (ultrawork, permission, prompt, etc.) — is
 * deliberately OUT of the gate: OMO's runtime loader tolerates schema-loose content (verified:
 * the live NAS config fails full-schema validation yet loads fine), and S5's contract is "never
 * write invalid OPTIMIZER output", not "reject the user's own tolerated config".
 * Returns the errors for the optimizer-written keys (empty = gate passes).
 */
const OWNED_SLOT_KEYS = ["model", "variant", "reasoning", "reasoningEffort", "models", "fallback_models"] as const;

export function validateOpencodeOwned(
  section: Record<string, unknown>,
  ownedAgents: string[],
  ownedCategories: string[],
): string[] {
  const validate = getCompiled();
  const probe: Record<string, unknown> = {
    // buildConfig guarantees git_master exists in the real section; the probe needs it too
    // because the oh-my-opencode schema REQUIRES it at the [opencode] top level.
    git_master: { commit_footer: true, include_co_authored_by: true, git_env_prefix: "GIT_MASTER=1" },
  };
  const probeOwned = (group: "agents" | "categories", owned: string[]) => {
    if (!owned.length) return;
    const entries = (section[group] ?? {}) as Record<string, unknown>;
    probe[group] = {};
    for (const s of owned) {
      const entry = entries[s];
      if (!entry || typeof entry !== "object") continue;
      const kept: Record<string, unknown> = {};
      for (const k of OWNED_SLOT_KEYS) if (k in (entry as Record<string, unknown>)) kept[k] = (entry as Record<string, unknown>)[k];
      (probe[group] as Record<string, unknown>)[s] = kept;
    }
  };
  probeOwned("agents", ownedAgents); probeOwned("categories", ownedCategories);
  const valid = validate(probe);
  if (valid) return [];
  return ((validate as Compiled & { errors?: ErrorObject[] }).errors ?? []).map(
    (e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim(),
  );
}
