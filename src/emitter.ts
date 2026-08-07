// Emitter — builds + writes the oh-my-opencode.json assignment surface.
// Emit shape (VERIFIED by schema inspection 2026-08-05, bundle §1.4): agents emit `fallback_models`
// (schema has NO `models` key for agents); categories emit `models` (non-deprecated — schema has both).
// W0: emit-fresh (no deep-merge — W4.2 implements slot-level deep-merge per bundle §1.8).
// Backup: .bak.<timestamp> of the pre-existing target; tmp+rename atomic write (bundle §1.9);
// validate-before-replace (bundle §1.9 + W4.5 rollback validates before restore).
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Assignment } from "./types.ts";
import { assertValidConfig } from "./validate.ts";

export interface EmitResult {
  configPath: string;
  backupPath: string | null;
}

function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Build the full emitted config document (agents + categories sections). */
export function buildConfig(assignments: Assignment[]): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const a of assignments) {
    const entry: Record<string, unknown> = { model: a.primary.model };
    const fallbacks = a.fallbacks.map((c) => {
      const o: Record<string, unknown> = { model: c.model };
      if (c.variant) o.variant = c.variant;
      return o;
    });
    // Emit shape: agents → fallback_models, categories → models.
    entry[a.kind === "agent" ? "fallback_models" : "models"] = fallbacks;
    const section = a.kind === "agent" ? "agents" : "categories";
    if (!config[section]) config[section] = {};
    (config[section] as Record<string, unknown>)[a.slot] = entry;
  }
  // Ensure sections exist even when empty (schema has additionalProperties:false — empty objects are fine).
  if (!config.agents) config.agents = {};
  if (!config.categories) config.categories = {};
  // Schema REQUIRES top-level git_master (verified against local schema 2026-08-07: required:["git_master"]).
  // We emit the schema's own default block so the emitted config passes the LOCAL validation gate.
  config.git_master = {
    commit_footer: true,
    include_co_authored_by: true,
    git_env_prefix: "GIT_MASTER=1",
  };
  return config;
}

/**
 * Emit the config: back up the pre-existing target, validate the new document, then
 * tmp+rename it into place. Throws PlutusError(VALIDATION) when the document is invalid
 * (validate-before-replace — the target is never clobbered with an invalid config).
 */
export function emitConfig(assignments: Assignment[], outputPath: string): EmitResult {
  mkdirSync(dirname(outputPath), { recursive: true });

  let backupPath: string | null = null;
  if (existsSync(outputPath)) {
    backupPath = `${outputPath}.bak.${ts()}`;
    copyFileSync(outputPath, backupPath);
  }

  const config = buildConfig(assignments);
  assertValidConfig(config, "emitted oh-my-opencode.json"); // PRIMARY gate — never write invalid config

  const tmp = `${outputPath}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  renameSync(tmp, outputPath);

  return { configPath: outputPath, backupPath };
}

export { join as pathJoin };