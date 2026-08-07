// W4.1 — emitter merge-preservation RED test (scenario S4) + W4.4 fallback cap + W4.3/S5 gate.
// S4 contract: existing oh-my-opencode.json with user keys + pinned.json entries → merge preserves
// prompt/user keys, skips pinned slots, replaces only optimizer-owned keys (model, variant,
// reasoning/reasoningEffort, models/fallback_models). Schema validation is the PRIMARY gate (S5):
// a config carrying an illegal key must fail with exit code 2 and never replace the target.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, emitConfig, loadPinnedSlots } from "../src/emitter.ts";
import { validateConfig, assertValidConfig } from "../src/validate.ts";
import { PlutusError } from "../src/errors.ts";
import { EXIT } from "../src/types.ts";
import type { Assignment, Candidate, SlotKind } from "../src/types.ts";

function cand(model: string, kind: SlotKind, fit = 1.0, capability = 1.0, position = 0): Candidate {
  return {
    entry: { providers: ["openai"], model, position },
    provider: "openai",
    model,
    fit,
    capability,
    quality: fit * capability,
    projectedCost: 0,
    quotaHeadroom: 0.8,
    trusted: true,
  };
}

function assignment(slot: string, kind: SlotKind, models: string[]): Assignment {
  const [primary, ...rest] = models;
  return {
    slot,
    kind,
    primary: cand(primary!, kind),
    fallbacks: rest.map((m, i) => cand(m, kind, 0.8, 1.0, i + 1)),
    rationale: "test",
  };
}

const EXISTING: Record<string, unknown> = {
  agents: {
    oracle: {
      model: "claude-opus-5",
      prompt: "you are the oracle — user-authored prompt, must survive merge",
      tools: { bash: true, read: true },
      description: "user description",
      mode: "primary",
      fallback_models: [{ model: "old-fallback", variant: "low" }],
    },
    build: { model: "deepseek-v4-flash" }, // non-optimizer slot — never touched
    hephaestus: { model: "gpt-5.6-sol", prompt: "pinned slot prompt" }, // pinned → skipped
  },
  categories: {
    ultrabrain: {
      model: "old-model",
      prompt_append: "user prompt_append",
      models: ["old-fallback-1"],
    },
  },
  telemetry: true, // top-level user key — preserved
};

let dir: string;
let cfgPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plutus-emit-"));
  cfgPath = join(dir, "oh-my-opencode.json");
  writeFileSync(cfgPath, JSON.stringify(EXISTING, null, 2));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("S4: buildConfig preserves user keys, replaces optimizer-owned keys, skips pinned + non-optimizer slots", () => {
  const assignments = [
    assignment("oracle", "agent", ["gpt-5.6-sol", "gpt-5.5"]),
    assignment("ultrabrain", "category", ["gpt-5.6-sol", "gpt-5.5"]),
  ];
  const config = buildConfig(assignments, EXISTING);

  const oracle = (config.agents as Record<string, Record<string, unknown>>).oracle!;
  expect(oracle.model).toBe("gpt-5.6-sol"); // replaced (optimizer-owned)
  expect(oracle.prompt).toBe("you are the oracle — user-authored prompt, must survive merge"); // preserved
  expect(oracle.tools).toEqual({ bash: true, read: true });
  expect(oracle.description).toBe("user description");
  expect(oracle.mode).toBe("primary");
  expect(oracle.fallback_models).toEqual([{ model: "gpt-5.5" }]); // replaced (optimizer-owned)

  // Non-optimizer slot untouched.
  const build = (config.agents as Record<string, Record<string, unknown>>).build!;
  expect(build.model).toBe("deepseek-v4-flash");
  // Pinned slot skipped by the solver → not in assignments → existing entry untouched.
  const hephaestus = (config.agents as Record<string, Record<string, unknown>>).hephaestus!;
  expect(hephaestus.model).toBe("gpt-5.6-sol");
  expect(hephaestus.prompt).toBe("pinned slot prompt");

  const ultra = (config.categories as Record<string, Record<string, unknown>>).ultrabrain!;
  expect(ultra.model).toBe("gpt-5.6-sol");
  expect(ultra.prompt_append).toBe("user prompt_append");
  expect(ultra.models).toEqual([{ model: "gpt-5.5" }]); // categories emit `models` — replaced, not appended

  expect(config.telemetry).toBe(true); // top-level user key preserved

  // The merged document must still pass LOCAL schema validation (primary gate).
  const v = validateConfig(config);
  expect(v.valid, `merged config must pass schema: ${v.errors.join("; ")}`).toBe(true);
});

test("S4: emitConfig with merge replaces the target, backs it up, and the result passes the schema", () => {
  const assignments = [assignment("oracle", "agent", ["gpt-5.6-sol", "gpt-5.5"])];
  const { backupPath } = emitConfig(assignments, cfgPath, { merge: true });
  expect(backupPath).not.toBeNull();
  const emitted = JSON.parse(readFileSync(cfgPath, "utf8"));
  const oracle = (emitted.agents as Record<string, Record<string, unknown>>).oracle!;
  expect(oracle.model).toBe("gpt-5.6-sol");
  expect(oracle.prompt).toBe("you are the oracle — user-authored prompt, must survive merge");
  expect((emitted.agents as Record<string, unknown>).build).toBeDefined(); // still there
  expect(validateConfig(emitted).valid).toBe(true);
});

