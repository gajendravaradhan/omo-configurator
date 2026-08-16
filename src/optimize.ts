// optimize — the walking-skeleton orchestrator. W1: real chain extraction from the installed
// oh-my-openagent dist (pinned SHA) replaces the W0 fixture source; P8 startup version check wired.
// W4.2 adds the slot-level deep-merge.
import { dirname, join } from "node:path";
import { extractChains, assertOmoVersion, installedOmoVersion, pinnedChainSha, PROBED_OMO_VERSION } from "./chain.ts";
import { loadInventory, capMap } from "./inventory.ts";
import { loadAvailability, availabilityDiagnostics } from "./availability.ts";
import { solveChains } from "./solver.ts";
import { loadTiers } from "./quality.ts";
import { emitConfig, emitOmoConfig, loadPinnedSlots } from "./emitter.ts";
import { writeReport, ALL_UNTRUSTED_BANNER } from "./report.ts";
import { schemaInfo } from "./validate.ts";
import { doctorSoftCheck } from "./verify.ts";
import { appendLedger, buildLedgerEntry } from "./ledger.ts";
import { readTokenHistory } from "./tokens-history.ts";
import { enforceBudget, buildDemand, forecastBurn } from "./budget.ts";
import { pricingStatus } from "./pricing.ts";
import { windowTokensMap, windowDollarsMap, demandProfile, windowResetsMap } from "./inventory.ts";
import { PlutusError } from "./errors.ts";
import { EXIT } from "./types.ts";

export interface OptimizeArgs {
  inventoryPath: string; mode: "absolute-best" | "adaptive"; outputPath: string; dbPath: string; merge: boolean;
  /** 0 = pure quality; higher prefers cheap capability on value-seeking slots. Default 0.35. */
  costAversion?: number;
  /** Override the models.json path (B2 — lets you point at a good cache when the default is bad). */
  modelsPath?: string;
  /** Valuation instant (ISO). Drives DeepSeek peak/off-peak. Defaults to now. */
  at?: Date;
}

