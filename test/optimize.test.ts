// W0.3 — S1 happy-path RED test.
// Scenario contract (bundle §2): `plutus optimize --mode=absolute-best` with valid declared inventory.
// Pass condition: exit 0; emitted oh-my-opencode.json passes LOCAL schema validation; doctor soft-check
// shows no unresolved slots; backup file created. Real surface: emitted config + plutus-report.md + backup path.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/index.ts";
import { EXIT } from "../src/types.ts";
import { validateConfig } from "../src/validate.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

let dir: string;
let outDir: string;
let omoCfg: string;

function setup() {
  dir = mkdtempSync(join(tmpdir(), "plutus-s1-"));
  outDir = join(dir, "config");
  mkdirSync(outDir, { recursive: true });
  omoCfg = join(outDir, "oh-my-opencode.json");
  // Pre-existing (schema-valid) target so the run must back it up before replacing.
  writeFileSync(omoCfg, JSON.stringify({ agents: { build: { model: "deepseek-v4-flash" } } }, null, 2));
  process.env.XDG_CONFIG_HOME = join(dir, "xdg");
  process.env.OMO_PLUTUS_MODELS_PATH = join(FIXTURES, "models.json");
}

beforeEach(setup);
afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.OMO_PLUTUS_MODELS_PATH;
  rmSync(dir, { recursive: true, force: true });
});

test("S1: optimize --mode=absolute-best with valid inventory exits 0 and emits schema-valid config", async () => {
  const code = await runCli([
    "optimize",
    "--mode",
    "absolute-best",
    "--config",
    join(FIXTURES, "inventory.yaml"),
    "--output",
    omoCfg,
  ]);
  expect(code, "optimize should exit 0").toBe(EXIT.OK);

  // Emitted config exists and passes LOCAL schema validation.
  expect(existsSync(omoCfg), "emitted oh-my-opencode.json should exist").toBe(true);
  const emitted = JSON.parse(readFileSync(omoCfg, "utf8"));
  const v = validateConfig(emitted);
  expect(v.valid, `emitted config must pass local schema validation: ${v.errors.join("; ")}`).toBe(true);

  // plutus-report.md produced next to the emitted config.
  const report = join(outDir, "plutus-report.md");
  expect(existsSync(report), "plutus-report.md should exist").toBe(true);

  // Backup of the pre-existing config created.
  const backups = readdirSync(outDir).filter((f) => f.startsWith("oh-my-opencode.json.bak."));
  expect(backups.length, "a backup of the pre-existing config must be created").toBeGreaterThan(0);

  // Doctor soft-check: every fixture slot got a primary (no unresolved slots).
  for (const slot of ["librarian", "explore", "ultrabrain", "quick"]) {
    const entry = emitted.agents?.[slot] ?? emitted.categories?.[slot];
    expect(entry, `slot ${slot} must have an assignment`).toBeDefined();
    expect(typeof entry.model, `slot ${slot} primary model must be a string`).toBe("string");
  }
});
