// Dashboard — system status at a glance. Fetches /api/status.
import { api } from "../api.ts";
import type { Status } from "../api.ts";
import { Badge, MonoChip, Panel, PanelStates, useAsync } from "../components/ui.tsx";

export function Dashboard() {
  const { data, error, loading, reload } = useAsync<Status>(() => api.get("/api/status"), []);

  return (
    <>
      <div className="stack" style={{ gap: 4 }}>
        <span className="overline">Command center</span>
        <h1 className="display" style={{ margin: 0 }}>Dashboard</h1>
      </div>

      <Panel title="System status" overline="plutus" actions={reload && <button className="run-btn ghost" onClick={reload}>Refresh</button>}>
        <PanelStates loading={loading} error={error} onRetry={reload}>
          {data && (
            <div className="grid grid-2">
              <StatusCard label="omo version" value={data.omoVersion} badge={data.p8Pass ? <Badge variant="success">P8 pass</Badge> : <Badge variant="error">P8 mismatch</Badge>} />
              <StatusCard label="Probed version" value={data.probedOmoVersion} note="emit-shape decision" />
              <StatusCard label="Chain SHA" value={<MonoChip text={data.chainSha ?? "—"} />} note={data.drift.ok ? "snapshot matches" : `drift: ${data.drift.detail}`} badge={data.drift.ok ? <Badge variant="success">clean</Badge> : <Badge variant="warning">drift</Badge>} />
              <StatusCard label="Inventory" value={data.inventoryPath} badge={data.inventoryExists ? <Badge variant="success">found</Badge> : <Badge variant="warning">missing</Badge>} />
              <StatusCard label="opencode.db" value={data.dbPath} badge={data.dbExists ? <Badge variant="success">present</Badge> : <Badge variant="info">absent — estimates only</Badge>} />
              <StatusCard label="Schema" value={data.schemaId ?? "—"} note="local schema $id" />
            </div>
          )}
        </PanelStates>
      </Panel>

      <Panel title="Quick actions" overline="operate">
        <div className="row" style={{ gap: 12 }}>
          <a className="run-btn primary" href="#/optimize">Run optimize</a>
          <a className="run-btn ghost" href="#/discover">Discover quota</a>
          <a className="run-btn ghost" href="#/tokens">Token history</a>
          <a className="run-btn ghost" href="#/report">Report</a>
        </div>
      </Panel>
    </>
  );
}

function StatusCard({ label, value, note, badge }: { label: string; value: React.ReactNode; note?: string; badge?: React.ReactNode }) {
  return (
    <div className="panel" style={{ padding: "var(--space-4) var(--space-6)" }}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="caption text-secondary">{label}</span>
        {badge}
      </div>
      <div style={{ marginTop: 8, fontSize: 13, wordBreak: "break-all" }}>{value}</div>
      {note && <div className="body-sm text-tertiary" style={{ marginTop: 4 }}>{note}</div>}
    </div>
  );
}
