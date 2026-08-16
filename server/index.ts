// omo-plutus web server — Bun.serve REST API wrapping every src module.
// The UI performs EVERY Plutus operation through these endpoints; the CLI core
// (src/*) is imported directly, never duplicated. Design: server/index.ts is the
// only place that touches HTTP; all domain logic stays in src/.
//
// Error mapping: PlutusError(EXIT.VALIDATION) -> 400, EXIT.RUNTIME -> 500,
// EXIT.SPIKE -> 409. Raw errors -> 500 with message. Never leaks stack traces.
import { serve } from "bun";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadInventory, parseInventory, capMap, trustedSetEmpty } from "../src/inventory.ts";
import { loadAvailability } from "../src/availability.ts";
import { solveChains } from "../src/solver.ts";
import { loadTiers } from "../src/quality.ts";
import { extractChains, pinnedChainSha, installedOmoVersion, assertOmoVersion } from "../src/chain.ts";
import { emitOmoConfig, loadPinnedSlots } from "../src/emitter.ts";
import { enforceBudget, buildDemand, forecastBurn } from "../src/budget.ts";
import { windowTokensMap, windowDollarsMap, windowResetsMap, demandProfile } from "../src/inventory.ts";
import { pricingStatus, DEEPSEEK_SCHEDULE, cronLines, nextTransition, isPeak } from "../src/pricing.ts";
import { renderReport } from "../src/report.ts";
import { readTokenHistory } from "../src/tokens-history.ts";
import { appendLedger, buildLedgerEntry } from "../src/ledger.ts";
import { doctorSoftCheck } from "../src/verify.ts";
import { schemaInfo, validateConfig } from "../src/validate.ts";
import { parseQuotaOutput } from "../src/discover.ts";
import { listBackups } from "../src/commands/rollback.ts";
import { pinChallenger } from "../src/challenge.ts";
import {
  resolveInventoryPath,
  resolveOmoConfigPath,
  resolveOpencodeDbPath,
  modelsCachePath,
  ledgerPath as ledgerPathFn,
  pinnedSidecarPath,
} from "../src/config.ts";
import { PlutusError } from "../src/errors.ts";
import { EXIT } from "../src/types.ts";
import type { Assignment } from "../src/types.ts";

// ---- concurrency: single-flight mutate mutex (in-process) ----------------------
const busy = new Set<string>();
async function withMutex<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
  if (busy.has(key)) throw new PlutusError(`another ${key} operation is in progress`, EXIT.RUNTIME);
  busy.add(key);
  try {
    return await fn();
  } finally {
    busy.delete(key);
  }
}

// ---- shared solve pipeline (preview + optimize both use it) ---------------------
interface SolveInputs {
  inventoryPath: string;
  dbPath?: string;
  merge?: boolean;
  outputPath?: string;
  mode?: string;
  skipPinned?: string[];
  /** Valuation instant — drives DeepSeek peak/off-peak. Defaults to now. */
  at?: Date;
  /** Cost-aversion base for value-seeking slots. */
  costAversion?: number;
}
interface SolveResultBundle {
  solve: import("../src/types.ts").SolveResult;
  inventoryNames: string[];
  chainSha: string;
  installed: string;
  tiers: ReturnType<typeof loadTiers>;
  doctor: Awaited<ReturnType<typeof doctorSoftCheck>>;
  tokenHistory: ReturnType<typeof readTokenHistory>;
  budget: ReturnType<typeof enforceBudget>;
  burn: ReturnType<typeof forecastBurn>;
  pricing: string;
  demandSource: Record<string, string>;
}
async function runSolve(i: SolveInputs): Promise<SolveResultBundle> {
  const inventory = loadInventory(i.inventoryPath);
  const caps = capMap(inventory);
  const installed = installedOmoVersion();
  assertOmoVersion(installed); // P8 — emit-shape decision vs installed omo
  const chainSha = pinnedChainSha();
  const chains = extractChains();
  const availability = loadAvailability(inventory);
  const tiers = loadTiers();
  const pinned = i.skipPinned ?? loadPinnedSlots();
  const at = i.at ?? new Date();
  const solve = solveChains({
    chains, availability, caps, tiers, skipPinned: pinned,
    costAversion: i.costAversion ?? 0.35, at,
  });
  const doctor = await doctorSoftCheck();
  const tokenHistory = readTokenHistory(i.dbPath);

  // CONSUMPTION LIMITS — this ran only in the CLI until now, so every config produced through the
  // web UI was emitted with NO capacity constraint. The UI is the primary surface for this tool,
  // so budget enforcement has to live in the shared solve path, not in one caller.
  const observed = new Map<string, number>();
  for (const r of tokenHistory.rows) {
    observed.set(r.agent, (observed.get(r.agent) ?? 0) + r.inputTokens + r.outputTokens);
  }
  const profile = demandProfile(inventory);
  const { demand, source: demandSource } = buildDemand(
    solve.assignments.map((a) => a.slot), observed, profile.perSlot, profile.defaultTokens,
  );
  const budget = enforceBudget(solve.assignments, {
    windowTokens: windowTokensMap(inventory), windowDollars: windowDollarsMap(inventory),
    caps, demand, sigma: profile.sigma,
  });
  if (budget.enforced) solve.assignments = budget.assignments;
  const burn = forecastBurn(budget.budgets, observed, profile.observedSpanHours, windowResetsMap(inventory));
  const pricing = pricingStatus(at);

  return {
    solve, inventoryNames: Object.keys(inventory.providers), chainSha, installed, tiers, doctor,
    tokenHistory, budget, burn, pricing,
    demandSource: Object.fromEntries(demandSource),
  };
}
function bundleReportData(b: SolveResultBundle, mode: string, opts: { schemaId?: string; trustLevels?: Record<string, string> } = {}) {
  return {
    schemaId: opts.schemaId ?? schemaInfo().id,
    chainSha: b.chainSha,
    omoVersion: b.installed,
    mode,
    tiers: b.tiers,
    trustLevels: opts.trustLevels,
    doctor: b.doctor,
    tokenHistory: b.tokenHistory,
  };
}

