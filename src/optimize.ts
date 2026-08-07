// optimize — the walking-skeleton orchestrator (W0.4 milestone: chain-parse stub → argmax →
// emit-no-merge → report). W1 replaces the fixture chain source with runtime extraction from the
// installed oh-my-openagent dist (pinned SHA). W4.2 adds the slot-level deep-merge.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadFixtureChains } from "./chain.ts";
import { loadInventory, capMap, trustedSetEmpty } from "./inventory.ts";
import { loadAvailability } from "./availability.ts";
import { solveChains } from "./solver.ts";
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

/** W0 fixture chain source. W1 removes the env override and extracts from the installed package. */
function chainsSourcePath(): string {
  return process.env.OMO_PLUTUS_CHAINS_PATH ?? join(import.meta.dir, "..", "test", "fixtures", "chains.json");
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
  const allUntrusted = trustedSetEmpty(inventory);

  const rawChains = JSON.parse(readFileSync(chainsSourcePath(), "utf8")) as Parameters<typeof loadFixtureChains>[0];
  const chains = loadFixtureChains(rawChains);

  const availability = loadAvailability(inventory);
  const solve = solveChains(chains, availability, caps);

  // Doctor soft-check (v1: soft — warn and report; schema validation is the primary gate).
  const assigned = new Set(solve.assignments.map((a) => a.slot));
  const unresolved = chains.filter((c) => !assigned.has(c.name)).map((c) => c.name);
  for (const slot of unresolved) {
    console.warn(`[doctor:soft] slot ${slot} has NO resolvable candidate — left unassigned (v1: warning only)`);
  }

  const emit = emitConfig(solve.assignments, args.outputPath);
  const reportPath = writeReport(solve, dirname(args.outputPath), {
    schemaId: schemaInfo().id,
    chainSha: "(fixture-chains)",
    inventoryNames: Object.keys(inventory.providers),
  });

  if (allUntrusted) console.warn(`[plutus] ${ALL_UNTRUSTED_BANNER}`);
  console.log(`[plutus] wrote ${emit.configPath}`);
  if (emit.backupPath) console.log(`[plutus] backup created: ${emit.backupPath}`);
  console.log(`[plutus] report: ${reportPath}`);
  console.log(`[plutus] assigned ${solve.assignments.length}/${chains.length} slots (unresolved: ${unresolved.length})`);
}