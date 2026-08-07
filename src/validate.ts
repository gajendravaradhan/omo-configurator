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
  path: string;
  id: string;
  contentHash: string;
}

/** Load schema metadata ($id + sha256 content hash) for the report (bundle §2 fact 7). */
export function schemaInfo(): SchemaInfo {
  const path = localSchemaPath();
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as { $id?: string; $schema?: string };
  return {
    path,
    id: parsed.$id ?? parsed.$schema ?? "(none)",
    contentHash: createHash("sha256").update(raw).digest("hex"),
  };
}

let _ajv: Ajv | null = null;
let _validate: ((data: unknown) => boolean) | null = null;

type Compiled = (data: unknown) => boolean;

function getValidator(): { validate: Compiled; errors: ErrorObject[] | null } {
  if (!_validate) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const schema = JSON.parse(readFileSync(localSchemaPath(), "utf8"));
    _validate = ajv.compile(schema) as Compiled;
    _ajv = ajv;
  }
  return {
    validate: (data: unknown) => _validate!(data),
    errors: (_validate as Compiled & { errors?: ErrorObject[] }).errors ?? null,
  };
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate a config against the LOCAL schema. Returns {valid, errors}. */
export function validateConfig(config: unknown): ValidationResult {
  const { validate, errors } = getValidator();
  const valid = validate(config);
  return {
    valid,
    errors: valid ? [] : (errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()),
  };
}

/** Throw a PlutusError(exit 2) when the config is invalid — the S5 regression surface. */
export function assertValidConfig(config: unknown, what = "config"): void {
  const { valid, errors } = validateConfig(config);
  if (!valid) {
    throw new PlutusError(`Validation failed for ${what}:\n  - ${errors.join("\n  - ")}`, EXIT.VALIDATION);
  }
}