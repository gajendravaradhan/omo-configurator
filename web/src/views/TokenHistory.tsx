// Token History — per-agent × model consumption from opencode.db (read-only, SPIKE-02).
import { useState } from "react";
import { api } from "../api.ts";
import type { TokenHistory } from "../api.ts";
import { Badge, CodeBlock, DataTable, MonoChip, Panel, PanelStates, useAsync } from "../components/ui.tsx";

export function TokenHistoryView() {
  const [dbPath, setDbPath] = useState("");
  const { data, error, loading, reload } = useAsync<TokenHistory>(
    () => api.get(`/api/token-history${dbPath ? `?db-path=${encodeURIComponent(dbPath)}` : ""}`),
    [dbPath],
  );

  return (
    <>
      <div className="stack" style={{ gap: 4 }}>
        <span className="overline">Telemetry</span>
        <h1 className="display" style={{ margin: 0 }}>Token History</h1>
        <p className="body-sm text-secondary">Per-agent × model consumption, read read-only from opencode.db (SPIKE-02 RESOLVED 2026-08-07).</p>
      </div>

      <Panel title="Source" overline="opencode.db">
        <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
          <label className="field" style={{ minWidth: 320 }}>
            <span>opencode.db path</span>
            <input className="text-input" placeholder="default: ~/.local/share/opencode/opencode.db" value={dbPath} onChange={(e) => setDbPath(e.target.value)} />
          </label>
          <button className="run-btn ghost" onClick={reload}>Refresh</button>
        </div>
        {data && !data.available && (
          <div className="row" style={{ marginTop: 12 }}>
            <Badge variant="warning">not read</Badge>
            <span className="body-sm text-secondary">no opencode.db at {data.dbPath} — consumption figures are estimates only</span>
          </div>
        )}
      </Panel>

      <Panel title="Per agent × model" overline="consumption">
        <PanelStates loading={loading} error={error} onRetry={reload} empty={!data || !data.available} emptyText="Token history unavailable — no opencode.db found">
          {data && data.available && (
            <DataTable headers={["agent", "model", "calls", "input", "output", "reasoning", "cache r/w", "total", "cost"]}>
              {data.rows.map((r, i) => (
                <tr key={i}>
                  <td><strong>{r.agent}</strong></td>
                  <td><MonoChip text={r.model} /></td>
                  <td>{r.calls}</td>
                  <td>{r.inputTokens}</td>
                  <td>{r.outputTokens}</td>
                  <td>{r.reasoningTokens}</td>
                  <td>{r.cacheRead} / {r.cacheWrite}</td>
                  <td><strong>{r.totalTokens}</strong></td>
                  <td>{r.cost > 0 ? `$${r.cost.toFixed(4)}` : "$0"}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </PanelStates>
      </Panel>

      {data?.available && data.rows.length > 0 && (
        <Panel title="Consumption note" overline="audit">
          <CodeBlock>{`Read from ${data.dbPath} (read-only, PRAGMA query_only).\nAssistant messages only; user messages excluded. Session-tree attribution is v2.`}</CodeBlock>
        </Panel>
      )}
    </>
  );
}
