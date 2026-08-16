// Optimize — the core operation: solve preview (pure read) + full emit (with merge toggle).
import { useState } from "react";
import { api } from "../api.ts";
import type { SolvePreview } from "../api.ts";
import { Badge, CodeBlock, DataTable, MonoChip, Panel, PanelStates, RunButton, Toggle, useAsync, useToast } from "../components/ui.tsx";

interface OptimizeResult {
  solve: { assignments: SolvePreview["assignments"]; allUntrusted: boolean; skippedPinned: string[] };
  budget?: SolvePreview["budget"];
  burn?: SolvePreview["burn"];
  pricing?: string;
  emit: { configPath: string; backupPath: string | null } | null;
  document: Record<string, unknown> | null;
  report: string;
  doctor: { ran: boolean; notes: string[] };
  tokenHistory: { available: boolean; rows: unknown[]; dbPath: string };
}

export function OptimizeView() {
  const toast = useToast();
  const [merge, setMerge] = useState(true);
  const [dbPath, setDbPath] = useState("");
  const [emitMode, setEmitMode] = useState<"preview" | "emit">("preview");
  const [busy, setBusy] = useState<"update" | "download" | null>(null);
  const [result, setResult] = useState<OptimizeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showReport, setShowReport] = useState(false);

  // Live preview — refetches on toggle/db change.
  const preview = useAsync<SolvePreview>(
    () => api.get(`/api/solve/preview${dbPath ? `?db-path=${encodeURIComponent(dbPath)}` : ""}`),
    [merge, dbPath, emitMode],
  );

  async function run(action: "update" | "download") {
    setBusy(action); setError(null);
    try {
      const res = await api.post<OptimizeResult>("/api/optimize", { merge, "db-path": dbPath || undefined, mode: "absolute-best", action });
      setResult(res);
      if (action === "update") {
        toast("success", `Updated ${res.emit?.configPath ?? "omo.jsonc"}`);
      } else {
        // Real browser download of the generated omo.jsonc document.
        const blob = new Blob([JSON.stringify(res.document, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "omo.jsonc";
        a.click();
        URL.revokeObjectURL(url);
        toast("success", "omo.jsonc downloaded");
      }
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      toast("error", msg);
    } finally {
      setBusy(null);
    }
  }

  const shown = result ?? (preview.data ? {
    solve: preview.data,
    report: preview.data.report,
    doctor: { ran: false, notes: [] },
    tokenHistory: { available: false, rows: [], dbPath: "" },
    emit: null, document: null,
    // Budget/burn/pricing live at the TOP level of the preview response, not under `solve`.
    // Omitting them here left `shown.budget` undefined, so the Consumption panel's
    // `empty={!shown?.budget}` never cleared and the spinner ran forever.
    budget: preview.data.budget, burn: preview.data.burn, pricing: preview.data.pricing,
  } : null);

  return (
    <>
      <div className="stack" style={{ gap: 4 }}>
        <span className="overline">Operate</span>
        <h1 className="display" style={{ margin: 0 }}>Optimize</h1>
        <p className="body-sm text-secondary">Solve every slot (quality = fit × capability, forbidden NOT-IN, overflow-only) and emit the schema-validated config.</p>
      </div>

      <Panel title="Run settings" overline="inputs">
        <div className="row" style={{ gap: 24, flexWrap: "wrap" }}>
          <Toggle checked={merge} onChange={setMerge} label="Deep-merge into existing config" />
          <label className="field" style={{ minWidth: 320 }}>
            <span>opencode.db path (token history)</span>
            <input className="text-input" placeholder="default: ~/.local/share/opencode/opencode.db" value={dbPath} onChange={(e) => setDbPath(e.target.value)} />
          </label>
          <RunButton variant="ghost" running={emitMode === "preview"} onClick={() => { setEmitMode("preview"); preview.reload(); }}>Preview solve</RunButton>
          <RunButton running={busy === "update"} runningLabel="Optimizing…" onClick={() => run("update")}>Optimize &amp; Update</RunButton>
          <RunButton variant="ghost" running={busy === "download"} runningLabel="Preparing…" onClick={() => run("download")}>Optimize &amp; Download</RunButton>
        </div>
        {error && <div className="error-state" style={{ marginTop: 12 }}>{error}</div>}
      </Panel>

      <Panel
        title="Assignments"
        overline="solve result"
        actions={
          shown ? (
            <div className="row">
              {shown.budget?.enforced
                ? <Badge variant="success">budget enforced</Badge>
                : <Badge variant="warning">budget NOT enforced</Badge>}
              {shown.solve.allUntrusted && !shown.budget?.enforced && <Badge variant="warning">quality-only — no verified capacity</Badge>}
              {shown.solve.skippedPinned.length > 0 && <Badge variant="accent">pinned: {shown.solve.skippedPinned.join(", ")}</Badge>}
            </div>
          ) : undefined
        }
      >
        <PanelStates loading={preview.loading} error={preview.error ?? undefined} onRetry={preview.reload} empty={!shown} emptyText="Run a preview or optimize to see assignments">
          {shown && (
            <DataTable headers={["slot", "kind", "primary model", "provider", "fit", "capability", "quality", "trusted", "binding"]}>
              {shown.solve.assignments.map((a) => (
                <tr key={a.slot} className={a.primary.trusted ? "" : ""}>
                  <td><strong>{a.slot}</strong></td>
                  <td className="text-secondary">{a.kind}</td>
                  <td><MonoChip text={a.primary.model} /></td>
                  <td className="text-secondary">{a.primary.provider}</td>
                  <td>{a.primary.fit}</td>
                  <td>{a.primary.capability}</td>
                  <td>{a.primary.quality.toFixed(3)}</td>
                  <td>{a.primary.trusted ? <Badge variant="success">trusted</Badge> : <Badge variant="warning">untrusted</Badge>}</td>
                  <td className="body-sm text-secondary">{a.rationale?.split("—")[0] ?? ""}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </PanelStates>
      </Panel>

      <Panel
        title="Consumption limits"
        overline="budget"
        actions={shown?.budget ? (
          <div className="row">
            {shown.budget.enforced
              ? <Badge variant="success">enforced across {shown.budget.budgets.filter((b) => b.trusted).length} provider(s)</Badge>
              : <Badge variant="warning">not enforced</Badge>}
            {shown.budget.overCommitted.length > 0 && <Badge variant="danger">over-committed: {shown.budget.overCommitted.length}</Badge>}
          </div>
        ) : undefined}
      >
        <PanelStates loading={preview.loading} error={preview.error ?? undefined} onRetry={preview.reload} empty={!shown?.budget} emptyText="Run a preview or optimize to see budget">
          {shown?.budget && (
            <>
              {shown.pricing && <p className="body-sm text-secondary">{shown.pricing}</p>}

              {!shown.budget.enforced && (
                <p className="body-sm">
                  No provider declares a window, so consumption limits are <strong>not</strong> applied and
                  assignments are quality-optimal only. Declare <code>window_tokens</code> (token-metered
                  plans), <code>window_dollars</code> (OpenCode Go bills in USD), or <code>metered: true</code>
                  (pay-per-token, no window) per provider in Inventory.
                </p>
              )}

              {shown.budget.enforced && (
                <DataTable headers={["provider", "capacity", "consumed", "remaining", "trust"]}>
                  {shown.budget.budgets.map((b) => (
                    <tr key={b.provider}>
                      <td><strong>{b.provider}</strong></td>
                      <td>{b.capacityTokens === null ? <Badge variant="warning">unknown</Badge>
                        : !Number.isFinite(b.capacityTokens) ? <Badge variant="accent">unbounded (metered)</Badge>
                        : Math.round(b.capacityTokens).toLocaleString()}</td>
                      <td>{Math.round(b.consumedTokens).toLocaleString()}</td>
                      <td>{b.remainingTokens === null || !Number.isFinite(b.remainingTokens) ? "—" : Math.round(b.remainingTokens).toLocaleString()}</td>
                      <td>{b.trusted ? <Badge variant="success">declared</Badge> : <Badge variant="warning">unknown</Badge>}</td>
                    </tr>
                  ))}
                </DataTable>
              )}

              {shown.budget.demoted.length > 0 && (
                <>
                  <p className="body-sm text-secondary" style={{ marginTop: 12 }}>
                    Moved off the quality-optimal pick to stay inside a window:
                  </p>
                  <DataTable headers={["slot", "from", "to", "reason"]}>
                    {shown.budget.demoted.map((d) => (
                      <tr key={d.slot}>
                        <td><strong>{d.slot}</strong></td>
                        <td><MonoChip text={d.from} /></td>
                        <td><MonoChip text={d.to} /></td>
                        <td className="body-sm text-secondary">{d.reason}</td>
                      </tr>
                    ))}
                  </DataTable>
                </>
              )}

              {shown.budget.overCommitted.length > 0 && (
                <p className="body-sm" style={{ marginTop: 12 }}>
                  <strong>Over-committed:</strong> {shown.budget.overCommitted.join(", ")} — no provider has
                  room for these. The config is still written and is the best available, but the declared
                  capacity cannot cover the demand. Raise a window, lower <code>demand.default_tokens</code>,
                  or add capacity.
                </p>
              )}

              {(shown.burn ?? []).filter((f) => f.willExhaust).map((f) => (
                <p key={f.provider} className="body-sm" style={{ marginTop: 8 }}>
                  <strong>Burn alert — {f.provider}:</strong> at {Math.round(f.burnPerHour).toLocaleString()} tok/h
                  it exhausts in {f.hoursToExhaustion?.toFixed(1)}h, before the window resets in {f.hoursToReset?.toFixed(1)}h.
                </p>
              ))}
            </>
          )}
        </PanelStates>
      </Panel>

      {shown && (
        <>
          <Panel title="Emitted omo.jsonc" overline="output" actions={<button className="run-btn ghost" onClick={() => setShowReport(!showReport)}>{showReport ? "Show assignments" : "Show report"}</button>}>
            {shown.document ? (
              <CodeBlock maxHeight={320}>{JSON.stringify(shown.document, null, 2)}</CodeBlock>
            ) : shown.emit?.configPath ? (
              <CodeBlock maxHeight={320}>{JSON.stringify({ updated: shown.emit.configPath, backup: shown.emit.backupPath }, null, 2)}</CodeBlock>
            ) : (
              <CodeBlock maxHeight={320}>{JSON.stringify({ preview: true, note: "Run Optimize & Update (writes ~/.omo/omo.jsonc) or Optimize & Download (saves the file)" }, null, 2)}</CodeBlock>
            )}
            {shown.emit?.configPath && (
              <div className="row" style={{ marginTop: 12 }}>
                <Badge variant="success">updated</Badge>
                <MonoChip text={shown.emit.configPath} />
                {shown.emit.backupPath && <span className="body-sm text-tertiary">backup: {shown.emit.backupPath}</span>}
              </div>
            )}
          </Panel>
          <Panel title={showReport ? "plutus-report.md" : "Solve preview report"} overline="audit">
            <CodeBlock maxHeight={420}>{shown.report}</CodeBlock>
          </Panel>
        </>
      )}
    </>
  );
}
