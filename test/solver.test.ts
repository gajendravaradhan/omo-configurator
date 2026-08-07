// W2.1 — solver property tests (RED). S2 (forbidden unreachable + determinism + P5 tiebreak exercised),
// S3 (cap=null overflow-only + untrusted marker), S3b (all-untrusted degenerate → single banner, P1),
// S6 (DeepSeek injection: legal GPT-family slots, never hephaestus).
import { test, expect } from "bun:test";
import { extractChains } from "../src/chain.ts";
import { loadAvailability } from "../src/availability.ts";
import { loadInventory, capMap } from "../src/inventory.ts";
import { solveChains, type SolveInput } from "../src/solver.ts";
import { isForbidden } from "../src/forbidden.ts";
import { computeCapability, compareCandidates } from "../src/quality.ts";
import { loadTiers, type Tiers } from "../src/quality.ts";
import type { Candidate, SlotChain, SlotKind } from "../src/types.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURES = join(import.meta.dir, "fixtures");
const tiers: Tiers = loadTiers();

// ---- fixture helpers ---------------------------------------------------------

function entry(providers: string[], model: string, variant?: string) {
  return { providers, model, variant };
}

function chain(kind: SlotKind, name: string, entries: Array<{ providers: string[]; model: string; variant?: string }>): SlotChain {
  return { kind, name, fallbackChain: entries.map((e, i) => ({ ...e, position: i })) };
}

/** W2 fixture: openai + deepseek + vercel availability with pricing. */
const availability = loadAvailability(loadInventory(join(FIXTURES, "w2", "inventory.yaml")), join(FIXTURES, "w2", "models.json"));

function solve(input: Partial<SolveInput> & { chains: SlotChain[]; caps: Map<string, number | null> }) {
  return solveChains({ chains: input.chains, availability: input.availability ?? availability, caps: input.caps, tiers, skipPinned: input.skipPinned });
}

// ---- S2a: forbidden assignments unreachable across full 19-slot enumeration ----

test("S2a: every forbidden assignment is unreachable across the 19-slot enumeration", () => {
  const chains = extractChains();
  const caps = new Map<string, number | null>([
    ["openai", 0.8],
    ["deepseek", null],
    ["opencode-go", 0.9],
  ]);
  const solveInput: SolveInput = { chains, availability, caps, tiers };
  const result = solveChains(solveInput);

  // Every resolved assignment must pass the forbidden NOT-IN filter.
  for (const a of result.assignments) {
    expect(isForbidden({ slot: a.slot, model: a.primary.model, provider: a.primary.provider }), `forbidden: ${a.slot}=${a.primary.model}`).toBe(false);
    for (const fb of a.fallbacks) {
      expect(isForbidden({ slot: a.slot, model: fb.model, provider: fb.provider }), `forbidden fallback: ${a.slot}=${fb.model}`).toBe(false);
    }
  }

  // Brute-force enumeration: for EVERY slot × EVERY chain candidate, a legal assignment never picks a forbidden pair.
  for (const slot of chains) {
    for (const e of slot.fallbackChain) {
      const provider = e.providers[0]!;
      expect(
        isForbidden({ slot: slot.name, model: e.model, provider }),
        `enumeration hit forbidden pair ${slot.name}=${e.model}`,
      ).toBe(false);
    }
  }
});

// ---- S2b: determinism ----------------------------------------------------------

