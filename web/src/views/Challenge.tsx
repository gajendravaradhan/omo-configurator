// Challenge — pin a challenger model into the sidecar (v1 stub: pin + comparator scaffold).
import { useState } from "react";
import { api } from "../api.ts";
import { Badge, Panel, RunButton, useToast } from "../components/ui.tsx";

const SLOT_PRESETS = ["oracle", "hephaestus", "prometheus", "metis", "sisyphus"];

export function ChallengeView() {
  const toast = useToast();
  const [slot, setSlot] = useState("oracle");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);

  async function pin() {
    if (!model.trim()) { toast("error", "Enter a model id to pin"); return; }
    setBusy(true);
    try {
      const res = await api.post<{ pinned: string[] }>("/api/challenge/pin", { slot, model });
      toast("success", `Pinned ${slot} → ${model} (${res.pinned.length} pinned total)`);
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
        <h1 className="display" style={{ margin: 0 }}>Challenge</h1>
        <p className="body-sm text-secondary">v1 stub: pin a challenger model for a slot via the shared sidecar. While pinned, optimize skips the slot — run your own sessions against the challenger. Comparator metrics (tokens-to-completion, tool calls, retries) are v2.</p>
      </div>

      <Panel title="Pin challenger" overline="v1 stub">
        <div className="stack">
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            <label className="field">
              <span>Slot</span>
              <select className="select-input" value={slot} onChange={(e) => setSlot(e.target.value)}>
                {SLOT_PRESETS.map((s) => <option key={s} value={s}>{s}</option>)}
                <option value="custom">custom…</option>
              </select>
            </label>
            <label className="field" style={{ minWidth: 280 }}>
              <span>Model id</span>
              <input className="text-input" placeholder="e.g. gpt-5.6-sol" value={model} onChange={(e) => setModel(e.target.value)} />
            </label>
            <RunButton running={busy} onClick={pin}>Pin challenger</RunButton>
          </div>
          <div className="row">
            <Badge variant="info">honest scope</Badge>
            <span className="body-sm text-secondary">Session-level outcome metrics require the v2 session harness — this stub never fabricates numbers.</span>
          </div>
        </div>
      </Panel>
    </>
  );
}
