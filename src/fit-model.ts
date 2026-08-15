// Fit derived from omo's PHILOSOPHY, not from chain membership.
//
// omo's stated principle: "Every agent's prompt is tuned to match its model's personality. When you
// change the model, you change the brain — and the same instructions get understood completely
// differently." And: "Match the model family to the agent. A premium model is not an interchangeable
// upgrade."
//
// Chains encode that reasoning for the models that existed when the docs were written. They are
// EVIDENCE of the reasoning, not the reasoning itself. omo's catalogue moves faster than its docs —
// Qwen3.8 Max, Grok 4.5, GLM-5.3, MiMo-V2.5 and Hy3 are all live on OpenCode Go and appear in no
// chain. This module extrapolates omo's own logic to them, which is the job omo's maintainers would
// do if their docs kept pace.
//
// The three archetypes are omo's, quoted from the matching guide:
//
//  COMMUNICATOR — Sisyphus, Metis, Atlas, Sisyphus-Junior, unspecified-*, Prometheus (Claude path).
//    "Sisyphus is the developer who knows everyone... gets things done through communication and
//    coordination." Needs: following complex multi-step instructions (~1,100-line prompt),
//    maintaining flow across many tool calls, nuanced delegation. Claude is the reference; "Kimi
//    K2.5/2.6 outperforms GLM under Sisyphus's nested todo+delegation prompts."
//
//  DEEP_SPECIALIST — Hephaestus, Oracle, Momus, deep, ultrabrain, Prometheus/Atlas (GPT path).
//    "Hephaestus is the developer who stays in their room coding all day... give them a hard
//    technical problem and they'll emerge three hours later with a solution nobody else could have
//    found." Principle-driven, autonomous, goal-oriented independent reasoning. "DeepSeek keeps
//    GPT's autonomous exploration character." "Oracle and Momus use the highest-capability models
//    because their outputs gate execution."
//
//  VISUAL — visual-engineering, artistry, multimodal-looker, Oracle (visual fallback).
//    "GLM and Kimi are not Gemini substitutes for visual work. Use Qwen."
//
//  SPEED_UTILITY — explore, librarian, quick.
//    "Explore — Fast codebase grep. Uses speed-focused models for pattern discovery." And the one
//    place MiniMax is sanctioned: "MiniMax loses coherence on multi-step deep work — use it only for
//    grep-style utility agents (Explore, Librarian, quick), never for Hephaestus/Oracle."

export type Archetype = "communicator" | "deep_specialist" | "visual" | "speed_utility";

export interface AgentProfile {
  archetype: Archetype;
  /** Output gates execution downstream — bias hard toward capability, never toward cheapness. */
  gatesExecution?: boolean;
  /** Dual-prompt agent: switches prompt by detected family, so two archetypes are both native. */
  altArchetype?: Archetype;
}

/** omo's 19 slots mapped to the archetype its prompt is written for. */
export const AGENT_PROFILES: Record<string, AgentProfile> = {
  // Communicators — mechanics-driven prompts, heavy delegation.
  sisyphus: { archetype: "communicator" },
  metis: { archetype: "communicator" },
  "sisyphus-junior": { archetype: "communicator" },
  "unspecified-low": { archetype: "communicator" },
  "unspecified-high": { archetype: "communicator" },
  writing: { archetype: "communicator" },

  // Dual-prompt — omo auto-switches the prompt to the detected family, so both fit natively.
  atlas: { archetype: "communicator", altArchetype: "deep_specialist" },
  prometheus: { archetype: "communicator", altArchetype: "deep_specialist" },

  // Deep specialists — principle-driven autonomous execution.
  hephaestus: { archetype: "deep_specialist" },
  oracle: { archetype: "deep_specialist", gatesExecution: true },
  momus: { archetype: "deep_specialist", gatesExecution: true },
  deep: { archetype: "deep_specialist" },
  ultrabrain: { archetype: "deep_specialist", gatesExecution: true },

  // Visual — "Use Qwen."
  "visual-engineering": { archetype: "visual" },
  artistry: { archetype: "visual" },
  "multimodal-looker": { archetype: "visual" },

  // Speed utilities — grep-style pattern discovery; the sanctioned home for MiniMax.
  explore: { archetype: "speed_utility" },
  librarian: { archetype: "speed_utility" },
  quick: { archetype: "speed_utility" },
};

/** Model families, by the working style omo attributes to them. */
export type Family =
  | "claude" | "kimi" | "glm" | "gpt" | "deepseek" | "qwen"
  | "minimax" | "grok" | "mimo" | "gemini" | "hy" | "unknown";

export function familyOf(model: string): Family {
  const m = model.toLowerCase();
  if (m.startsWith("claude")) return "claude";
  if (m.startsWith("kimi")) return "kimi";
  if (m.startsWith("glm")) return "glm";
  if (m.startsWith("gpt")) return "gpt";
  if (m.startsWith("deepseek")) return "deepseek";
  if (m.startsWith("qwen")) return "qwen";
  if (m.startsWith("minimax")) return "minimax";
  if (m.startsWith("grok")) return "grok";
  if (m.startsWith("mimo")) return "mimo";
  if (m.startsWith("gemini")) return "gemini";
  if (m.startsWith("hy")) return "hy";
  return "unknown";
}

