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
import { emitConfig, loadPinnedSlots } from "../src/emitter.ts";
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
}
interface SolveResultBundle {
  solve: import("../src/types.ts").SolveResult;
  inventoryNames: string[];
  chainSha: string;
  installed: string;
  tiers: ReturnType<typeof loadTiers>;
  doctor: Awaited<ReturnType<typeof doctorSoftCheck>>;
  tokenHistory: ReturnType<typeof readTokenHistory>;
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
  const solve = solveChains({ chains, availability, caps, tiers, skipPinned: pinned });
  const doctor = await doctorSoftCheck();
  const tokenHistory = readTokenHistory(i.dbPath);
  return { solve, inventoryNames: Object.keys(inventory.providers), chainSha, installed, tiers, doctor, tokenHistory };
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
        const b = await runSolve({ inventoryPath, dbPath });
        const report = renderReport(b.solve, b.inventoryNames, bundleReportData(b, "absolute-best"));
        return json({ assignments: b.solve.assignments, allUntrusted: b.solve.allUntrusted, skippedPinned: b.solve.skippedPinned, report });
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
          if (mode === "adaptive") throw new PlutusError("adaptive mode is not available in v1 (A1-A3 open)", EXIT.SPIKE);
          const b = await runSolve({ inventoryPath, dbPath, merge, outputPath, mode });
          const emit = emitConfig(b.solve.assignments, outputPath, { merge });
          const trustLevels = Object.fromEntries(Object.entries(loadInventory(inventoryPath).providers).map(([pid, p]) => [pid, p.trust]));
          appendLedger(buildLedgerEntry(b.solve, capMap(loadInventory(inventoryPath)), trustLevels, b.chainSha, mode));
          const report = renderReport(b.solve, b.inventoryNames, bundleReportData(b, mode, { trustLevels }));
          return { solve: { assignments: b.solve.assignments, allUntrusted: b.solve.allUntrusted, skippedPinned: b.solve.skippedPinned }, emit, report, doctor: b.doctor, tokenHistory: b.tokenHistory };
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
console.log(`[plutus-ui] API: /api/status, /api/solve/preview, /api/optimize, /api/discover, /api/chains, /api/token-history, /api/ledger, /api/inventory, /api/pinned, /api/tiers, /api/models, /api/report, /api/config, /api/schema, /api/rollback, /api/challenge`);
