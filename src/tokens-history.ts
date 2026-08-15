// D6 fix — read-only per-agent token history from opencode.db (SPIKE-02, RESOLVED 2026-08-07).
// Battle-tested pattern ported from verified prior art:
//   - rchardx/opencode-usage (SHA 3d5ee0aa): sqlite mode=ro URI + GROUP BY agent, model over message.data JSON
//   - slkiser/opencode-quota (SHA 6e7de19f): {readonly:true} + PRAGMA query_only = ON; busy_timeout for WAL
// Anti-pattern avoided: oh-my-openagent's ultrawork-db-model-override WRITES to opencode.db — never do that.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolveOpencodeDbPath } from "./config.ts";

/** One (agent, model) row of consumption, aggregated from assistant messages. */
export interface AgentModelUsage {
  agent: string; model: string; calls: number; inputTokens: number; outputTokens: number;
  reasoningTokens: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number;
}

/** Result of a token-history read. `available=false` when the db is missing/unreadable. */
export interface TokenHistoryResult {
  available: boolean; dbPath: string;
  /** Per (agent, model) — the SPIKE-02 attribution surface. Empty when !available. */
  rows: AgentModelUsage[];
}

/**
 * Read per-agent token history from opencode.db READ-ONLY.
 * Returns { available: false } (never throws) when the db is missing — the report
 * must stay honest about estimate-only consumption when no canonical db exists
 * (e.g. NAS thin-terminal case documented in report.ts).
 */
export function readTokenHistory(dbPath?: string): TokenHistoryResult {
  const path = dbPath ?? resolveOpencodeDbPath();
  if (!existsSync(path)) return { available: false, dbPath: path, rows: [] };

  let db: Database;
  try {
    db = new Database(path, { readonly: true });
     db.exec("PRAGMA query_only = ON;"); db.exec("PRAGMA busy_timeout = 5000;");
  } catch {
    return { available: false, dbPath: path, rows: [] };
  }

  try {
     const rows = db.query(
        `SELECT json_extract(data, '$.agent') AS agent, json_extract(data, '$.modelID') AS model, COUNT(*) AS calls,
         COALESCE(SUM(json_extract(data, '$.tokens.input')), 0) AS input_tokens, COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) AS output_tokens,
         COALESCE(SUM(json_extract(data, '$.tokens.reasoning')), 0) AS reasoning_tokens, COALESCE(SUM(json_extract(data, '$.tokens.cache.read')), 0) AS cache_read,
         COALESCE(SUM(json_extract(data, '$.tokens.cache.write')), 0) AS cache_write, COALESCE(SUM(json_extract(data, '$.tokens.total')), 0) AS total_tokens,
         COALESCE(SUM(json_extract(data, '$.cost')), 0) AS cost
         FROM message WHERE json_extract(data, '$.role') = 'assistant' AND json_extract(data, '$.tokens.total') IS NOT NULL
         GROUP BY agent, model ORDER BY total_tokens DESC`,
       ).all() as Array<{ agent: string | null; model: string | null; calls: number; input_tokens: number;
       output_tokens: number; reasoning_tokens: number; cache_read: number; cache_write: number;
       total_tokens: number; cost: number }>;

     return { available: true, dbPath: path, rows: rows.map((r) => ({
        agent: r.agent ?? "(unknown)",
        model: r.model ?? "(unknown)",
        calls: r.calls,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        reasoningTokens: r.reasoning_tokens,
        cacheRead: r.cache_read,
        cacheWrite: r.cache_write,
        totalTokens: r.total_tokens,
        cost: r.cost,
       })) };
  } catch {
    return { available: false, dbPath: path, rows: [] };
  } finally {
    db.close();
  }
}
