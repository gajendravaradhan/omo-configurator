// Rollback — list backups, restore (validated against the local schema BEFORE replacing).
import { useState } from "react";
import { api } from "../api.ts";
import { Badge, MonoChip, Panel, PanelStates, RunButton, useAsync, useToast } from "../components/ui.tsx";

interface RollbackDoc { output: string; backups: string[] }

export function RollbackView() {
  const toast = useToast();
  const { data, error, loading, reload } = useAsync<RollbackDoc>(() => api.get("/api/rollback"), []);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function restore(to: string) {
    setBusy(true);
    try {
      const res = await api.post<{ restored: string; validated: boolean }>("/api/rollback/restore", { to });
      toast("success", `Restored ${res.restored} (validated)`);
      reload();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="stack" style={{ gap: 4 }}>
        <span className="overline">Operate</span>
        <h1 className="display" style={{ margin: 0 }}>Rollback</h1>
        <p className="body-sm text-secondary">Restore a `.bak.&lt;timestamp&gt;` backup. The restored config is validated against the local schema BEFORE replacing — invalid restores are rejected with exit 2.</p>
      </div>

      <Panel title={`Backups for ${data?.output ?? "config"}`} overline="list" actions={<button className="run-btn ghost" onClick={reload}>Refresh</button>}>
        <PanelStates loading={loading} error={error} onRetry={reload} empty={!data || data.backups.length === 0} emptyText="No backups found">
          {data && data.backups.length > 0 && (
            <div className="stack">
              {[...data.backups].reverse().map((b) => {
                const name = b.split("/").pop() ?? b;
                const isSelected = selected === b;
                return (
                  <div key={b} className="panel" style={{ padding: "var(--space-3) var(--space-4)", background: isSelected ? "var(--accent-glow)" : undefined }}>
                    <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                      <MonoChip text={name} />
                      <div className="row">
                        <button className="run-btn ghost" onClick={() => setSelected(isSelected ? null : b)}>{isSelected ? "Deselect" : "Select"}</button>
                        <RunButton variant="danger" running={busy} onClick={() => restore(name)}>Restore</RunButton>
                      </div>
                    </div>
                  </div>
                );
              })}
              {data.backups.length > 0 && (
                <div className="row"><Badge variant="info">Restore latest</Badge><RunButton variant="danger" running={busy} onClick={() => restore("latest")}>Restore latest backup</RunButton></div>
              )}
            </div>
          )}
        </PanelStates>
      </Panel>
    </>
  );
}