test("S2b: same input → byte-identical output (deterministic solver)", () => {
  const chains = extractChains();
  const caps = new Map<string, number | null>([["openai", 0.8], ["deepseek", null]]);
  const a = solveChains({ chains, availability, caps, tiers });
  const b = solveChains({ chains, availability, caps, tiers });
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

// ---- S2c: P5 tiebreak chain exercised -------------------------------------------

test("S2c: quality tie resolves via P5 chain — lower projected cost wins (#1)", () => {
  // Same model served by two providers → IDENTICAL fit × capability (genuine tie) → cost decides.
  const chains = [
    chain("agent", "cost-slot", [
      entry(["openai", "openrouter"], "gpt-5.6-sol"), // openai metered 75, openrouter metered 88
    ]),
  ];
  const caps = new Map<string, number | null>([["openai", 0.8], ["openrouter", 0.9]]); // both trusted
  const result = solve({ chains, caps });
  const a = result.assignments.find((x) => x.slot === "cost-slot")!;
  expect(a.primary.provider, "cheaper provider should win the tie (P5 #1)").toBe("openai");
  expect(a.primary.model).toBe("gpt-5.6-sol");
});

test("S2c: quality tie resolves via P5 chain — greater quota headroom wins (#2)", () => {
  // Same model, same pricing (cost ties too) → remaining quota headroom decides.
  const chains = [
    chain("agent", "headroom-slot", [
      entry(["openai", "openrouter"], "gpt-5.6-luna-fast"), // openai headroom 0.8, openrouter 0.99
    ]),
  ];
  const caps = new Map<string, number | null>([["openai", 0.8], ["openrouter", 0.99]]);
  const result = solve({ chains, caps });
  const a = result.assignments.find((x) => x.slot === "headroom-slot")!;
  expect(a.primary.provider, "greater remaining headroom should win the tie (P5 #2)").toBe("openrouter");
});

test("W2.3: compareCandidates applies the FULL P5 chain — chain position (#3) then lexical model id (#4)", () => {
  const base = {
    provider: "openai",
    model: "gpt-5.6-sol",
    fit: 1.0,
    capability: 1.0,
    quality: 1.0,
    projectedCost: 0,
    quotaHeadroom: 0.8,
    trusted: true,
  };
  const at = (position: number, model: string): Candidate => ({
    ...base,
    model,
    entry: { providers: ["openai"], model, position },
  });
  // Equal quality/cost/headroom, different positions → earlier chain position wins (#3).
  expect(compareCandidates(at(0, "gpt-5.4-nano"), at(1, "gpt-5.4-nano"))).toBeLessThan(0);
  // Equal everything incl. position → lexical model id wins (#4) — totality, never omit.
  expect(compareCandidates(at(2, "gpt-5.6-sol"), at(2, "gpt-5.6-luna-fast"))).toBeGreaterThan(0);
  expect(compareCandidates(at(2, "gpt-5.6-luna-fast"), at(2, "gpt-5.6-sol"))).toBeLessThan(0);
});

test("W2.3: solver head (fit 1.0) beats member (fit 0.8) on the same provider — position-decay fit", () => {
  const chains = [
    chain("agent", "pos-slot", [
      entry(["openai"], "gpt-5.4-nano"), // position 0 → fit 1.0 × 0.7 = 0.7
      entry(["openai"], "gpt-5.6-luna-fast"), // position 1 → fit 0.8 × 0.7 = 0.56
    ]),
  ];
  const caps = new Map<string, number | null>([["openai", 0.8]]);
  const result = solve({ chains, caps });
  const a = result.assignments.find((x) => x.slot === "pos-slot")!;
  expect(a.primary.model, "head-position candidate (higher fit) should win").toBe("gpt-5.4-nano");
});

// ---- S3: cap=null overflow-only -------------------------------------------------

test("S3: cap=null provider is overflow-only — trusted candidate wins when present", () => {
  // deepseek (cap=null) has the HIGHER chain position but openai (trusted) is available.
  const chains = [
    chain("agent", "ovf-slot", [
      entry(["openai"], "gpt-5.6-luna-fast", "low"), // trusted
      entry(["deepseek"], "deepseek-v4-flash", "max"), // untrusted (cap=null)
    ]),
  ];
  const caps = new Map<string, number | null>([["openai", 0.8], ["deepseek", null]]);
  const result = solve({ chains, caps });
  const a = result.assignments.find((x) => x.slot === "ovf-slot")!;
  expect(a.primary.provider, "trusted provider must be preferred over untrusted (overflow-only)").toBe("openai");
  expect(a.primary.trusted).toBe(true);
});

test("S3: cap=null provider used ONLY when no trusted candidate exists (overflow) — marked untrusted", () => {
  const chains = [
    chain("agent", "deep-slot", [
      entry(["deepseek"], "deepseek-v4-flash", "max"), // only candidate for this slot, untrusted
    ]),
  ];
  // openai is a TRUSTED provider in the system, but has no candidate for deep-slot → deepseek overflows.
  const caps = new Map<string, number | null>([["deepseek", null], ["openai", 0.8]]);
  const result = solve({ chains, caps });
  const a = result.assignments.find((x) => x.slot === "deep-slot")!;
  expect(a.primary.provider).toBe("deepseek");
  expect(a.primary.trusted).toBe(false);
  expect(a.untrusted, "overflow assignment must carry the untrusted marker").toBe(true);
});

// ---- S3b: all-untrusted degenerate (P1) -----------------------------------------

test("S3b: all-null inventory → deterministic quality-only, single banner, NO per-assignment markers", () => {
  const chains = [
    chain("agent", "a1", [entry(["deepseek"], "deepseek-v4-flash", "max")]),
    chain("agent", "a2", [entry(["openai"], "gpt-5.6-luna-fast", "low")]),
  ];
  const caps = new Map<string, number | null>([["deepseek", null], ["openai", null]]); // EMPTY trusted set
  const result = solve({ chains, caps });
  expect(result.allUntrusted, "all-null inventory → allUntrusted=true").toBe(true);
  expect(result.assignments.length).toBe(2);
  // Deterministic quality-only assignment (no capacity term): pure fit × capability argmax.
  expect(result.assignments.find((x) => x.slot === "a1")!.primary.model).toBe("deepseek-v4-flash");
  expect(result.assignments.find((x) => x.slot === "a2")!.primary.model).toBe("gpt-5.6-luna-fast");
  // P1: per-assignment untrusted markers SUPPRESSED.
  for (const a of result.assignments) expect(a.untrusted, "per-assignment untrusted markers suppressed in all-untrusted case").toBeUndefined();
});

// ---- S6: DeepSeek injection ------------------------------------------------------

test("S6: hephaestus NEVER receives a DeepSeek model (primary or fallback)", () => {
  const chains = [
    chain("agent", "hephaestus", [
      entry(["openai"], "gpt-5.6-sol", "medium"),
      entry(["deepseek"], "deepseek-v4-pro"), // even if deepseek is in its chain, must not resolve to it
    ]),
  ];
  const caps = new Map<string, number | null>([["openai", 0.8], ["deepseek", 0.9]]);
  const result = solve({ chains, caps });
  const a = result.assignments.find((x) => x.slot === "hephaestus")!;
  expect(a.primary.model.startsWith("deepseek")).toBe(false);
  for (const fb of a.fallbacks) expect(fb.model.startsWith("deepseek"), "hephaestus fallback must never be deepseek").toBe(false);
});

test("S6: GPT-family legal slots get DeepSeek in fallback AFTER GPT entries, BEFORE MiniMax", () => {
  const chains = [
    chain("category", "ultrabrain", [
      entry(["openai"], "gpt-5.6-sol", "xhigh"),
      entry(["openai"], "gpt-5.5", "high"),
      entry(["vercel"], "minimax-m2.7-highspeed"),
    ]),
  ];
  const caps = new Map<string, number | null>([["openai", 0.8], ["vercel", 0.9]]);
  const result = solve({ chains, caps });
  const a = result.assignments.find((x) => x.slot === "ultrabrain")!;
  const models = [a.primary.model, ...a.fallbacks.map((f) => f.model)];
  const deepIdx = models.findIndex((m) => m.startsWith("deepseek"));
  const gptIdx = models.findIndex((m) => m.startsWith("gpt-"));
  const miniIdx = models.findIndex((m) => m.startsWith("minimax"));
  expect(deepIdx, "deepseek must be injected for GPT-family slot").toBeGreaterThan(-1);
  expect(gptIdx).toBeLessThan(deepIdx); // after GPT entries
  expect(deepIdx).toBeLessThan(miniIdx); // before MiniMax
});

// ---- capability mapping (flags + tiers, self-report discount) --------------------

test("W2.3: capability maps from models.json flags + tiers.json (0.9 self-report discount)", () => {
  // deepseek-v4-flash: flags reasoning=false tool_call=true → base 0.7; tier deepseek-flash 0.7 self_reported → 0.7×0.9=0.63
  const cap = computeCapability({ provider: "deepseek", model: "deepseek-v4-flash" }, availability, tiers);
  expect(cap).toBeCloseTo(0.63, 5);
  // gpt-5.6-sol: reasoning=true tool_call=true → 1.0; tier gpt-sol 1.0 not self_reported → 1.0
  const capGpt = computeCapability({ provider: "openai", model: "gpt-5.6-sol" }, availability, tiers);
  expect(capGpt).toBe(1.0);
});
