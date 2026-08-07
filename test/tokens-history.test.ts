// D6 — read-only per-agent token history (SPIKE-02, RESOLVED 2026-08-07).
// Verifies: (a) GROUP BY agent,model aggregation over message.data JSON (rchardx/opencode-usage pattern),
// (b) read-only enforcement (write attempt fails, PRAGMA query_only), (c) missing db -> available:false (honest report).
import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { readTokenHistory } from "../src/tokens-history.ts";

function makeDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "plutus-th-"));
  const p = join(dir, "opencode.db");
  const db = new Database(p);
  db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)");
  db.run("CREATE TABLE session (id TEXT PRIMARY KEY, agent TEXT)");
  const ins = db.prepare("INSERT INTO message VALUES (?, ?, ?)");
  ins.run("m1", "s1", JSON.stringify({ role: "assistant", agent: "oracle", modelID: "gpt-5.6-sol", tokens: { input: 100, output: 50, total: 150 }, cost: 0.02 }));
  ins.run("m2", "s1", JSON.stringify({ role: "assistant", agent: "oracle", modelID: "gpt-5.6-sol", tokens: { input: 200, output: 80, total: 280 }, cost: 0.03 }));
  ins.run("m3", "s2", JSON.stringify({ role: "assistant", agent: "hephaestus", modelID: "deepseek-v4-flash", tokens: { input: 50, output: 25, total: 75 }, cost: 0.01 }));
  ins.run("m4", "s3", JSON.stringify({ role: "user", agent: "oracle", modelID: "gpt-5.6-sol", tokens: { input: 10, output: 0, total: 10 } }));
  db.close();
  return p;
}

test("D6: aggregates per (agent, model) from assistant messages only", () => {
  const res = readTokenHistory(makeDb());
  expect(res.available).toBe(true);
  expect(res.rows).toHaveLength(2); // oracle-gpt + hephaestus-deepseek; the user-message row is excluded
  const oracle = res.rows.find((r) => r.agent === "oracle")!;
  expect(oracle.model).toBe("gpt-5.6-sol");
  expect(oracle.calls).toBe(2);
  expect(oracle.inputTokens).toBe(300); // 100 + 200 — user-message tokens NOT counted
  expect(oracle.outputTokens).toBe(130);
  expect(oracle.totalTokens).toBe(430);
  expect(oracle.cost).toBeCloseTo(0.05, 5);
  const heph = res.rows.find((r) => r.agent === "hephaestus")!;
  expect(heph.model).toBe("deepseek-v4-flash");
  expect(heph.totalTokens).toBe(75);
});

test("D6: sorted by total tokens DESC", () => {
  const res = readTokenHistory(makeDb());
  const totals = res.rows.map((r) => r.totalTokens);
  expect([...totals].sort((a, b) => b - a)).toEqual(totals);
});

test("D6: missing db -> available:false (report stays honest, no throw)", () => {
  const res = readTokenHistory(join(tmpdir(), "plutus-does-not-exist", "opencode.db"));
  expect(res.available).toBe(false);
  expect(res.rows).toEqual([]);
});

test("D6: opencode.db is opened READ-ONLY — writes are blocked (query_only + readonly)", () => {
  const p = makeDb();
  const db = new Database(p, { readonly: true });
  db.exec("PRAGMA query_only = ON;");
  expect(() => db.run("INSERT INTO message VALUES ('x', 'x', '{}')")).toThrow(/readonly|read-only|query_only/i);
  db.close();
  // readTokenHistory itself must not corrupt the file: bytes unchanged after read
  const before = new Uint8Array(readFileSync(p));
  readTokenHistory(p);
  const after = new Uint8Array(readFileSync(p));
  expect(Buffer.compare(Buffer.from(before), Buffer.from(after))).toBe(0);
});
