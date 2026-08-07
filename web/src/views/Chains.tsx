// Chains — the 19-slot fallback-chain inventory (live-extracted, drift-checked).
import { api } from "../api.ts";
import type { SlotChainInfo } from "../api.ts";
import { Badge, MonoChip, Panel, PanelStates, useAsync } from "../components/ui.tsx";

export function ChainsView() {
  const { data, error, loading, reload } = useAsync<{ count: number; chains: SlotChainInfo[] }>(() => api.get("/api/chains"), []);

  return (
    <>
      <div className="stack" style={{ gap: 4 }}>
        <span className="overline">Inventory</span>
        <h1 className="display" style={{ margin: 0 }}>Chains</h1>
        <p className="body-sm text-secondary">Every slot's legal fallback chain, extracted live from the installed oh-my-openagent package (acorn AST parse).</p>
      </div>

      <Panel
        title={`Fallback chains (${data?.count ?? "…"} slots)`}
        overline="live extraction"
        actions={<button className="run-btn ghost" onClick={reload}>Refresh</button>}
      >
        <PanelStates loading={loading} error={error} onRetry={reload}>
          {data && (
            <div className="stack">
              {data.chains.map((c) => (
                <div key={`${c.kind}:${c.name}`} className="panel" style={{ padding: "var(--space-3) var(--space-4)" }}>
                  <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
                    <strong className="h2" style={{ fontSize: 14 }}>{c.name}</strong>
                    <Badge variant={c.kind === "agent" ? "accent" : "info"}>{c.kind}</Badge>
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    {c.fallbackChain.map((e, i) => (
                      <span key={i} className="mono-chip" title={e.providers.join(", ")}>
                        {i === 0 ? "★ " : ""}{e.model}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </PanelStates>
      </Panel>
    </>
  );
}
