// plutus-report.md writer. W0: minimal — v1-boundary header (P2, verbatim) + per-slot table +
// assumptions/trust. W5.2 expands to full audit detail (projected consumption, pinned SHA,
// schema $id+hash, NAS-db caveat, tiebreak rationale).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Assignment, SolveResult } from "./types.ts";

/** P2 — verbatim v1 product-boundary statement; must head EVERY plutus-report.md. */
export const V1_BOUNDARY_STATEMENT =
  "v1 does not enforce budget. It emits quality-optimal legal assignments and reports projected consumption. " +
  "Live budget coupling, shadow prices, and adaptive rebalancing are v2, gated on SPIKE-02 and SPIKE-06.";

/** S3b / P1 single banner — exactly ONE, and per-assignment untrusted markers suppressed. */
export const ALL_UNTRUSTED_BANNER =
  "No provider has verified capacity. Assignments are quality-optimal only; budget constraints are NOT enforced.";

export function renderReport(solve: SolveResult, inventoryNames: string[], opts: { schemaId?: string; chainSha?: string } = {}): string {
  const lines: string[] = [];
  lines.push("# plutus-report", "");
  lines.push(`> ${V1_BOUNDARY_STATEMENT}`, "");

  if (solve.allUntrusted) {
    lines.push(`**${ALL_UNTRUSTED_BANNER}**`, "");
  }

  lines.push("## Assignments", "");
  lines.push("| slot | kind | primary model | provider | fit | capability | quality | trusted |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const a of solve.assignments) {
    lines.push(
      `| ${a.slot} | ${a.kind} | ${a.primary.model} | ${a.primary.provider} | ${a.primary.fit} | ${a.primary.capability} | ${a.primary.quality.toFixed(2)} | ${a.primary.trusted} |`,
    );
  }
  lines.push("");

  lines.push("## Rationale", "");
  for (const a of solve.assignments) {
    lines.push(`- **${a.slot}**: ${a.rationale}`);
  }
  lines.push("");

  lines.push("## Assumptions & trust levels", "");
  lines.push(`- Inventory providers: ${inventoryNames.length ? inventoryNames.join(", ") : "(none declared)"}`);
  lines.push("- Trust taxonomy: remote_api | local_estimation | user_declared");
  if (opts.chainSha) lines.push(`- Pinned chain SHA: ${opts.chainSha}`);
  if (opts.schemaId) lines.push(`- Schema $id: ${opts.schemaId}`);
  lines.push("");

  return lines.join("\n");
}

/** Write the report next to the emitted config; returns the report path. */
export function writeReport(
  solve: SolveResult,
  outputDir: string,
  opts: { schemaId?: string; chainSha?: string; inventoryNames?: string[] } = {},
): string {
  const path = join(outputDir, "plutus-report.md");
  writeFileSync(path, renderReport(solve, opts.inventoryNames ?? [], opts), "utf8");
  return path;
}