/**
 * Affinity of each family for each archetype, in [0,1].
 *
 * Values quoted or directly inferred from omo's guide are marked. Families omo has not written
 * about (grok, mimo, hy) are scored by the closest documented analogue and are DELIBERATELY
 * conservative — never above the families omo explicitly endorses for that archetype. An
 * undocumented model has to earn its place on capability, not receive a fit bonus for novelty.
 */
export const AFFINITY: Record<Family, Record<Archetype, number>> = {
  //                    communicator  deep_specialist  visual  speed_utility
  claude:      { communicator: 1.00, deep_specialist: 0.70, visual: 0.30, speed_utility: 0.40 },
  kimi:        { communicator: 1.00, deep_specialist: 0.60, visual: 0.30, speed_utility: 0.70 },
  glm:         { communicator: 0.90, deep_specialist: 0.60, visual: 0.30, speed_utility: 0.70 },
  gpt:         { communicator: 0.65, deep_specialist: 1.00, visual: 0.60, speed_utility: 0.85 },
  deepseek:    { communicator: 0.55, deep_specialist: 0.90, visual: 0.40, speed_utility: 0.90 },
  qwen:        { communicator: 0.55, deep_specialist: 0.70, visual: 1.00, speed_utility: 0.80 },
  gemini:      { communicator: 0.55, deep_specialist: 0.70, visual: 1.00, speed_utility: 0.80 },
  minimax:     { communicator: 0.30, deep_specialist: 0.10, visual: 0.30, speed_utility: 0.90 },
  grok:        { communicator: 0.60, deep_specialist: 0.80, visual: 0.50, speed_utility: 0.60 },
  mimo:        { communicator: 0.50, deep_specialist: 0.60, visual: 0.40, speed_utility: 0.85 },
  hy:          { communicator: 0.50, deep_specialist: 0.55, visual: 0.40, speed_utility: 0.85 },
  unknown:     { communicator: 0.40, deep_specialist: 0.40, visual: 0.40, speed_utility: 0.50 },
};

/**
 * Families with a DEDICATED prompt path in omo. The guide is explicit that prompts are tuned per
 * family, so a model whose family omo actually wrote a prompt for is understood as intended.
 * Everything else runs a prompt written for someone else — a real, if modest, penalty.
 */
const PROMPT_PATH_FAMILIES: ReadonlySet<Family> = new Set(["claude", "gpt", "kimi", "glm", "gemini"]);
const PROMPT_PATH_BONUS = 1.0;
const NO_PROMPT_PATH = 0.92;

/** Hard exclusions from omo's guide — these are constraints, not preferences. */
export function isExcluded(slot: string, model: string): boolean {
  const f = familyOf(model);
  const p = AGENT_PROFILES[slot];
  if (!p) return false;
  // "MiniMax loses coherence on multi-step deep work — never for Hephaestus/Oracle."
  if (f === "minimax" && p.archetype === "deep_specialist") return true;
  // "GLM and Kimi are not Gemini substitutes for visual work."
  if (p.archetype === "visual" && (f === "glm" || f === "kimi")) return true;
  // Hephaestus has a single-entry chain requiring GPT: no alternate prompt path exists.
  if (slot === "hephaestus" && f !== "gpt") return true;
  return false;
}

/**
 * fit(slot, model) in [0,1] — archetype affinity x prompt-path factor.
 * Dual-prompt agents take the better of their two archetypes, since omo switches prompt at runtime.
 */
export function fitFor(slot: string, model: string): number {
  const p = AGENT_PROFILES[slot];
  if (!p) return 0.5;
  if (isExcluded(slot, model)) return 0;
  const f = familyOf(model);
  const primary = AFFINITY[f][p.archetype];
  const alt = p.altArchetype ? AFFINITY[f][p.altArchetype] : 0;
  const affinity = Math.max(primary, alt);
  const promptPath = PROMPT_PATH_FAMILIES.has(f) ? PROMPT_PATH_BONUS : NO_PROMPT_PATH;
  return Math.round(affinity * promptPath * 1000) / 1000;
}

/** Slots whose output gates execution — cost-aversion is forced to 0 regardless of volume. */
export function gatesExecution(slot: string): boolean {
  return AGENT_PROFILES[slot]?.gatesExecution === true;
}

/** Human-readable justification for the report — every assignment must be explainable. */
export function fitRationale(slot: string, model: string): string {
  const p = AGENT_PROFILES[slot];
  if (!p) return "no profile";
  if (isExcluded(slot, model)) return `EXCLUDED: ${familyOf(model)} is not permitted for ${p.archetype} slots`;
  const f = familyOf(model);
  const arch = p.altArchetype && AFFINITY[f][p.altArchetype] > AFFINITY[f][p.archetype]
    ? p.altArchetype : p.archetype;
  const path = PROMPT_PATH_FAMILIES.has(f) ? "dedicated prompt path" : "no dedicated prompt path";
  return `${arch} slot; ${f} affinity ${AFFINITY[f][arch].toFixed(2)}; ${path}`;
}
