// W1.3 — check-chains drift tests. Drift = parsed chains differ from the vendored snapshot
// → delta reported + exit 3 (unresolved drift). No-drift → exit 0.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli/index.ts";
import { EXIT } from "../src/types.ts";
import { SNAPSHOT_PATH } from "../src/commands/check-chains.ts";

test("W1.3: no drift against the committed snapshot → exit 0", async () => {
  const code = await runCli(["check-chains"]);
  expect(code, "check-chains should pass with no drift").toBe(EXIT.OK);
});

describe("drift detection", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plutus-drift-"));
    const snap = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as {
      slots: Array<{ kind: string; name: string; fallbackChain: unknown[] }>;
      pinned_sha: string;
    };
    // Tamper: remove a real slot, add a phantom slot → guaranteed delta.
    snap.slots = snap.slots.filter((s) => s.name !== "hephaestus");
    snap.slots.push({ kind: "agent", name: "phantom-slot", fallbackChain: [{ providers: ["openai"], model: "gpt-x" }] });
    snap.pinned_sha = "0".repeat(64);
    writeFileSync(join(dir, "chains.json"), JSON.stringify(snap));
    process.env.OMO_PLUTUS_SNAPSHOT_PATH = join(dir, "chains.json");
  });

  afterEach(() => {
    delete process.env.OMO_PLUTUS_SNAPSHOT_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  test("W1.3: tampered snapshot → drift detected, exit 3 (unresolved)", async () => {
    const code = await runCli(["check-chains"]);
    expect(code, "drift must be unresolved → exit 3").toBe(EXIT.SPIKE);
  });
});
