// optimize — the walking-skeleton orchestrator. W1: real chain extraction from the installed
// oh-my-openagent dist (pinned SHA) replaces the W0 fixture source; P8 startup version check wired.
// W4.2 adds the slot-level deep-merge.
import { dirname, join } from "node:path";
import { extractChains, assertOmoVersion, installedOmoVersion, pinnedChainSha, PROBED_OMO_VERSION } from "./chain.ts";
import { loadInventory, capMap } from "./inventory.ts";
import { loadAvailability } from "./availability.ts";
import { solveChains } from "./solver.ts";
import { loadTiers } from "./quality.ts";
import { emitConfig } from "./emitter.ts";
import { writeReport, ALL_UNTRUSTED_BANNER } from "./report.ts";
import { schemaInfo } from "./validate.ts";
import { PlutusError } from "./errors.ts";
import { EXIT } from "./types.ts";

export interface OptimizeArgs {
  inventoryPath: string;
  mode: "absolute-best" | "adaptive";
  outputPath: string;
  dbPath: string;
  merge: boolean;
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

  const inventory = loadInventory(args.inventoryPath);
  const caps = capMap(inventory);

  // P8 startup check: emit-shape decision was made against a probed omo version.
  const installed = installedOmoVersion();
  assertOmoVersion(installed);
  const chainSha = pinnedChainSha();

  const chains = extractChains();
  const availability = loadAvailability(inventory);
  const tiers = loadTiers();
  const solve = solveChains({ chains, availability, caps, tiers });
  const allUntrusted = solve.allUntrusted;

  // P8: emit-shape decision note — printed once per run; agent fallback_models is schema-forced and
  // config migrate (omo v4.19.4, VERIFIED 2026-08-07) emits NO deprecation warning for it.
  console.log(
    `[plutus] emit-shape: agents->fallback_models (schema-forced; omo v${PROBED_OMO_VERSION} config migrate accepts, no deprecation warning emitted)`,
  );

  // Doctor soft-check (v1: soft — warn and report; schema validation is the primary gate).
  const assigned = new Set(solve.assignments.map((a) => a.slot));
  const unresolved = chains.filter((c) => !assigned.has(c.name)).map((c) => c.name);
  for (const slot of unresolved) {
    console.warn(`[doctor:soft] slot ${slot} has NO resolvable candidate — left unassigned (v1: warning only)`);
  }

  const emit = emitConfig(solve.assignments, args.outputPath);
  const reportPath = writeReport(solve, dirname(args.outputPath), {
    schemaId: schemaInfo().id,
    chainSha,
    omoVersion: installed,
    inventoryNames: Object.keys(inventory.providers),
  });

  if (allUntrusted) console.warn(`[plutus] ${ALL_UNTRUSTED_BANNER}`);
  console.log(`[plutus] wrote ${emit.configPath}`);
  if (emit.backupPath) console.log(`[plutus] backup created: ${emit.backupPath}`);
  console.log(`[plutus] report: ${reportPath}`);
  console.log(`[plutus] assigned ${solve.assignments.length}/${chains.length} slots (unresolved: ${unresolved.length})`);
}