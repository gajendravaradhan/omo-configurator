// W5.3 (P3) — telemetry ledger: one JSONL line per run, append-only, NEVER rewritten, never
// transmitted. This is v2's entire training input. Gate: optimize twice → two valid JSONL lines,
// file grows not rewrites.
import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLedger, buildLedgerEntry, type LedgerEntry } from "../src/ledger.ts";
import { runCli } from "../src/cli/index.ts";
import { EXIT } from "../src/types.ts";
import type { Assignment } from "../src/types.ts";

let dir: string;
let ledgerPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plutus-ledger-"));
  ledgerPath = join(dir, "history.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function candidate(model: string, quality: number) {
  return {
    entry: { providers: ["openai"], model, position: 0 },
    provider: "openai",
    model,
    fit: quality,
    capability: 1.0,
    quality,
    projectedCost: 0,
    quotaHeadroom: 0.8,
    trusted: true,
  };
}

const solveStub: { assignments: Assignment[] } = {
  assignments: [
    {
      slot: "oracle",
      kind: "agent",
      primary: candidate("gpt-5.6-sol", 1.0),
      fallbacks: [],
      rationale: "t",
    },
  ],
};

test("W5.3: appendLedger appends one valid JSONL line and never rewrites prior content", () => {
  const entry: LedgerEntry = {
    ts: "2026-08-07T00:00:00.000Z",
    mode: "absolute-best",
    chain_sha: "deadbeef",
    quota_snapshot_per_provider: { openai: 0.8, deepseek: null },
    assignments: { oracle: { model: "gpt-5.6-sol", provider: "openai", quality: 1.0 } },
    trust_levels: { openai: "remote_api", deepseek: "user_declared" },
  };
  appendLedger(entry, ledgerPath);
  appendLedger({ ...entry, ts: "2026-08-07T01:00:00.000Z" }, ledgerPath);

  const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
  expect(lines.length).toBe(2);
  for (const line of lines) {
    expect(JSON.parse(line)).toBeTruthy(); // every line valid JSON
  }
  expect(JSON.parse(lines[0]!).ts).toBe("2026-08-07T00:00:00.000Z");
  expect(JSON.parse(lines[1]!).ts).toBe("2026-08-07T01:00:00.000Z");
});

test("W5.3: buildLedgerEntry captures the solve shape (caps, assignments, trust levels)", () => {
  const caps = new Map<string, number | null>([["openai", 0.8], ["deepseek", null]]);
  const entry = buildLedgerEntry(solveStub, caps, { openai: "remote_api", deepseek: "user_declared" }, "sha123", "absolute-best");
  expect(entry.chain_sha).toBe("sha123");
  expect(entry.mode).toBe("absolute-best");
  expect(entry.quota_snapshot_per_provider).toEqual({ openai: 0.8, deepseek: null });
  expect(entry.assignments.oracle).toEqual({ model: "gpt-5.6-sol", provider: "openai", quality: 1.0 });
  expect(entry.trust_levels).toEqual({ openai: "remote_api", deepseek: "user_declared" });
});

test("W5.3: plutus optimize twice appends two ledger lines — file grows, never rewrites", async () => {
  const FIXTURES = join(import.meta.dir, "fixtures");  const outDir = join(dir, "config");
  const omoCfg = join(outDir, "oh-my-opencode.json");
  process.env.XDG_CONFIG_HOME = join(dir, "xdg");
  process.env.OMO_PLUTUS_MODELS_PATH = join(FIXTURES, "models.json");

  const code1 = await runCli(["optimize", "--mode", "absolute-best", "--config", join(FIXTURES, "inventory.yaml"), "--output", omoCfg]);
  expect(code1).toBe(EXIT.OK);
  const ledger1 = join(dir, "xdg", "omo-plutus", "history.jsonl");
  expect(existsSync(ledger1)).toBe(true);
  const after1 = readFileSync(ledger1, "utf8").trim().split("\n").filter(Boolean);
  expect(after1.length).toBe(1);

  const code2 = await runCli(["optimize", "--mode", "absolute-best", "--config", join(FIXTURES, "inventory.yaml"), "--output", omoCfg]);
  expect(code2).toBe(EXIT.OK);
  const after2 = readFileSync(ledger1, "utf8").trim().split("\n").filter(Boolean);
  expect(after2.length).toBe(2); // grew, not rewrote
  expect(after2[0]).toBe(after1[0]); // first line untouched
  for (const line of after2) expect(JSON.parse(line)).toBeTruthy();
}, 30000);
