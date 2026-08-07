#!/usr/bin/env bun
// omo-plutus CLI entrypoint (citty). Command tree per bundle §1.11.
// Exit codes: 0 ok | 1 runtime error | 2 validation failure | 3 spike-unresolved / version-mismatch.
//
// NOTE: we dispatch through citty's runCommand directly (not runMain) so that non-zero
// exit codes propagate as PlutusError instead of process.exit() — this keeps the CLI
// testable in-process (W0.3 RED test) while the bin entry still exits with the code.
import { createMain, defineCommand, renderUsage, runCommand } from "citty";
import { EXIT, type ExitCode } from "../types.ts";
import { resolveInventoryPath, resolveOmoConfigPath, resolveOpencodeDbPath } from "../config.ts";
import { optimize } from "../optimize.ts";
import { discover } from "../commands/discover.ts";
import { checkChains } from "../commands/check-chains.ts";
import { rollback } from "../commands/rollback.ts";
import { challenge } from "../commands/challenge.ts";

export const optimizeCommand = defineCommand({
  meta: { name: "optimize", description: "Solve per-slot assignment and emit oh-my-opencode.json + plutus-report.md" },
  args: {
    config: { type: "string", description: "Path to inventory.yaml", alias: "c" },
    mode: { type: "string", default: "absolute-best", description: "Solve mode (v1: absolute-best; adaptive is a refusing stub)" },
    output: { type: "string", description: "oh-my-opencode.json target path (default ~/.config/opencode/oh-my-opencode.json)" },
    "db-path": { type: "string", description: "Override opencode.db path (read-only)" },
    "no-merge": { type: "boolean", default: false, description: "Do not deep-merge into existing config (emit fresh)" },
  },
  run: async (ctx) => {
    return await optimize({
      inventoryPath: resolveInventoryPath(ctx.args.config),
      mode: ctx.args.mode as "absolute-best" | "adaptive",
      outputPath: resolveOmoConfigPath(ctx.args.output),
      dbPath: resolveOpencodeDbPath(ctx.args["db-path"]),
      merge: !ctx.args["no-merge"],
    });
  },
});

const discoverCommand = defineCommand({
  meta: { name: "discover", description: "Print live quota + model availability (thin wrapper around @slkiser/opencode-quota + models.json)" },
  args: {
    write: { type: "boolean", default: false, description: "Atomically write discovered values back to inventory.yaml (with backup+lock)" },
    config: { type: "string", alias: "c" },
  },
  run: async (ctx) => discover({ inventoryPath: resolveInventoryPath(ctx.args.config), write: ctx.args.write }),
});

const checkChainsCommand = defineCommand({
  meta: { name: "check-chains", description: "Diff parsed chains vs vendor snapshot; exit 3 on unresolved drift" },
  run: async () => checkChains(),
});

const rollbackCommand = defineCommand({
  meta: { name: "rollback", description: "List backups and restore a validated .bak.<ts> oh-my-opencode.json" },
  args: {
    list: { type: "boolean", default: false, description: "Just list available backups" },
    to: { type: "string", description: "Timestamp of the backup to restore (or 'latest')" },
    output: { type: "string", description: "oh-my-opencode.json target path" },
  },
  run: async (ctx) =>
    rollback({
      list: ctx.args.list,
      to: ctx.args.to,
      outputPath: resolveOmoConfigPath(ctx.args.output),
    }),
});

const challengeCommand = defineCommand({
  meta: { name: "challenge", description: "Pin a challenger model + compare session outcomes (W6.1 stub)" },
  args: {
    slot: { type: "string", required: true },
    model: { type: "string", required: true },
    sessions: { type: "string", default: "3" },
  },
  run: async (ctx) => challenge({ slot: ctx.args.slot, model: ctx.args.model, sessions: Number(ctx.args.sessions) }),
});

/** Command def tree (plain object passed to runCommand — createMain wrapper would hide subCommands). */
const mainDef = {
  meta: { name: "plutus", version: "0.1.0" },
  subCommands: {
    optimize: optimizeCommand,
    discover: discoverCommand,
    "check-chains": checkChainsCommand,
    rollback: rollbackCommand,
    challenge: challengeCommand,
  },
};

void createMain(mainDef as any); // createMain kept for its validation side; we dispatch via runCommand.

/** Print usage for a command def (helps `plutus --help` / `plutus optimize --help`). */
async function printUsage(argv: string[]): Promise<void> {
  const subName = argv.find((a) => !a.startsWith("-"));
  const sub = subName ? (mainDef.subCommands as Record<string, unknown>)[subName] : undefined;
  const target = sub ?? mainDef;
  const usage = await renderUsage(target as any);
  console.log(usage + "\n");
}

// Exported for programmatic test invocation; returns the exit code the process should use.
export async function runCli(argv: string[]): Promise<ExitCode> {
  if (argv.includes("--help") || argv.includes("-h")) {
    await printUsage(argv);
    return EXIT.OK;
  }
  try {
    await runCommand(mainDef as any, { rawArgs: argv });
    return EXIT.OK;
  } catch (e: unknown) {
    const err = e as Error & { exitCode?: number };
    const code = (err?.exitCode ?? EXIT.RUNTIME) as ExitCode;
    if (err?.message) console.error(err.message);
    return code;
  }
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2));
  if (code !== EXIT.OK) process.exit(code);
}