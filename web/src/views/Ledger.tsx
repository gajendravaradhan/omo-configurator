// Ledger — append-only telemetry history.jsonl (P3). Read-only view.
import { api } from "../api.ts";
import { Badge, CodeBlock, DataTable, Panel, PanelStates, useAsync } from "../components/ui.tsx";

interface LedgerEntry {
  ts: string;
  mode: string;
  chain_sha: string;
  quota_snapshot_per_provider: Record<string, number | null>;
  assignments: Record<string, { model: string; provider: string; quality: number }>;
  trust_levels: Record<string, string>;
}

interface LedgerDoc { path: string; entries: LedgerEntry[] }

export function LedgerView() {
  const { data, error, loading, reload } = useAsync<LedgerDoc>(() => api.get("/api/ledger"), []);

  return (
    <>
      <div className="stack" style={{ gap: 4 }}>
        <span className="overline">Telemetry</span>
        <h1 className="display" style={{ margin: 0 }}>Ledger</h1>
        <p className="body-sm text-secondary">Append-only run history (P3) — the v2 training input. Never rewritten, never transmitted.</p>
      </div>

      <Panel
        title={data?.path ?? "history.jsonl"}
        overline="telemetry"
        actions={<button className="run-btn ghost" onClick={reload}>Refresh</button>}
      >
        <PanelStates loading={loading} error={error} onRetry={reload} empty={!data || data.entries.length === 0} emptyText="No runs recorded yet — run optimize to append the first entry">
          {data && data.entries.length > 0 && (
            <div className="stack">
              <DataTable headers={["ts", "mode", "chain sha", "assignments", "quota snapshot"]}>
                {[...data.entries].reverse().map((e, i) => (
                  <tr key={i}>
                    <td className="text-secondary">{new Date(e.ts).toLocaleString()}</td>
                    <td><Badge variant={e.mode === "absolute-best" ? "info" : "accent"}>{e.mode}</Badge></td>
                    <td className="text-secondary mono-sm">{e.chain_sha.slice(0, 10)}…</td>
                    <td>{Object.keys(e.assignments).length} slots</td>
                    <td>{Object.entries(e.quota_snapshot_per_provider).map(([p, c]) => `${p}=${c ?? "null"}`).join(", ")}</td>
                  </tr>
                ))}
              </DataTable>
              <CodeBlock maxHeight={200}>{JSON.stringify(data.entries.at(-1), null, 2)}</CodeBlock>
            </div>
          )}
        </PanelStates>
      </Panel>
    </>
  );
}
