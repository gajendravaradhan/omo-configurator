// Pinned — sidecar pinned.json: slots excluded from optimize (never written into the config).
import { useState } from "react";
import { api } from "../api.ts";
import { Badge, CodeBlock, Panel, PanelStates, RunButton, useAsync, useToast } from "../components/ui.tsx";

interface PinnedDoc { path: string; slots: string[] }

export function PinnedView() {
  const toast = useToast();
  const { data, error, loading, reload } = useAsync<PinnedDoc>(() => api.get("/api/pinned"), []);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      let slots: string[] = [];
      try {
        const parsed = JSON.parse(draft);
        slots = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.slots) ? parsed.slots : [];
      } catch {
        slots = draft.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
      }
      await api.post("/api/pinned", { slots });
      toast("success", `Pinned ${slots.length} slot(s)`);
      reload();
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="stack" style={{ gap: 4 }}>
        <span className="overline">Configuration</span>
        <h1 className="display" style={{ margin: 0 }}>Pinned slots</h1>
        <p className="body-sm text-secondary">Pinned slots are skipped by optimize and never touched by the merge. Uses the same sidecar as the emitter and challenger.</p>
      </div>

      <Panel title="Sidecar" overline="pinned.json">
        <PanelStates loading={loading} error={error} onRetry={reload}>
          {data && (
            <div className="stack">
              <div className="row">
                {data.slots.length === 0 ? <Badge variant="info">none pinned</Badge> : data.slots.map((s) => <Badge key={s} variant="accent">{s}</Badge>)}
              </div>
              <CodeBlock maxHeight={160}>{JSON.stringify({ path: data.path, slots: data.slots }, null, 2)}</CodeBlock>
              <textarea
                className="text-input" rows={6} style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
                placeholder={'one slot per line, e.g.\nhephaestus\noracle'}
                value={draft} onChange={(e) => setDraft(e.target.value)}
              />
              <div className="row">
                <RunButton running={saving} onClick={save}>Save pinned slots</RunButton>
              </div>
            </div>
          )}
        </PanelStates>
      </Panel>
    </>
  );
}