export async function optimize(args: OptimizeArgs): Promise<void> {
  if (args.mode === "adaptive") {
    // W6.2 stub — honest refusal: adaptive rebalancing is v2, gated on A1-A3.
    throw new PlutusError(
      "adaptive mode is not available in v1: adaptive rebalancing requires open research questions A1-A3 " +
        "(live budget coupling, shadow prices, guard daemon) to be resolved. Use --mode=absolute-best.",
      EXIT.SPIKE,
    );
  }

  const inventory = loadInventory(args.inventoryPath); const caps = capMap(inventory);

  // P8 startup check: emit-shape decision was made against a probed omo version.
  const installed = installedOmoVersion(); assertOmoVersion(installed); const chainSha = pinnedChainSha();

  const chains = extractChains(); const availability = loadAvailability(inventory, args.modelsPath); const tiers = loadTiers();
  // W4.2: pinned slots from the sidecar are skipped by the solver and never touched by the merge.
  const tokenHistoryEarly = readTokenHistory(args.dbPath);
  const pinned = loadPinnedSlots(); const solve = solveChains({ chains, availability, caps, tiers, skipPinned: pinned, costAversion: args.costAversion ?? 0.35, at: args.at ?? new Date() }); const allUntrusted = solve.allUntrusted;

  // P8: emit-shape decision note — printed once per run; agent fallback_models is schema-forced and
  // config migrate (omo v4.19.4, VERIFIED 2026-08-07) emits NO deprecation warning for it.
  // B2/B3 — a degraded catalogue silently flattens capability, so it is reported before anything else.
  const diag = availabilityDiagnostics();
  if (diag?.degraded) {
    console.warn(`[availability] DEGRADED: models.json ${diag.source} at ${diag.modelsPath}` +
      (diag.error ? ` (${diag.error})` : ""));
    console.warn("[availability] Capability cannot be differentiated without it — every model falls back " +
      "to a default score and assignments collapse to chain-position-only. Run `opencode models` to " +
      "rebuild the cache, or pass --models-path <file>.");
  } else if (diag) {
    console.log(`[availability] models.json loaded: ${diag.modelCount} models across ${diag.providerCount} provider(s)`);
  }
  if (diag?.emptyProviders.length) {
    console.warn(`[availability] declared provider(s) with NO catalogue entry — they contribute zero ` +
      `candidates and will never be assigned: ${diag.emptyProviders.join(", ")}. ` +
      `Check the provider id matches what \`opencode models\` reports.`);
  }
  console.log(`[pricing] ${pricingStatus(args.at ?? new Date())}`);
  console.log(`[plutus] emit-shape: agents->fallback_models (schema-forced; omo v${PROBED_OMO_VERSION} config migrate accepts, no deprecation warning emitted)`);

  // Doctor soft-check (v1: soft — warn and report; schema validation is the primary gate).
  const assigned = new Set(solve.assignments.map((a) => a.slot));
  const unresolved = chains.filter((c) => !assigned.has(c.name) && !pinned.includes(c.name)).map((c) => c.name);
  const pinnedSlots = chains.map((c) => c.name).filter((n) => pinned.includes(n));
  for (const slot of unresolved) {
    console.warn(`[doctor:soft] slot ${slot} has NO resolvable candidate — left unassigned (v1: warning only)`);
  }
  if (pinnedSlots.length) console.log(`[plutus] pinned (skipped): ${pinnedSlots.join(", ")}`);

  // ---- Consumption-limit enforcement (user requirement; promoted from v2) -------------------
  // Demand precedence: observed per-agent tokens (SPIKE-02) > declared per-slot > flat default.
  const observed = new Map<string, number>();
  for (const r of tokenHistoryEarly.rows) {
    observed.set(r.agent, (observed.get(r.agent) ?? 0) + r.inputTokens + r.outputTokens);
  }
  const profile = demandProfile(inventory);
  const { demand, source: demandSource } = buildDemand(
    solve.assignments.map((a) => a.slot), observed, profile.perSlot, profile.defaultTokens,
  );
  const budget = enforceBudget(solve.assignments, {
    windowTokens: windowTokensMap(inventory), windowDollars: windowDollarsMap(inventory), caps, demand, sigma: profile.sigma,
  });
  if (budget.enforced) {
    solve.assignments = budget.assignments;
    console.log(`[budget] enforced across ${budget.budgets.filter((b) => b.trusted).length} provider(s) with known capacity`);
    for (const d of budget.demoted) console.log(`[budget] DEMOTED ${d.slot}: ${d.from} -> ${d.to} (${d.reason})`);
    for (const s of budget.overCommitted) console.warn(`[budget] OVER-COMMITTED ${s}: no provider has room — window WILL be breached`);
  } else {
    console.warn("[budget] NOT enforced: no provider declares window_tokens. Assignments are quality-optimal only — consumption limits are NOT respected. Declare window_tokens in inventory.yaml or run `plutus discover --write`.");
  }
  const burn = forecastBurn(budget.budgets, observed, profile.observedSpanHours, windowResetsMap(inventory));
  for (const f of burn) {
    if (f.willExhaust) console.warn(`[budget] BURN ALERT ${f.provider}: at ${Math.round(f.burnPerHour).toLocaleString()} tok/h it exhausts in ${f.hoursToExhaustion?.toFixed(1)}h, before the window resets in ${f.hoursToReset?.toFixed(1)}h`);
  }

  // Emitter routing. OMO 4.19.4 reads ~/.omo/omo.jsonc: a JSONC document (comments, trailing
  // commas) whose agent/category config lives under an "[opencode]" wrapper. emitConfig writes a
  // FLAT, strict-JSON document — the legacy oh-my-opencode.json shape.
  //
  // The CLI was still calling emitConfig after omo.jsonc support landed (the web server was updated,
  // the CLI was not). Two failures resulted: merging into a real omo.jsonc threw "not valid JSON" on
  // the first `//` comment, and --no-merge silently wrote a flat document that OMO does not read.
  // Route on the target so both surfaces agree.
  const isOmoJsonc = /omo\.jsonc$/i.test(args.outputPath);
  const emit = isOmoJsonc
    ? emitOmoConfig(solve.assignments, args.outputPath, { merge: args.merge })
    : emitConfig(solve.assignments, args.outputPath, { merge: args.merge });

  // W5.1: doctor soft-check (never blocks; schema validation is the primary gate).
  const doctor = await doctorSoftCheck();

  // W5.3 (P3): append the telemetry ledger line — the whole v2 training input.
  const trustLevels = Object.fromEntries(Object.entries(inventory.providers).map(([pid, p]) => [pid, p.trust]));
  appendLedger(buildLedgerEntry(solve, caps, trustLevels, chainSha, args.mode));

  // D6 (SPIKE-02 RESOLVED): read per-agent token history read-only — the --db-path flag
  // was plumbed since W0 but never consumed; now it feeds the report's Token history section.
  const tokenHistory = tokenHistoryEarly;
  if (!tokenHistory.available) console.log(`[plutus] token history: not read (no opencode.db at ${tokenHistory.dbPath}) — consumption estimates only`);
  else console.log(`[plutus] token history: read ${tokenHistory.rows.length} agent×model rows from ${tokenHistory.dbPath} (read-only)`);

  const overCommitCount = budget.overCommitted.length;
  const reportPath = writeReport(solve, dirname(args.outputPath), { schemaId: schemaInfo().id, chainSha, omoVersion: installed, mode: args.mode, tiers, trustLevels, doctor, tokenHistory, inventoryNames: Object.keys(inventory.providers) });

  // The all-untrusted banner refers to `cap` (fraction remaining), which is a DIFFERENT signal from
  // window_tokens (absolute capacity). Budget can enforce off window_tokens even when every cap is
  // null. Suppressing the banner in that case avoids emitting two contradictory claims in one run
  // ("enforced across 2 providers" alongside "budget constraints are NOT enforced").
  if (allUntrusted && !budget.enforced) console.warn(`[plutus] ${ALL_UNTRUSTED_BANNER}`);
  else if (allUntrusted && budget.enforced) {
    console.warn("[plutus] no provider reports a live quota fraction (cap) — capacity assumed FULL. " +
      "Budget is enforced off declared window_tokens, so limits hold, but remaining-quota is optimistic. " +
      "Declare cap, or run discover, for a truer picture.");
  }
  console.log(`[plutus] wrote ${emit.configPath}`);
  if (emit.backupPath) console.log(`[plutus] backup created: ${emit.backupPath}`);
  console.log(`[plutus] report: ${reportPath}`);
  console.log(`[plutus] assigned ${solve.assignments.length}/${chains.length} slots (unresolved: ${unresolved.length})`);

  // A config that WILL breach a declared window must not report success. The config is still
  // written (it is the best available) and the report explains the breach — but the exit code
  // makes it impossible to miss in a script or CI step.
  if (overCommitCount > 0) {
    throw new PlutusError(
      `${overCommitCount} slot(s) over-committed: no provider has remaining capacity for them ` +
        `(${budget.overCommitted.join(", ")}). Config written to ${emit.configPath} and the breach is ` +
        `detailed in the report, but consumption limits CANNOT be met with the declared capacity. ` +
        `Raise window_tokens, lower demand.default_tokens, or add provider capacity.`,
      EXIT.SPIKE,
    );
  }
}
