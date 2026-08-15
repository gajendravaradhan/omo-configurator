// Chain extraction from the BUNDLED source, not a runtime export (bundle §2 fact 2, VERIFIED 2026-08-05):
// AGENT_MODEL_REQUIREMENTS / CATEGORY_MODEL_REQUIREMENTS are declared with `var` inside dist/index.js
// and are NOT exported at top level; @oh-my-opencode/model-core is not on npm; the package ships
// dist-only (no src/), so ts-morph is infeasible. We AST-parse the bundled dist with acorn.
//
// Pinning (bundle §1): record the pinned SHA (sha256 of dist/index.js content) in the report;
// `plutus check-chains` diffs parsed-vs-snapshot chains and warns on drift (exit 3 on unresolved drift).
import { parse } from "acorn";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SlotChain, SlotKind } from "./types.ts";

const require = createRequire(import.meta.url);

/** Emit-shape decision per bundle §1.4 + P8. Agents emit `fallback_models` (schema has no `models` key);
 *  categories emit `models` (non-deprecated). VERIFIED by schema inspection 2026-08-05/07: agent entries
 *  allow model/fallback_models/... with additionalProperties:false; category entries allow model/models/fallback_models. */
export const EMIT_SHAPE = {
  agents: "fallback_models" as const, categories: "models" as const,
} as const;

/** P8: omo version this emit-shape decision was probed against. Startup mismatch → exit 3. */
export const PROBED_OMO_VERSION = "4.19.4";

/** Path to the installed oh-my-openagent dist/index.js (resolved via the schema.json exports entry). */
export function omoDistPath(): string {
  return require.resolve("oh-my-openagent/schema.json").replace(/\/oh-my-opencode\.schema\.json$/, "/index.js");
}

/** Installed oh-my-openagent version (from package.json). */
export function installedOmoVersion(): string {
  const pkgPath = require.resolve("oh-my-openagent/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

/** sha256 of dist/index.js — the pinned chain identity recorded in reports. */
export function pinnedChainSha(): string {
  return createHash("sha256").update(readFileSync(omoDistPath(), "utf8")).digest("hex");
}

/** W1.4/P8 startup check: installed omo version must match the probed version, else exit 3. */
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

// ---- AST extraction ----------------------------------------------------------

type AnyNode = Record<string, unknown> & { type: string };

function keyName(k: unknown): string | null {
  if (!k || typeof k !== "object") return null;
  const key = k as { type: string; name?: string; value?: unknown };
  return key.type === "Identifier" && typeof key.name === "string" ? key.name :
    key.type === "Literal" && typeof key.value === "string" ? key.value : null;
}

/** Deep-search the AST for the VariableDeclarator initializer of a top-level const. */
function findVarInit(ast: AnyNode, name: string): AnyNode | null {
  const visit = (node: unknown): AnyNode | null => {
    if (!node || typeof node !== "object") return null;
    const n = node as AnyNode;
    if (n.type === "VariableDeclarator") {
      const id = n.id as { type?: string; name?: string } | undefined;
      if (id?.type === "Identifier" && id.name === name) return (n.init as AnyNode) ?? null;
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) {
        for (const c of v) { const r = visit(c); if (r) return r; }
      } else if (v && typeof v === "object") {
        const r = visit(v);
        if (r) return r;
      }
    }
    return null;
  };
  return visit(ast);
}

function materialize(node: AnyNode | null): unknown {
  if (!node) return null;
  switch (node.type) {
    case "Literal":
      return node.value;
    case "ArrayExpression":
      return (node.elements as unknown[]).map((e) => materialize(e as AnyNode | null));
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type !== "Property") continue;
        const k = keyName(prop.key);
        if (k !== null) out[k] = materialize(prop.value as AnyNode | null);
      }
      return out;
    }
    default:
      // TemplateLiteral / spread / identifier refs etc. — bail to null (not present in these consts).
      return null;
  }
}

interface RawChainEntry {
  providers?: string[]; model?: string; variant?: string;
}

interface RawSlot {
  fallbackChain?: RawChainEntry[]; requiresAnyModel?: boolean; requiresProvider?: string[];
}

function buildChains(raw: Record<string, RawSlot>, kind: SlotKind): SlotChain[] {
  return Object.entries(raw).map(([name, slot]) => {
    const fallbackChain = (slot.fallbackChain ?? []).map((e, i) => ({ providers: e.providers ?? [], model: e.model ?? "", variant: e.variant, position: i }));
    return { kind, name, fallbackChain, requiresAnyModel: slot.requiresAnyModel, requiresProvider: slot.requiresProvider };
  });
}

/** Extract all 19 runtime slot chains (11 agents + 8 categories) from the installed omo dist. */
export function extractChains(): SlotChain[] {
  const src = readFileSync(omoDistPath(), "utf8");
  const ast = parse(src, { ecmaVersion: "latest", sourceType: "module" }) as unknown as AnyNode;
  const agentInit = findVarInit(ast, "AGENT_MODEL_REQUIREMENTS");
  const catInit = findVarInit(ast, "CATEGORY_MODEL_REQUIREMENTS");
  const agents = (materialize(agentInit) ?? {}) as Record<string, RawSlot>, cats = (materialize(catInit) ?? {}) as Record<string, RawSlot>;
  return [...buildChains(agents, "agent"), ...buildChains(cats, "category")];
}

// ---- W0 fixture loader (kept for tests/fixtures) ------------------------------

export function loadFixtureChains(raw: { agents?: Record<string, { fallbackChain: Array<{ providers: string[]; model: string; variant?: string }>; requiresAnyModel?: boolean; requiresProvider?: string[] }>; categories?: Record<string, { fallbackChain: Array<{ providers: string[]; model: string; variant?: string }> }> }): SlotChain[] {
  const agents = Object.entries(raw.agents ?? {}).map(([name, c]) => ({ kind: "agent" as const, name, fallbackChain: c.fallbackChain.map((e, i) => ({ ...e, position: i })), requiresAnyModel: c.requiresAnyModel, requiresProvider: c.requiresProvider }));
  const categories = Object.entries(raw.categories ?? {}).map(([name, c]) => ({ kind: "category" as const, name, fallbackChain: c.fallbackChain.map((e, i) => ({ ...e, position: i })) }));
  return [...agents, ...categories];
}
