// plutus-report.md writer. W0: minimal — v1-boundary header (P2, verbatim) + per-slot table +
// assumptions/trust. W5.2 expands to the full audit surface: projected consumption, binding
// constraint per slot, trust levels, doctor soft-check summary, P6 stale-tier flags, NAS-db caveat,
// pinned SHA, schema $id+hash.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Assignment, SolveResult, TrustSource } from "./types.ts";
import { staleTierFamilies, type Tiers } from "./quality.ts";
import type { DoctorSummary } from "./verify.ts";

/** P2 — verbatim v1 product-boundary statement; must head EVERY plutus-report.md. */
export const V1_BOUNDARY_STATEMENT =
  "v1 does not enforce budget. It emits quality-optimal legal assignments and reports projected consumption. " +
  "Live budget coupling, shadow prices, and adaptive rebalancing are v2, gated on SPIKE-02 and SPIKE-06.";

/** S3b / P1 single banner — exactly ONE, and per-assignment untrusted markers suppressed. */
export const ALL_UNTRUSTED_BANNER =
  "No provider has verified capacity. Assignments are quality-optimal only; budget constraints are NOT enforced.";

export interface ReportOpts {
  schemaId?: string;
  chainSha?: string;
  omoVersion?: string;
  mode?: string;
  tiers?: Tiers;
  trustLevels?: Record<string, TrustSource>;
  doctor?: DoctorSummary;
}

/** The slot's binding constraint — why this candidate was chosen (quality score + capacity rule). */
function bindingConstraint(a: Assignment, allUntrusted: boolean): string {
  if (allUntrusted) return "quality-only (no verified capacity — P1/S3b)";
  if (!a.primary.trusted) return "overflow (no trusted candidate for this slot — S3)";
  return "trusted window";
}

function projectedCostText(a: Assignment): string {
  const c = a.primary.projectedCost;
  return c > 0 ? `$${c.toFixed(2)}/tok-pair (proxy)` : "flat/subscription (0)";
}

export function renderReport(
  solve: SolveResult,
  inventoryNames: string[],
  opts: ReportOpts = {},
): string {
  const lines: string[] = [];
  lines.push("# plutus-report", "");
  lines.push(`> ${V1_BOUNDARY_STATEMENT}`, "");

  if (solve.allUntrusted) {
    lines.push(`**${ALL_UNTRUSTED_BANNER}**`, "");
  }

  lines.push("## Assignments", "");
  lines.push("| slot | kind | primary model | provider | fit | capability | quality | cost | trusted | binding constraint |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const a of solve.assignments) {
    lines.push(
      `| ${a.slot} | ${a.kind} | ${a.primary.model} | ${a.primary.provider} | ${a.primary.fit} | ${a.primary.capability} | ${a.primary.quality.toFixed(3)} | ${projectedCostText(a)} | ${a.primary.trusted} | ${bindingConstraint(a, solve.allUntrusted)} |`,
    );
  }
  lines.push("");

  lines.push("## Rationale", "");
  for (const a of solve.assignments) {
    lines.push(`- **${a.slot}**: ${a.rationale} — binding: ${bindingConstraint(a, solve.allUntrusted)}`);
  }
  lines.push("");

  lines.push("## Assumptions & trust levels", "");
  lines.push(`- Inventory providers: ${inventoryNames.length ? inventoryNames.join(", ") : "(none declared)"}`);
  lines.push("- Trust taxonomy: remote_api | local_estimation | user_declared");
  if (opts.trustLevels && Object.keys(opts.trustLevels).length > 0) {
    for (const [pid, trust] of Object.entries(opts.trustLevels)) {
      lines.push(`  - ${pid}: ${trust}`);
    }
  }
  lines.push("- Projected cost is a per-token input+output proxy (P5 tiebreak #1); real consumption requires token history");
  lines.push("- NAS opencode.db caveat: token history was NOT read in v1 (thin-terminal/NAS db is non-canonical; use --db-path if wiring it later) — consumption figures are estimates, not metered totals");
  if (opts.mode) lines.push(`- Mode: ${opts.mode}`);
  if (opts.chainSha) lines.push(`- Pinned chain SHA: ${opts.chainSha}`);
  if (opts.schemaId) lines.push(`- Schema $id: ${opts.schemaId}`);
  if (opts.omoVersion) {
    lines.push(`- Omo version probed for emit-shape (P8): v${opts.omoVersion}; installed must match or \`plutus optimize\` exits 3`);
    lines.push("- Emit-shape (P8): agents emit `fallback_models` (schema-forced — no `models` key for agents); categories emit `models` (non-deprecated)");
    lines.push("- P8 deprecation-warning record: omo v4.19.4 `config migrate --dry-run --json` emits NO deprecation warning for agent `fallback_models` (VERIFIED 2026-08-07)");
  }
  if (opts.tiers) {
    const stale = staleTierFamilies(opts.tiers);
    if (stale.length > 0) {
      lines.push(`- P6 stale tier entries (>90 days, flagged): ${stale.join(", ")}`);
    } else {
      lines.push("- P6 tier provenance: all tiers.json entries are within 90 days of as_of");
    }
  }
  lines.push("");

  if (opts.doctor) {
    lines.push("## Doctor soft-check (v1: warn-and-report, schema validation is the primary gate)", "");
    if (opts.doctor.ran) {
      for (const note of opts.doctor.notes) lines.push(`- ${note}`);
    } else {
      lines.push("- doctor did not run — see console warnings (soft)");
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Write the report next to the emitted config; returns the report path. */
export function writeReport(
  solve: SolveResult,
  outputDir: string,
  opts: ReportOpts & { inventoryNames?: string[] } = {},
): string {
  const path = join(outputDir, "plutus-report.md");
  writeFileSync(path, renderReport(solve, opts.inventoryNames ?? [], opts), "utf8");
  return path;
}
