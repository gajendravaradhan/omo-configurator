// Inventory — view + edit inventory.yaml (validated before save; server rejects invalid YAML).
import { useState } from "react";
import { api } from "../api.ts";
import { Badge, CodeBlock, Panel, PanelStates, RunButton, useAsync, useToast } from "../components/ui.tsx";

interface InventoryDoc {
  exists: boolean;
  path: string;
  raw: string;
  parsed: { version: number; providers: Record<string, { provider: string; cap: number | null; windowTokens?: number | null; windowDollars?: number | null; metered?: boolean; windowResets: string | null; trust: string }> } | null;
  error: string | null;
}

export function InventoryView() {
  const toast = useToast();
  const { data, error, loading, reload } = useAsync<InventoryDoc>(() => api.get("/api/inventory"), []);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function save() {
    setSaving(true); setSaveError(null);
    try {
      await api.post("/api/inventory", { raw: draft });
      toast("success", "Inventory saved (validated)");
      setEditing(false);
      reload();
    } catch (e) {
      const msg = (e as Error).message;
      setSaveError(msg);
      toast("error", msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="stack" style={{ gap: 4 }}>
        <span className="overline">Configuration</span>
        <h1 className="display" style={{ margin: 0 }}>Inventory</h1>
        <p className="body-sm text-secondary">
          <strong>cap</strong> is the live fraction of the window remaining (0–1, or null = assume full).
          <strong> Capacity</strong> is the window itself, declared in the unit the provider actually bills in:
          <code>window_tokens</code> for token-metered plans, <code>window_dollars</code> for OpenCode Go
          (which bills $12/5h, $30/week, $60/month), or <code>metered: true</code> for pay-per-token
          providers with no window at all. Declaring none of them leaves the provider
          <em> overflow-only</em> — used only when nothing else fits, and budget stays unenforced.
        </p>
      </div>

      <Panel
        title={data?.path ?? "inventory.yaml"}
        overline="providers"
        actions={
          <div className="row">
            {data?.exists ? <Badge variant="success">found</Badge> : <Badge variant="warning">missing</Badge>}
            {!editing && <button className="run-btn ghost" onClick={() => { setDraft(data?.raw ?? ""); setEditing(true); }}>Edit</button>}
            {editing && <button className="run-btn ghost" onClick={() => setEditing(false)}>Cancel</button>}
          </div>
        }
      >
        <PanelStates loading={loading} error={error} onRetry={reload} empty={!data}>
          {data && !editing && (
            <div className="stack">
              {data.parsed ? (
                <table className="data-table">
                  <thead><tr><th>provider</th><th>cap</th><th>capacity</th><th>trust</th><th>window resets</th></tr></thead>
                  <tbody>
                    {Object.entries(data.parsed.providers).map(([pid, p]) => (
                      <tr key={pid}>
                        <td><strong>{pid}</strong></td>
                        <td>{p.cap === null ? <Badge variant="warning">null</Badge> : p.cap}</td>
                        <td>
                          {p.metered ? <Badge variant="info">metered (unbounded)</Badge>
                            : p.windowDollars != null ? <Badge variant="success">${p.windowDollars} USD</Badge>
                            : p.windowTokens != null ? <Badge variant="success">{p.windowTokens.toLocaleString()} tok</Badge>
                            : <Badge variant="warning">none → overflow-only</Badge>}
                        </td>
                        <td><Badge variant={p.trust === "remote_api" ? "success" : p.trust === "local_estimation" ? "info" : "warning"}>{p.trust}</Badge></td>
                        <td className="text-secondary">{p.windowResets ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : data.error ? (
                <div className="error-state">{data.error}</div>
              ) : (
                <div className="empty-state">Empty inventory file</div>
              )}
              <CodeBlock maxHeight={260}>{data.raw}</CodeBlock>
            </div>
          )}
          {data && editing && (
            <div className="stack">
              <textarea
                className="text-input" rows={14} style={{ resize: "vertical", fontFamily: "var(--font-mono)", fontSize: 12 }}
                value={draft} onChange={(e) => setDraft(e.target.value)}
              />
              {saveError && <div className="error-state">{saveError}</div>}
              <div className="row">
                <RunButton running={saving} onClick={save}>Save (validated)</RunButton>
                <span className="body-sm text-tertiary">Server validates shape + §7 deletions before writing — invalid YAML is rejected.</span>
              </div>
            </div>
          )}
        </PanelStates>
      </Panel>
    </>
  );
}
