// W3.1 — inventory loader property/regression tests (bundle §4/§7 deletions).
// RED: per-provider `subscription_flat`/`anthropic_flat` are NOT rejected by the W0.2 loader
// (only top-level keys are) — the §7 deletion must hold at every nesting level.
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import Ajv from "ajv";
import { parseInventory, loadInventory, capMap, trustedSetEmpty } from "../src/inventory.ts";
import { PlutusError } from "../src/errors.ts";
import { EXIT } from "../src/types.ts";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "fixtures");

const VALID = `
version: 1
providers:
  openai:
    cap: 0.8
    window_resets: "2026-08-15T00:00:00Z"
    trust: remote_api
  deepseek:
    cap: null
    trust: user_declared
`;

function expectValidationError(raw: string, needle: string): void {
  try {
    parseInventory(raw);
    expect.unreachable(`expected a PlutusError mentioning "${needle}"`);
  } catch (e: unknown) {
    const err = e as PlutusError;
    expect(err).toBeInstanceOf(PlutusError);
    expect(err.exitCode).toBe(EXIT.VALIDATION);
    expect(err.message).toContain(needle);
  }
}

test("W3.1: valid inventory loads with the trust taxonomy honored", () => {
  const inv = parseInventory(VALID);
  expect(inv.version).toBe(1);
  expect(Object.keys(inv.providers).sort()).toEqual(["deepseek", "openai"]);
  expect(inv.providers.openai!.cap).toBe(0.8);
  expect(inv.providers.deepseek!.cap).toBeNull();
  expect(inv.providers.deepseek!.trust).toBe("user_declared");
});

test("W3.1: rejects UNKNOWN trust taxonomy (bundle §4)", () => {
  expectValidationError(
    `version: 1\nproviders:\n  openai:\n    cap: 0.5\n    trust: subscription_flat\n`,
    "invalid trust",
  );
});

test("W3.1: rejects top-level subscription_flat (bundle §7 Claude-deletion)", () => {
  expectValidationError(
    `version: 1\nsubscription_flat: true\nproviders:\n  openai:\n    cap: 0.5\n    trust: remote_api\n`,
    "subscription_flat",
  );
});

test("W3.1: rejects per-provider subscription_flat — §7 deletion holds at provider level (RED before fix)", () => {
  // The anthropic provider was deleted for claiming subscription_flat model access — the
  // prohibition must apply inside the provider block too, not just at the document top level.
  expectValidationError(
    `version: 1\nproviders:\n  anthropic:\n    subscription_flat: true\n    trust: remote_api\n`,
    "subscription_flat",
  );
});

test("W3.1: rejects per-provider anthropic_flat", () => {
  expectValidationError(
    `version: 1\nproviders:\n  anthropic:\n    anthropic_flat: true\n    trust: remote_api\n`,
    "anthropic_flat",
  );
});

test("W3.1: rejects reserve_policy / promo (bundle §7 deletions)", () => {
  expectValidationError(
    `version: 1\nproviders:\n  openai:\n    cap: 0.5\n    reserve_policy: strict\n    trust: remote_api\n`,
    "reserve_policy",
  );
  expectValidationError(
    `version: 1\nproviders:\n  openai:\n    cap: 0.5\n    promo: free-tier\n    trust: remote_api\n`,
    "promo",
  );
});

test("W3.1: rejects invalid cap values (outside [0,1] or NaN)", () => {
  expectValidationError(
    `version: 1\nproviders:\n  openai:\n    cap: 1.5\n    trust: remote_api\n`,
    "cap",
  );
  expectValidationError(
    `version: 1\nproviders:\n  openai:\n    cap: "high"\n    trust: remote_api\n`,
    "cap",
  );
});

test("W3.1: loadInventory + capMap + trustedSetEmpty agree on the W2 fixture", () => {
  const inv = loadInventory(join(FIXTURES, "w2", "inventory.yaml"));
  const caps = capMap(inv);
  expect(caps.get("openai")).toBe(0.8);
  expect(caps.get("deepseek")).toBeNull();
  expect(trustedSetEmpty(inv)).toBe(false);

  const allNull = parseInventory(`version: 1\nproviders:\n  a:\n    cap: null\n    trust: user_declared\n  b:\n    cap: null\n    trust: user_declared\n`);
  expect(trustedSetEmpty(allNull)).toBe(true);
});

test("W3.2: schemas/inventory.yaml validates the valid fixture and rejects the §7 deletions", () => {
  const schemaRaw = readFileSync(join(import.meta.dir, "..", "schemas", "inventory.yaml"), "utf8");
  const schema = parseYaml(schemaRaw);
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  const validDoc = parseYaml(VALID);
  expect(validate(validDoc), `valid inventory must pass the schema: ${JSON.stringify(validate.errors)}`).toBe(true);

  const badTrust = parseYaml(`version: 1\nproviders:\n  openai:\n    cap: 0.5\n    trust: subscription_flat\n`);
  expect(validate(badTrust), "unknown trust must fail the schema").toBe(false);

  const flat = parseYaml(`version: 1\nproviders:\n  anthropic:\n    subscription_flat: true\n    trust: remote_api\n`);
  expect(validate(flat), "per-provider subscription_flat must fail the schema (additionalProperties:false)").toBe(false);
});
