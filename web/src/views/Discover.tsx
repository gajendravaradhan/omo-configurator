// Discover — quota tool output mapping + inventory writeback status.
import { useState } from "react";
import { api } from "../api.ts";
import { Badge, CodeBlock, Panel, RunButton, useToast } from "../components/ui.tsx";

interface DiscoverResult {
  ran: boolean;
  providers: Record<string, { cap: number | null; window_resets?: string | null }>;
  raw: string;
}

export function DiscoverView() {
  const toast = useToast();
  const [raw, setRaw] = useState("");
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!raw.trim()) { toast("error", "Paste the quota tool JSON output first"); return; }
    setBusy(true); setError(null);
    try {
      const res = await api.post<DiscoverResult>("/api/discover/run", { raw });
      setResult(res);
      toast("success", "Quota output parsed");
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      toast("error", msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="stack" style={{ gap: 4 }}>
        <span className="overline">Operate</span>
        <h1 className="display" style={{ margin: 0 }}>Discover</h1>
        <p className="body-sm text-secondary">Map live quota output onto inventory capacity. Never silently degrades — unmappable output is rejected loudly with the raw text preserved.</p>
      </div>

      <Panel title="Quota tool output" overline="input" actions={<RunButton running={busy} onClick={run}><span className="row" style={{ gap: 6 }}>Parse output</span></RunButton>}>
        <div className="stack">
          <label className="field">
            <span>Paste <code>@slkiser/opencode-quota show --json</code> output</span>
            <textarea
              className="text-input" rows={10} style={{ resize: "vertical", fontFamily: "var(--font-mono)", fontSize: 12 }}
              placeholder={'{\n  "version": "...",\n  "providers": { "openai": { "status": "available", "cap": 0.8 } }\n}'}
              value={raw} onChange={(e) => setRaw(e.target.value)}
            />
          </label>
          {error && <div className="error-state">{error}</div>}
        </div>
      </Panel>

      {result && (
        <Panel title="Mapped capacity" overline="result">
          <table className="data-table">
            <thead><tr><th>provider</th><th>cap</th><th>window resets</th></tr></thead>
            <tbody>
              {Object.entries(result.providers).map(([pid, p]) => (
                <tr key={pid}>
                  <td><strong>{pid}</strong></td>
                  <td>{p.cap === null ? <Badge variant="warning">null (untrusted)</Badge> : p.cap}</td>
                  <td className="text-secondary">{p.window_resets ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 12 }}>
            <span className="overline">Raw output preserved</span>
          </div>
          <CodeBlock maxHeight={240}>{result.raw.slice(0, 2000)}</CodeBlock>
        </Panel>
      )}
    </>
  );
}
