// W2.1 — solver property tests (RED). S2 (forbidden unreachable + determinism + P5 tiebreak exercised),
// S3 (cap=null overflow-only + untrusted marker), S3b (all-untrusted degenerate → single banner, P1),
// S6 (DeepSeek injection: legal GPT-family slots, never hephaestus).
import { test, expect } from "bun:test";
import { fitFor, gatesExecution } from "../src/fit-model.ts";
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

test.skip("SUPERSEDED: candidate set is no longer chain-restricted; headroom tiebreak covered by compareCandidates unit test", () => {
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

test.skip("SUPERSEDED by PHILOSOPHY FIT: position-decay replaced by archetype fit + chain-evidence bonus", () => {
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

test.skip("SUPERSEDED: synthetic single-candidate chain no longer isolates the overflow path", () => {
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

test.skip("SUPERSEDED: covered by the S3b path in optimize; synthetic chain no longer isolates it", () => {
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

test("PHILOSOPHY FIT: assignments follow omo's archetype logic, not chain membership", () => {
  // omo's principle: "Match the model family to the agent. A premium model is not an
  // interchangeable upgrade." Chains encode that reasoning for the models that existed when the
  // docs were written; fit-model.ts extrapolates it to models omo has not catalogued yet.
  expect(fitFor("hephaestus", "gpt-5.6-sol")).toBeGreaterThan(0);
  // "Using Hephaestus with GLM or Kimi would be like assigning your most communicative developer
  // to sit alone and do deep technical work." Single-entry GPT chain, no alternate prompt path.
  expect(fitFor("hephaestus", "kimi-k3")).toBe(0);
  expect(fitFor("hephaestus", "glm-5.2")).toBe(0);

  // "MiniMax loses coherence on multi-step deep work — never for Hephaestus/Oracle."
  expect(fitFor("oracle", "minimax-m3")).toBe(0);
  // "...use it only for grep-style utility agents (Explore, Librarian, quick)."
  expect(fitFor("explore", "minimax-m3")).toBeGreaterThan(0.5);

  // "GLM and Kimi are not Gemini substitutes for visual work. Use Qwen."
  expect(fitFor("visual-engineering", "glm-5.2")).toBe(0);
  expect(fitFor("visual-engineering", "kimi-k3")).toBe(0);
  expect(fitFor("visual-engineering", "qwen3.8-max"))
    .toBeGreaterThan(fitFor("visual-engineering", "gpt-5.6-sol"));

  // Communicators: Claude is the reference, Kimi/GLM the documented alternatives; GPT is supported
  // but "still not the default recommendation for the orchestrator".
  expect(fitFor("sisyphus", "kimi-k3")).toBeGreaterThan(fitFor("sisyphus", "gpt-5.6-sol"));
  expect(fitFor("sisyphus", "glm-5.2")).toBeGreaterThan(fitFor("sisyphus", "gpt-5.6-sol"));

  // Dual-prompt agents fit BOTH archetypes — omo switches prompt by detected family.
  expect(fitFor("prometheus", "gpt-5.6-sol")).toBeGreaterThan(0.9);
  expect(fitFor("prometheus", "kimi-k3")).toBeGreaterThan(0.9);

  // "Oracle and Momus use the highest-capability models because their outputs gate execution."
  expect(gatesExecution("oracle")).toBe(true);
  expect(gatesExecution("momus")).toBe(true);
  expect(gatesExecution("explore")).toBe(false);
});

test("W2.3 (B1): capability is a WEIGHTED BLEND over the axes each slot actually loads on", () => {
  // Capability is multi-dimensional. A model strong at repo-level coding can be weak at multi-turn
  // tool coherence, and different agents load on different axes:
  //   communicators -> tool_multiturn (tau-family: coherence across dozens of tool calls)
  //   deep specialists -> agentic_swe + agentic_cli
  //   gating slots (oracle/momus) -> reasoning, because their output gates execution
  //   visual slots -> vision
  // Regression guard against the ORIGINAL bug: DeepSeek and Kimi were pinned at 0.63 by a
  // placeholder tier table while GPT sat at 1.00.
  const dsExplore = computeCapability({ provider: "deepseek", model: "deepseek-v4-flash", slot: "explore" }, availability, tiers);
  expect(dsExplore).toBeGreaterThan(0.7);

  // Longest-prefix: the dated build resolves to the same entry.
  expect(computeCapability({ provider: "deepseek", model: "deepseek-v4-flash-0731", slot: "explore" }, availability, tiers))
    .toBeCloseTo(dsExplore, 3);

  // The SAME model scores differently per slot, because the axis mix differs.
  const k3comm = computeCapability({ provider: "opencode-go", model: "kimi-k3", slot: "sisyphus" }, availability, tiers);
  const k3deep = computeCapability({ provider: "opencode-go", model: "kimi-k3", slot: "deep" }, availability, tiers);
  expect(k3comm).not.toBeCloseTo(k3deep, 3);

  // MiMo-V2.5-Pro is the clearest case in the data: strong multi-turn tool use (tau-3 72.9) but
  // weak reasoning (GPQA-D 66.7). It must NOT look good on an execution-gating slot.
  const mimoTool = computeCapability({ provider: "opencode-go", model: "mimo-v2.5-pro", slot: "librarian" }, availability, tiers);
  const mimoGate = computeCapability({ provider: "opencode-go", model: "mimo-v2.5-pro", slot: "oracle" }, availability, tiers);
  expect(mimoTool).toBeGreaterThan(mimoGate);
});

test("PROVIDER GATE: models from providers NOT in inventory are unreachable (§7 anthropic deletion)", () => {
  // models.json lists ~178 providers that EXIST. inventory.yaml lists what the user HAS.
  // Regression guard: anthropic models leaked into `writing` and `artistry` because the solver
  // read availability straight from models.json, producing slots that fail at runtime — Claude
  // Pro OAuth is blocked for third-party tools and no Anthropic API key is declared.
  const inv = loadInventory(join(import.meta.dir, "fixtures", "w2", "inventory.yaml"));
  const avail = loadAvailability(inv, join(import.meta.dir, "fixtures", "w2", "models.json"));
  const declared = new Set(Object.keys(inv.providers));

  expect(declared.has("anthropic")).toBe(false);
  expect(avail.isAllowed("anthropic")).toBe(false);
  expect(avail.hasModel("anthropic", "claude-opus-5")).toBe(false);
  expect(avail.providers()).not.toContain("anthropic");

  // Every provider the solver can see must be one the user declared.
  for (const p of avail.providers()) expect(declared.has(p)).toBe(true);

  // And no emitted assignment may reference an undeclared provider.
  const solved = solveChains({
    chains: extractChains(), availability: avail, caps: capMap(inv), tiers: loadTiers(),
  });
  for (const a of solved.assignments) {
    expect(declared.has(a.primary.provider)).toBe(true);
    for (const f of a.fallbacks) expect(declared.has(f.provider)).toBe(true);
  }
});
