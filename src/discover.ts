// W3.4 — discover: thin wrapper over `bunx @slkiser/opencode-quota show` (scoped package per bundle
// §1.5 — the unscoped name is a different, colliding package) + ~/.cache/opencode/models.json.
//
// Honesty rules (bundle §1.5 / risk register):
//   - NEVER silently degrade to zero-capacity data. If the quota tool output cannot be mapped to the
//     inventory shape, we throw WITH THE RAW OUTPUT PRESERVED in the error — the operator sees what
//     the tool actually returned, not a guessed parse.
//   - `--write` only proceeds after parseQuotaOutput + mergeQuota + parseInventory all succeed
//     (validate-before-replace), under an advisory lockfile, with a .bak.<timestamp> backup.
//   - The quota tool's output format is UNVERIFIED (risk register) — parseQuotaOutput documents the
//     best-effort accepted shape and refuses everything else loudly.
//
// Atomic write (bundle §1.9): tmp+rename, advisory lockfile, .bak.<timestamp> backup,
// validate-before-replace. Same discipline as the emitter and rollback.
import { existsSync, mkdirSync, readFileSync, copyFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { stringify } from "yaml";
import { parseInventory, type Inventory } from "./inventory.ts";
import { lockfilePath, modelsCachePath } from "./config.ts";
import { PlutusError } from "./errors.ts";
import { EXIT } from "./types.ts";

export interface QuotaSnapshot {
  providers: Record<string, { cap: number | null; window_resets?: string | null }>; raw: string;
}

interface RawQuotaDoc {
  providers?: Record<string, { status?: unknown; cap?: unknown; quota?: unknown; window_resets?: unknown }>;
}

function toCap(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  return typeof v === "number" && !Number.isNaN(v) ? v : undefined;
}

/**
 * Parse `bun x @slkiser/opencode-quota show --json` output. Ground-truth shape VERIFIED 2026-08-07
 * (risk register): `{ version, exportedAt, fromCache, cacheAgeSeconds, providers: { id: { status,
 * sources? } } }`. When a provider reports `status: "unavailable"` there is NO verified capacity →
 * cap maps to null (untrusted/overflow-only) — never a guessed positive number. When a provider
 * reports an available status, a numeric `cap`/`quota` field is required.
 * Any other output throws a PlutusError carrying the raw output — NEVER silently degrade.
 */
export function parseQuotaOutput(raw: string): QuotaSnapshot {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new PlutusError(
      `quota tool output is not JSON — cannot map to inventory capacity (never degrading to zero-capacity). ` +
        `Raw output:\n${raw}`,
      EXIT.RUNTIME,
    );
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new PlutusError(`quota tool output has an unmappable shape. Raw output:\n${raw}`, EXIT.RUNTIME);
  const providersRaw = (doc as RawQuotaDoc).providers;
  if (typeof providersRaw !== "object" || providersRaw === null || Array.isArray(providersRaw)) {
    throw new PlutusError(
      `quota tool output lacks a \`providers\` mapping — cannot map to inventory capacity. Raw output:\n${raw}`,
      EXIT.RUNTIME,
    );
  }
  const providers: QuotaSnapshot["providers"] = {};
  for (const [pid, p] of Object.entries(providersRaw)) {
    if (typeof p !== "object" || p === null || Array.isArray(p)) throw new PlutusError(`quota output for provider \`${pid}\` is not a mapping. Raw output:\n${raw}`, EXIT.RUNTIME);
    // Ground-truth: "unavailable" = no verified capacity → null (untrusted). Available statuses (or
    // absent status) must carry a numeric quota we can map — otherwise refuse loudly.
    const unavailable = p.status === "unavailable";
    const rawCap = unavailable ? null : toCap(p.cap) ?? toCap(p.quota);
    if (!unavailable && rawCap === undefined) throw new PlutusError(`quota output for provider \`${pid}\` has no numeric cap/quota. Raw output:\n${raw}`, EXIT.RUNTIME);
    providers[pid] = { cap: rawCap ?? null, window_resets: typeof p.window_resets === "string" ? p.window_resets : null };
  }
  return { providers, raw };
}

/**
 * Merge discovered quota into the inventory. Providers absent from the quota output keep their
 * declared values (their capacity is user-verified). New providers are added with the conservative
 * `user_declared` trust. Trust of existing providers is NEVER rewritten.
 */
export function mergeQuota(inv: Inventory, quota: QuotaSnapshot): Inventory {
  const providers = { ...inv.providers };
  for (const [pid, q] of Object.entries(quota.providers)) {
    const existing = providers[pid];
    providers[pid] = { provider: pid, cap: q.cap, windowResets: q.window_resets ?? existing?.windowResets ?? null, trust: existing?.trust ?? "user_declared" };
  }
  return { version: inv.version, providers };
}

/** Serialize an Inventory back to the canonical snake_case YAML (round-trips through parseInventory + schema). */
export function serializeInventory(inv: Inventory): string {
  const providers: Record<string, unknown> = {};
  for (const [pid, p] of Object.entries(inv.providers)) {
    providers[pid] = { cap: p.cap, ...(p.windowResets ? { window_resets: p.windowResets } : {}), trust: p.trust };
  }
  return stringify({ version: inv.version, providers });
}

function ts(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Atomic inventory write-back (bundle §1.9): validate-before-replace, advisory lockfile,
 * .bak.<timestamp> backup, tmp+rename. Throws PlutusError when the lock is held or the new
 * content is invalid (target untouched in both cases).
 */
export function writeInventoryAtomic(invPath: string, content: string, lockPath: string = lockfilePath()): { backupPath: string | null } {
  parseInventory(content, invPath);
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      break;
    } catch { if (attempt === 4) throw new PlutusError(`another plutus process holds the inventory lock (${lockPath})`, EXIT.RUNTIME); Bun.sleepSync(100); }
  }
  try {
    let backupPath: string | null = null;
    if (existsSync(invPath)) { backupPath = `${invPath}.bak.${ts()}`; copyFileSync(invPath, backupPath); }
    const tmp = `${invPath}.tmp.${process.pid}`;
    writeFileSync(tmp, content, "utf8"); renameSync(tmp, invPath);
    return { backupPath };
  } finally {
    rmSync(lockPath, { force: true });
  }
}

