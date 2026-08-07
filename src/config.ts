// Config source resolution per bundle §1.11:
//   --config PATH  >  OMO_PLUTUS_CONFIG env  >  ~/.config/omo-plutus/inventory.yaml
// Sidecar pinned slots: ~/.config/omo-plutus/pinned.json (NEVER inside oh-my-opencode.json —
// the schema has additionalProperties:false at 3 levels; bundle §2 fact 1).
// Telemetry ledger: ~/.config/omo-plutus/history.jsonl (append-only, P3).
// Advisory lockfile for inventory writeback: ~/.config/omo-plutus/.lock (bundle §1.9).

import { homedir } from "node:os";
import { join } from "node:path";

// XDG_CONFIG_HOME override makes the tool testable without touching a real home dir.
function configHome(): string {
  return process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : join(homedir(), ".config");
}

export const OMO_PLUTUS_DIR = join(configHome(), "omo-plutus");
export const DEFAULT_INVENTORY_PATH = join(OMO_PLUTUS_DIR, "inventory.yaml");
export const PINNED_SIDECAR_PATH = join(OMO_PLUTUS_DIR, "pinned.json");
export const LEDGER_PATH = join(OMO_PLUTUS_DIR, "history.jsonl");
export const LOCKFILE_PATH = join(OMO_PLUTUS_DIR, ".lock");

/** Resolve the inventory path per the priority order. */
export function resolveInventoryPath(cliFlag?: string): string {
  if (cliFlag) return cliFlag;
  const env = process.env.OMO_PLUTUS_CONFIG;
  if (env) return env;
  return DEFAULT_INVENTORY_PATH;
}

/** Resolve the opencode config target. Priority: --output flag > ~/.config/opencode/opencode.json. */
export function resolveOmoConfigPath(cliFlag?: string): string {
  if (cliFlag) return cliFlag;
  // oh-my-opencode.json lives next to the user's opencode config.
  return join(homedir(), ".config", "opencode", "oh-my-opencode.json");
}

/** Home for opencode models cache (bundle §1.6). Env override for tests. */
export function modelsCachePath(): string {
  if (process.env.OMO_PLUTUS_MODELS_PATH) return process.env.OMO_PLUTUS_MODELS_PATH;
  return join(homedir(), ".cache", "opencode", "models.json");
}

/** Resolve opencode.db path for token-history reads (read-only, bundle §1.10). */
export function resolveOpencodeDbPath(cliFlag?: string): string {
  if (cliFlag) return cliFlag;
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  // opencode stores its db at <XDG_DATA_HOME>/opencode/opencode.db
  return join(xdg, "opencode", "opencode.db");
}