// ---- helpers ---------------------------------------------------------------------
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json" } });
}
function fail(e: unknown): Response {
  if (e instanceof PlutusError) {
    const status = e.exitCode === EXIT.VALIDATION ? 400 : e.exitCode === EXIT.SPIKE ? 409 : 500;
    return json({ error: e.message, exitCode: e.exitCode }, status);
  }
  return json({ error: (e as Error).message ?? String(e) }, 500);
}
async function readBody(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new PlutusError("request body must be JSON", EXIT.VALIDATION);
  }
}
function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

// ---- static file serving for the built web app ----------------------------------
const WEB_DIR = join(import.meta.dir, "..", "web", "dist");
function staticResponse(pathname: string): Response | null {
  if (!existsSync(WEB_DIR)) return null;
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const file = join(WEB_DIR, rel);
  if (!existsSync(file) || !file.startsWith(WEB_DIR)) return null;
  const ext = file.split(".").pop() ?? "";
  const types: Record<string, string> = {
    html: "text/html", js: "text/javascript", css: "text/css", json: "application/json",
    svg: "image/svg+xml", png: "image/png", woff2: "font/woff2", map: "application/json",
  };
  return new Response(readFileSync(file), { headers: { "content-type": types[ext] ?? "application/octet-stream" } });
}