export interface DiscoverArgs {
  inventoryPath: string; write: boolean;
}

/** Spawn `bun x @slkiser/opencode-quota show --json`; returns stdout. Clear install error on failure. */
export async function fetchQuota(): Promise<string> {
  let proc;
  try {
    // `bun x` is the modern bunx form; spawn via the running bun binary so $PATH gaps can't hide it.
    // --json is required: the bare `show` is an interactive glance that exits 1 in a non-TTY.
    proc = Bun.spawn([process.execPath, "x", "@slkiser/opencode-quota", "show", "--json"], { stdout: "pipe", stderr: "pipe" });
  } catch (e: unknown) {
    throw new PlutusError(
      `cannot run \`bun x @slkiser/opencode-quota show\`: ${(e as Error).message}. ` +
        `Install it with \`bun add -d @slkiser/opencode-quota\` (scoped package — the unscoped name is a different package).`,
      EXIT.RUNTIME,
    );
  }
  const [exit, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (exit !== 0) throw new PlutusError(`\`bun x @slkiser/opencode-quota show\` exited ${exit} — refusing to continue with zero-capacity data.\nstderr: ${stderr.slice(0, 2000)}`, EXIT.RUNTIME);
  return stdout;
}

/**
 * W3.4 surface: `plutus discover` prints live quota + model availability. With `--write`, atomically
 * writes the discovered caps back to inventory.yaml (lock + backup + validate-before-replace).
 */
export async function discover(args: DiscoverArgs): Promise<void> {
  const inv = parseInventory(readFileSync(args.inventoryPath, "utf8"), args.inventoryPath);
  console.log(`[discover] reading quota via \`bun x @slkiser/opencode-quota show --json\` …`);
  const raw = await fetchQuota();
  const quota = parseQuotaOutput(raw); const merged = mergeQuota(inv, quota);

  console.log(`[discover] quota snapshot (${Object.keys(quota.providers).length} providers):`);
  for (const [pid, p] of Object.entries(quota.providers)) console.log(`  ${pid}: cap=${p.cap ?? "null"}${p.window_resets ? ` window_resets=${p.window_resets}` : ""}`);
  const modelsPath = modelsCachePath();
  const modelsExist = existsSync(modelsPath);
  const modelCount = modelsExist ? Object.keys(JSON.parse(readFileSync(modelsPath, "utf8"))).length : 0;
  console.log(`[discover] models availability: ${modelsExist ? modelsPath : "(missing — " + modelsPath + ")"} (${modelCount} providers)`);
  if (!modelsExist) console.warn("[discover] warning: models.json cache missing — availability is inventory-only");
  if (args.write) {
    const content = serializeInventory(merged);
    const { backupPath } = writeInventoryAtomic(args.inventoryPath, content);
    console.log(`[discover] wrote ${args.inventoryPath} (merged ${Object.keys(quota.providers).length} providers)`);
    if (backupPath) console.log(`[discover] backup: ${backupPath}`);
  } else console.log(`[discover] dry-run — pass --write to merge the snapshot into ${args.inventoryPath}`);
}
