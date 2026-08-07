// Chain extraction. W1 replaces the fixture loader with AST parsing of
// oh-my-openagent/dist/index.js (VERIFIED 2026-08-05: AGENT_MODEL_REQUIREMENTS /
// CATEGORY_MODEL_REQUIREMENTS are NOT exported at top level; @oh-my-opencode/model-core
// is not on npm; ts-morph infeasible — dist-only package). For W0 we load a fixture.
import type { SlotChain, ChainEntry } from "./types.ts";

/** Emit-shape decision per bundle §1.4 + P8. Agents emit `fallback_models` (schema has no `models`);
 *  categories emit `models` (non-deprecated). Verified by schema inspection 2026-08-05. */
export const EMIT_SHAPE = {
  agents: "fallback_models" as const,
  categories: "models" as const,
} as const;

/** P8: omo version this emit-shape decision was probed against. Recorded in report;
 *  startup mismatch → exit 3 ("emit-shape decision was made against omo vX; re-run plutus check-chains"). */
export const PROBED_OMO_VERSION = "4.19.4";

/** W1.4 stub: validate installed omo version vs probed; returns the installed version or throws with exit 3. */
export function assertOmoVersion(installedVersion: string): void {
  if (installedVersion !== PROBED_OMO_VERSION) {
    const e: Error & { exitCode?: number } = new Error(
      `emit-shape decision was made against omo v${PROBED_OMO_VERSION}; installed is v${installedVersion}. ` +
        `Re-run \`plutus check-chains\`.`,
    );
    e.exitCode = 3;
    throw e;
  }
}

/** W0 fixture chain loader. W1.2 replaces with AST parsing of dist/index.js. */
export function loadFixtureChains(raw: {
  agents?: Record<string, { fallbackChain: Array<{ providers: string[]; model: string; variant?: string }>; requiresAnyModel?: boolean; requiresProvider?: string[] }>;
  categories?: Record<string, { fallbackChain: Array<{ providers: string[]; model: string; variant?: string }> }>;
}): SlotChain[] {
  const chains: SlotChain[] = [];
  for (const [name, c] of Object.entries(raw.agents ?? {})) {
    chains.push({ kind: "agent", name, fallbackChain: c.fallbackChain.map((e, i) => ({ ...e, position: i })), requiresAnyModel: c.requiresAnyModel, requiresProvider: c.requiresProvider });
  }
  for (const [name, c] of Object.entries(raw.categories ?? {})) {
    chains.push({ kind: "category", name, fallbackChain: c.fallbackChain.map((e, i) => ({ ...e, position: i })) });
  }
  return chains;
}

export type { ChainEntry };