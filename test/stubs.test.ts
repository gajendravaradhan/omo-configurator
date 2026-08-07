// W6 — stubs: challenge (W6.1: pin challenger + comparator scaffold, session-level metrics only,
// NO per-slot attribution) and adaptive mode (W6.2: honest A1-A3 refusal, exit 3).
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/index.ts";
import { EXIT } from "../src/types.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plutus-w6-"));
  process.env.XDG_CONFIG_HOME = join(dir, "xdg");
});

afterEach(() => {
  delete process.env.XDG_CONFIG_HOME;
  rmSync(dir, { recursive: true, force: true });
});

test("W6.1: challenge pins the challenger and produces the comparator report scaffold", async () => {
  const code = await runCli(["challenge", "--slot", "oracle", "--model", "gpt-5.6-sol", "--sessions", "3"]);
  expect(code).toBe(EXIT.OK);

  // Emitter pin machinery reused: slot landed in the sidecar.
  const sidecar = join(dir, "xdg", "omo-plutus", "pinned.json");
  expect(existsSync(sidecar)).toBe(true);
  const pinned = JSON.parse(readFileSync(sidecar, "utf8"));
  expect(pinned.slots).toContain("oracle");
  expect(pinned.pinned_challenger).toEqual({ oracle: "gpt-5.6-sol" });

  // Comparator report produced with session-level metrics only.
  const reportPath = join(process.cwd(), "plutus-challenge.md");
  expect(existsSync(reportPath)).toBe(true);
  const report = readFileSync(reportPath, "utf8");
  expect(report).toContain("NO per-slot attribution");
  expect(report).toContain("tokens-to-completion");
  expect(report).toContain("| 1 | pending | pending | pending | pending |");
  expect(report).toContain("| 3 | pending | pending | pending | pending |");
  rmSync(reportPath, { force: true });
});

test("W6.1: challenge validates sessions (positive integer, exit 2)", async () => {
  const code = await runCli(["challenge", "--slot", "oracle", "--model", "gpt-5.6-sol", "--sessions", "0"]);
  expect(code).toBe(EXIT.VALIDATION);
});

test("W6.2: adaptive mode refuses honestly with exit 3 (A1-A3 unresolved)", async () => {
  const code = await runCli([
    "optimize",
    "--mode",
    "adaptive",
    "--config",
    join(import.meta.dir, "fixtures", "inventory.yaml"),
    "--output",
    join(dir, "out.json"),
  ]);
  expect(code).toBe(EXIT.SPIKE);
});