test("W4.4: fallback list capped at 5 entries in the emitted config", () => {
  const assignments = [assignment("oracle", "agent", ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"])];
  const config = buildConfig(assignments, undefined);
  const oracle = (config.agents as Record<string, Record<string, unknown>>).oracle!;
  expect((oracle.fallback_models as unknown[]).length).toBe(5);
});

test("S5: config with an illegal key fails LOCAL schema validation (exit 2, never 0)", () => {
  const bad = {
    ...EXISTING,
    git_master: { commit_footer: true, include_co_authored_by: true, git_env_prefix: "GIT_MASTER=1" },
    illegal_top_key: true,
  };
  const v = validateConfig(bad);
  expect(v.valid).toBe(false);
  expect(v.errors.some((e) => e.includes("additional properties"))).toBe(true);
  try {
    assertValidConfig(bad, "bad config");
    expect.unreachable("assertValidConfig must throw for an illegal key");
  } catch (e: unknown) {
    expect((e as PlutusError).exitCode).toBe(EXIT.VALIDATION);
  }
});

test("S5: an existing target carrying an illegal key is never replaced — merge fails with exit 2", () => {
  writeFileSync(cfgPath, JSON.stringify({ ...EXISTING, illegal_top_key: true }, null, 2));
  const assignments = [assignment("oracle", "agent", ["gpt-5.6-sol"])];
  try {
    emitConfig(assignments, cfgPath, { merge: true });
    expect.unreachable("emitConfig must refuse to write a schema-invalid merged config");
  } catch (e: unknown) {
    expect((e as PlutusError).exitCode).toBe(EXIT.VALIDATION);
  }
  // Target untouched, and NO backup was created for the rejected write.
  const target = JSON.parse(readFileSync(cfgPath, "utf8"));
  expect((target as Record<string, unknown>).illegal_top_key).toBe(true);
  const backups = readdirSync(dir).filter((f) => f.includes(".bak."));
  expect(backups).toEqual([]);
});

test("W4.2: loadPinnedSlots reads the sidecar; missing sidecar → empty list", () => {
  writeFileSync(join(dir, "pinned.json"), JSON.stringify({ version: 1, slots: ["oracle", "sisyphus"] }));
  expect(loadPinnedSlots(join(dir, "pinned.json"))).toEqual(["oracle", "sisyphus"]);
  expect(loadPinnedSlots(join(dir, "missing.json"))).toEqual([]);
});

// ---- omo.jsonc emit path (the LIVE config OMO 4.19.4 reads: ~/.omo/omo.jsonc) ----

import { buildOmoConfig, emitOmoConfig, OMO_SCHEMA_URL } from "../src/emitter.ts";

test("omo.jsonc: buildOmoConfig wraps assignments in { $schema, [opencode] } and preserves top-level keys", () => {
  const assignments = [
    {
      slot: "oracle",
      kind: "agent" as const,
      primary: { model: "gpt-5.6-sol", provider: "openai", fit: 1.0, capability: 1.0, quality: 1.0, projectedCost: 0, quotaHeadroom: 0.8, trusted: true, entry: { providers: ["openai"], model: "gpt-5.6-sol", position: 0 } },
      fallbacks: [],
      rationale: "head fit",
    },
  ];
  const existing = {
    $schema: OMO_SCHEMA_URL,
    "[opencode]": { agents: { build: { model: "x" } }, categories: {} },
    codegraph: { telemetry: true },
    team_mode_should_not_survive: true, // not in OMO_TOP_LEVEL_KEEP
  };
  const doc = buildOmoConfig(assignments, existing);
  expect(doc.$schema).toBe(OMO_SCHEMA_URL);
  expect((doc as any).codegraph).toEqual({ telemetry: true }); // preserved
  expect((doc as any).team_mode_should_not_survive).toBeUndefined(); // dropped
  const inner = (doc as any)["[opencode]"];
  expect(inner.agents.oracle.model).toBe("gpt-5.6-sol");
  expect(inner.agents.build.model).toBe("x"); // user key preserved via buildConfig merge
  expect((doc as any)["[opencode]"].categories).toBeDefined();
});

test("omo.jsonc: emitOmoConfig writes the wrapped doc + backup, and the [opencode] section passes the local schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "plutus-omo-"));
  const target = join(dir, "omo.jsonc");
  const assignments = [
    {
      slot: "oracle",
      kind: "agent" as const,
      primary: { model: "gpt-5.6-sol", provider: "openai", fit: 1.0, capability: 1.0, quality: 1.0, projectedCost: 0, quotaHeadroom: 0.8, trusted: true, entry: { providers: ["openai"], model: "gpt-5.6-sol", position: 0 } },
      fallbacks: [],
      rationale: "head",
    },
  ];
  writeFileSync(target, JSON.stringify({ $schema: OMO_SCHEMA_URL, "[opencode]": { agents: { build: { model: "old" } }, categories: {} } }));
  const { backupPath, configPath } = emitOmoConfig(assignments, target, { merge: true });
  expect(configPath).toBe(target);
  expect(backupPath).toContain(".bak.");
  const written = JSON.parse(readFileSync(target, "utf8"));
  expect(written.$schema).toBe(OMO_SCHEMA_URL);
  expect(written["[opencode]"].agents.oracle.model).toBe("gpt-5.6-sol");
  expect(written["[opencode]"].agents.build.model).toBe("old"); // merged, preserved
  // backup contains the pre-merge doc
  const backup = JSON.parse(readFileSync(backupPath!, "utf8"));
  expect(backup["[opencode]"].agents.build.model).toBe("old");
});
