// Report — the auditable plutus-report.md (written next to the emitted config).
import { api } from "../api.ts";
import { Badge, CodeBlock, Panel, PanelStates, useAsync } from "../components/ui.tsx";

interface ReportDoc { path: string; content: string | null }

export function ReportView() {
  const { data, error, loading, reload } = useAsync<ReportDoc>(() => api.get("/api/report"), []);

  return (
    <>
      <div className="stack" style={{ gap: 4 }}>
        <span className="overline">Audit</span>
        <h1 className="display" style={{ margin: 0 }}>Report</h1>
        <p className="body-sm text-secondary">The full audit surface from the last optimize run — assignments, rationale, trust levels, doctor, token history.</p>
      </div>

      <Panel
        title={data?.path ?? "plutus-report.md"}
        overline="audit surface"
        actions={<button className="run-btn ghost" onClick={reload}>Refresh</button>}
      >
        <PanelStates loading={loading} error={error} onRetry={reload} empty={!data || data.content === null} emptyText="No report yet — run optimize first">
          {data?.content && (
            <div className="stack">
              <div className="row"><Badge variant="success">written</Badge><span className="body-sm text-tertiary">{data.path}</span></div>
              <CodeBlock maxHeight={560}>{data.content}</CodeBlock>
            </div>
          )}
        </PanelStates>
      </Panel>
    </>
  );
}
