import { test, expect } from "bun:test";
import { loadAvailability, availabilityDiagnostics } from "../src/availability.ts";
import { loadInventory } from "../src/inventory.ts";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const inv = () => loadInventory(join(import.meta.dir, "fixtures", "w2", "inventory.yaml"));

test("B2: MISSING models.json is reported as degraded, never silent", () => {
  // The dangerous case: capability collapses to a constant, quality degenerates to
  // chain-position-only, and the run still reports success. It must be loud.
  loadAvailability(inv(), "/nonexistent/models.json");
  const d = availabilityDiagnostics()!;
  expect(d.source).toBe("missing");
  expect(d.degraded).toBe(true);
  expect(d.modelsPath).toBe("/nonexistent/models.json");
});

test("B2: CORRUPT models.json is reported as corrupt WITH the parse error", () => {
  const dir = mkdtempSync(join(tmpdir(), "plutus-avail-"));
  const bad = join(dir, "models.json");
  writeFileSync(bad, "{ not valid json");
  loadAvailability(inv(), bad);
  const d = availabilityDiagnostics()!;
  expect(d.source).toBe("corrupt");
  expect(d.degraded).toBe(true);
  expect(d.error).toBeTruthy();   // the parse failure is preserved, not swallowed
});

test("B3: declared providers contributing ZERO candidates are named", () => {
  // This is how DeepSeek injection used to no-op in total silence — a provider declared and
  // paid for, present in inventory, yet contributing nothing to any slot.
  loadAvailability(inv(), "/nonexistent/models.json");
  const d = availabilityDiagnostics()!;
  expect(d.emptyProviders.length).toBeGreaterThan(0);
  for (const pid of d.emptyProviders) expect(typeof pid).toBe("string");
});

test("B2: a healthy cache reports loaded, not degraded", () => {
  const good = join(import.meta.dir, "fixtures", "w2", "models.json");
  loadAvailability(inv(), good);
  const d = availabilityDiagnostics()!;
  expect(d.source).toBe("loaded");
  expect(d.degraded).toBe(false);
  expect(d.modelCount).toBeGreaterThan(0);
});