// ---- routes ----------------------------------------------------------------------
const server = serve({
  port: Number(process.env.PLUTUS_UI_PORT ?? 4040),
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const method = req.method;

    try {
      // ---- reads ---------------------------------------------------------------
      if (method === "GET" && p === "/api/status") {
        const inventoryPath = str(url.searchParams.get("config"), resolveInventoryPath());
        const installed = installedOmoVersion();
        let drift: { ok: boolean; detail: string } = { ok: true, detail: "snapshot matches" };
        try { extractChains(); } catch (e) { drift = { ok: false, detail: (e as Error).message }; }
        return json({
          ok: true,
          omoVersion: installed,
          probedOmoVersion: "4.19.4",
          p8Pass: (() => { try { assertOmoVersion(installed); return true; } catch { return false; } })(),
          chainSha: (() => { try { return pinnedChainSha(); } catch { return null; } })(),
          drift,
          inventoryPath,
          inventoryExists: existsSync(inventoryPath),
          dbPath: resolveOpencodeDbPath(),
          dbExists: existsSync(resolveOpencodeDbPath()),
          ledgerPath: ledgerPathFn(),
          pinnedPath: pinnedSidecarPath(),
          schemaId: (() => { try { return schemaInfo().id; } catch { return null; } })(),
        });
      }

      if (method === "GET" && p === "/api/solve/preview") {
        const inventoryPath = str(url.searchParams.get("config"), resolveInventoryPath());
        const dbPath = str(url.searchParams.get("db-path"), resolveOpencodeDbPath());
        // `at` lets the UI simulate DeepSeek peak vs off-peak without waiting for the clock.
        const atRaw = url.searchParams.get("at");
        const at = atRaw ? new Date(atRaw) : undefined;
        if (atRaw && Number.isNaN(at!.getTime())) throw new PlutusError(`invalid \`at\` timestamp: ${atRaw}`, EXIT.VALIDATION);
        const caRaw = url.searchParams.get("cost-aversion");
        const b = await runSolve({ inventoryPath, dbPath, at, costAversion: caRaw ? Number(caRaw) : undefined });
        const report = renderReport(b.solve, b.inventoryNames, bundleReportData(b, "absolute-best"));
        return json({
          assignments: b.solve.assignments, allUntrusted: b.solve.allUntrusted,
          skippedPinned: b.solve.skippedPinned, report,
          budget: b.budget, burn: b.burn, pricing: b.pricing, demandSource: b.demandSource,
        });
      }

      if (method === "GET" && p === "/api/chains") {
        const chains = extractChains();
        return json({ count: chains.length, chains: chains.map((c) => ({ kind: c.kind, name: c.name, fallbackChain: c.fallbackChain.map((e) => ({ model: e.model, providers: e.providers, position: e.position })) })) });
      }

      if (method === "GET" && p === "/api/token-history") {
        const dbPath = str(url.searchParams.get("db-path"), resolveOpencodeDbPath());
        return json(readTokenHistory(dbPath));
      }

      if (method === "GET" && p === "/api/ledger") {
        const path = ledgerPathFn();
        const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
        return json({ path, entries: lines });
      }

      if (method === "GET" && p === "/api/inventory") {
        const path = str(url.searchParams.get("config"), resolveInventoryPath());
        if (!existsSync(path)) return json({ exists: false, path, raw: "", parsed: null });
        const raw = readFileSync(path, "utf8");
        let parsed = null, error = null;
        try { parsed = loadInventory(path); } catch (e) { error = (e as Error).message; }
        return json({ exists: true, path, raw, parsed, error });
      }

      if (method === "GET" && p === "/api/pinned") {
        const path = pinnedSidecarPath();
        return json({ path, slots: loadPinnedSlots() });
      }

      if (method === "GET" && p === "/api/tiers") {
        const tiers = loadTiers();
        return json(tiers);
      }

      if (method === "GET" && p === "/api/models") {
        const path = modelsCachePath();
        return json({ path, exists: existsSync(path) });
      }

      if (method === "GET" && p === "/api/report") {
        const out = resolveOmoConfigPath(str(url.searchParams.get("output")));
        const reportPath = join(join(out, ".."), "plutus-report.md");
        return json({ path: reportPath, content: existsSync(reportPath) ? readFileSync(reportPath, "utf8") : null });
      }

      if (method === "GET" && p === "/api/config") {
        const out = resolveOmoConfigPath(str(url.searchParams.get("output")));
        return json({ path: out, content: existsSync(out) ? readFileSync(out, "utf8") : null });
      }

      // Pricing schedule — the UI needs to show peak/off-peak state and offer the cron lines.
      if (method === "GET" && p === "/api/pricing") {
        const now = new Date();
        const inventoryPath = str(url.searchParams.get("config"), resolveInventoryPath());
        const cmd = `cd ${process.cwd()} && bun run src/cli/index.ts optimize --config ${inventoryPath} >> /tmp/plutus-cron.log 2>&1`;
        return json({
          status: pricingStatus(now),
          peakNow: isPeak(DEEPSEEK_SCHEDULE, now),
          effectiveFrom: DEEPSEEK_SCHEDULE.effectiveFrom,
          windows: DEEPSEEK_SCHEDULE.windows,
          nextTransition: nextTransition(DEEPSEEK_SCHEDULE, now).toISOString(),
          sourceUrl: DEEPSEEK_SCHEDULE.sourceUrl,
          cron: cronLines(DEEPSEEK_SCHEDULE, cmd),
        });
      }

      if (method === "GET" && p === "/api/schema") {
        return json(schemaInfo());
      }

      if (method === "GET" && p === "/api/rollback") {
        const output = str(url.searchParams.get("output"), resolveOmoConfigPath());
        return json({ output, backups: listBackups(output) });
      }

      if (method === "GET" && p === "/api/discover") {
        // Quota snapshot parse — raw output preserved (never silently degraded).
        // The heavy `bunx` fetch stays in the CLI's discover; here we report the tool's shape contract.
        return json({ note: "run POST /api/discover/run to execute the live quota fetch" });
      }

      // ---- mutations -----------------------------------------------------------
      if (method === "POST" && p === "/api/optimize") {
        return json(await withMutex("optimize", async () => {
          const body = await readBody(req);
          const inventoryPath = str(body.config, resolveInventoryPath());
          const outputPath = str(body.output, resolveOmoConfigPath());
          const dbPath = str(body["db-path"], resolveOpencodeDbPath());
          const merge = body.merge !== false;
          const mode = str(body.mode, "absolute-best");
          const action = str(body.action, "update"); // "update" | "download"
          if (mode === "adaptive") throw new PlutusError("adaptive mode is not available in v1 (A1-A3 open)", EXIT.SPIKE);
          const b = await runSolve({ inventoryPath, dbPath, merge, outputPath, mode });

          // Build the omo.jsonc document (wrapper + validated inner [opencode]) for BOTH actions;
          // "download" returns it without writing, "update" emits it atomically to the config path.
          const inventory = loadInventory(inventoryPath);
          const trustLevels = Object.fromEntries(Object.entries(inventory.providers).map(([pid, p]) => [pid, p.trust]));
          let emit: { configPath: string; backupPath: string | null } | null = null;
          let document: Record<string, unknown> | null = null;
          if (action === "download") {
            const { buildOmoConfig } = await import("../src/emitter.ts");
            document = buildOmoConfig(b.solve.assignments);
          } else {
            emit = emitOmoConfig(b.solve.assignments, outputPath, { merge });
            appendLedger(buildLedgerEntry(b.solve, capMap(inventory), trustLevels, b.chainSha, mode));
          }
          const report = renderReport(b.solve, b.inventoryNames, bundleReportData(b, mode, { trustLevels }));
          return {
            solve: { assignments: b.solve.assignments, allUntrusted: b.solve.allUntrusted, skippedPinned: b.solve.skippedPinned },
            emit, document, report, doctor: b.doctor, tokenHistory: b.tokenHistory,
            // Budget + pricing surfaced so the UI can show WHY a slot was demoted, and warn when
            // consumption limits are not being enforced at all.
            budget: b.budget, burn: b.burn, pricing: b.pricing, demandSource: b.demandSource,
          };
        }));
      }

      if (method === "POST" && p === "/api/discover/run") {
        return json(await withMutex("discover", async () => {
          const body = await readBody(req);
          const raw = str(body.raw);
          if (!raw) return json({ ran: false, error: "raw quota output required (run `bunx @slkiser/opencode-quota show --json` first)" }, 400);
          const snapshot = parseQuotaOutput(raw); // throws with raw output preserved on unmappable shape
          return { ran: true, ...snapshot };
        }));
      }

      if (method === "POST" && p === "/api/rollback/restore") {
        return json(await withMutex("rollback", async () => {
          const body = await readBody(req);
          const output = str(body.output, resolveOmoConfigPath());
          const to = str(body.to, "latest");
          const backups = listBackups(output);
          const target = to === "latest" ? backups.at(-1) : backups.find((b) => b.includes(`.bak.${to}`));
          if (!target) throw new PlutusError(`no backup matches "${to}"`, EXIT.RUNTIME);
          const restored = JSON.parse(readFileSync(target, "utf8")) as Record<string, unknown>;
          const v = validateConfig(restored);
          if (!v.valid) throw new PlutusError(`restore rejected: invalid config (${v.errors?.map((e) => `${e.instancePath} ${e.message}`).join("; ")})`, EXIT.VALIDATION);
          writeFileSync(output, JSON.stringify(restored, null, 2) + "\n", "utf8");
          return { restored: target, validated: true };
        }));
      }

      if (method === "POST" && p === "/api/inventory") {
        return json(await withMutex("inventory", async () => {
          const body = await readBody(req);
          const path = str(body.path, resolveInventoryPath());
          const raw = str(body.raw);
          const parsed = parseInventory(raw, path); // throws 400 on invalid — never save garbage
          writeFileSync(path, raw, "utf8");
          return { saved: path, providers: Object.keys(parsed.providers) };
        }));
      }

      if (method === "POST" && p === "/api/pinned") {
        return json(await withMutex("pinned", async () => {
          const body = await readBody(req);
          const slots = Array.isArray(body.slots) ? body.slots.filter((s): s is string => typeof s === "string") : [];
          const path = pinnedSidecarPath();
          writeFileSync(path, JSON.stringify({ version: 1, slots }, null, 2) + "\n", "utf8");
          return { saved: path, slots };
        }));
      }

      if (method === "POST" && p === "/api/challenge/pin") {
        return json(await withMutex("challenge", async () => {
          const body = await readBody(req);
          const slot = str(body.slot);
          const model = str(body.model);
          if (!slot || !model) throw new PlutusError("slot and model required", EXIT.VALIDATION);
          const slots = pinChallenger(slot, model);
          return { pinned: slots };
        }));
      }

      // ---- static web app -------------------------------------------------------
      if (method === "GET") {
        const file = staticResponse(p);
        if (file) return file;
      }

      return json({ error: `no route: ${method} ${p}` }, 404);
    } catch (e) {
      return fail(e);
    }
  },
});

console.log(`[plutus-ui] serving on http://localhost:${server.port}`);
console.log(`[plutus-ui] API: /api/status, /api/solve/preview, /api/optimize, /api/discover, /api/chains, /api/token-history, /api/ledger, /api/inventory, /api/pinned, /api/tiers, /api/models, /api/report, /api/config, /api/schema, /api/rollback, /api/challenge, /api/pricing`);
