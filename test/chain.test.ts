// W1.1 — chain-extraction RED test (scenario S1 groundwork).
// Asserts the FULL 19-slot runtime contract (bundle §1.13): 11 agents + 8 categories extracted
// from the installed oh-my-openagent dist with provider alternatives, model id, variant, chain order.
// RED: extractChains() does not exist yet → import fails → test fails.
import { test, expect } from "bun:test";
import { extractChains, pinnedChainSha } from "../src/chain.ts";
import type { SlotChain } from "../src/types.ts";

const AGENT_SLOTS = [
  "sisyphus",
  "hephaestus",
  "oracle",
  "librarian",
  "explore",
  "multimodal-looker",
  "prometheus",
  "metis",
  "momus",
  "atlas",
  "sisyphus-junior",
] as const;

const CATEGORY_SLOTS = [
  "visual-engineering",
  "ultrabrain",
  "deep",
  "artistry",
  "quick",
  "unspecified-low",
  "unspecified-high",
  "writing",
] as const;

test("W1: extracts all 19 runtime slots (11 agents + 8 categories)", () => {
  const chains = extractChains();
  const agents = chains.filter((c) => c.kind === "agent");
  const cats = chains.filter((c) => c.kind === "category");
  expect(agents.map((c) => c.name).sort()).toEqual([...AGENT_SLOTS].sort());
  expect(cats.map((c) => c.name).sort()).toEqual([...CATEGORY_SLOTS].sort());
  expect(chains.length).toBe(19);
});

test("W1: each slot chain has ordered entries with provider alternatives and model id", () => {
  const chains = extractChains();
  for (const chain of chains) {
    expect(chain.fallbackChain.length, `${chain.name} must have ≥1 chain entry`).toBeGreaterThan(0);
    chain.fallbackChain.forEach((entry, i) => {
      expect(entry.position, `${chain.name} entry ${i} position`).toBe(i);
      expect(typeof entry.model, `${chain.name} entry ${i} model`).toBe("string");
      expect(entry.model.length, `${chain.name} entry ${i} model non-empty`).toBeGreaterThan(0);
      expect(Array.isArray(entry.providers), `${chain.name} entry ${i} providers array`).toBe(true);
      expect(entry.providers.length, `${chain.name} entry ${i} ≥1 provider alternative`).toBeGreaterThan(0);
    });
  }
});

test("W1: variant captured when declared (sisyphus head is claude-opus-5/max)", () => {
  const chains = extractChains();
  const sisyphus = chains.find((c) => c.name === "sisyphus")!;
  expect(sisyphus.fallbackChain[0]!.model).toBe("claude-opus-5");
  expect(sisyphus.fallbackChain[0]!.variant).toBe("max");
});

test("W1: pinned chain SHA is a non-empty sha256 hex digest", () => {
  const sha = pinnedChainSha();
  expect(/^[0-9a-f]{64}$/.test(sha), `pinned SHA must be sha256 hex, got ${sha}`).toBe(true);
});

test("W1: hephaestus carries requiresProvider + requiresAnyModel (runtime flags preserved)", () => {
  const chains = extractChains();
  const heph = chains.find((c) => c.name === "hephaestus") as SlotChain;
  expect(heph.requiresAnyModel).toBe(true);
  expect(heph.requiresProvider).toContain("openai");
});
