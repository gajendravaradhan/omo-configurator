// DESIGN.md §5 primitives — every component, all states. Tokens from design.css (DESIGN.md contract).
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode, ButtonHTMLAttributes, TableHTMLAttributes, ThHTMLAttributes } from "react";

// ---- icons: inline SVG set (DESIGN.md: no emojis, SVG only) --------------------
function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}
export const Icons = {
  dashboard: <Icon d="M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z" />,
  optimize: <Icon d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />,
  discover: <Icon d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />,
  chains: <Icon d="M4 6h16M4 12h10M4 18h16M7 4v4m6 6v4" />,
  tokens: <Icon d="M17 3v5m0-5 3 3m-3-3-3 3M7 21v-5m0 5-3-3m3 3 3-3M12 3v3m0 12v3m-6-9H3m18 0h-3" />,
  inventory: <Icon d="M4 7h16M4 12h16M4 17h16M7 5v4m10 8v4M9 10h6" />,
  pinned: <Icon d="m12 2 3 6 6 .9-4.4 4.3 1 6.1-5.6-3-5.6 3 1-6.1L3 8.9 9 8l3-6Z" />,
  rollback: <Icon d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />,
  challenge: <Icon d="M6 3h12v4l-3 5v7h-6v-7L6 7V3Zm3 4h6" />,
  ledger: <Icon d="M4 4h16v16H4V4Zm4 4h8m-8 4h8m-8 4h4" />,
  report: <Icon d="M6 2h9l4 4v16H6V2Zm9 0v4h4M9 12h6m-6 4h6" />,
  play: <Icon d="M8 5v14l11-7L8 5Z" />,
  refresh: <Icon d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6" />,
  check: <Icon d="m4 12 5 5L20 6" />,
  warn: <Icon d="M12 3 2 20h20L12 3Zm0 7v5m0 3v.01" />,
  x: <Icon d="M18 6 6 18M6 6l12 12" />,
  copy: <Icon d="M8 8h12v12H8V8ZM4 16V4h12" />,
  menu: <Icon d="M4 6h16M4 12h16M4 18h16" />,
};

// ---- Panel (DESIGN.md §5) -------------------------------------------------------
export function Panel({
  title, overline, actions, children, className = "",
}: { title?: ReactNode; overline?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <header className="panel-header">
          <div className="stack" style={{ gap: 2 }}>
            {overline && <span className="overline">{overline}</span>}
            {title && <h2 className="h2" style={{ margin: 0 }}>{title}</h2>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function PanelStates({ loading, error, empty, emptyText, onRetry, children }: {
  loading: boolean; error?: string | null; empty?: boolean; emptyText?: string; onRetry?: () => void; children: ReactNode;
}) {
  if (loading) {
    return (
      <div className="stack">
        <div className="skeleton" style={{ height: 14, width: "60%" }} />
        <div className="skeleton" style={{ height: 14 }} />
        <div className="skeleton" style={{ height: 14, width: "80%" }} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="stack">
        <div className="error-state">{error}</div>
        {onRetry && <button className="run-btn ghost retry-btn" onClick={onRetry}>{Icons.refresh} Retry</button>}
      </div>
    );
  }
  if (empty) return <div className="empty-state">{emptyText ?? "No data"}</div>;
  return <>{children}</>;
}

// ---- DataTable (DESIGN.md §5) -----------------------------------------------------
export function DataTable({ headers, children, ...rest }: { headers: ReactNode[]; children: ReactNode } & TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="table-wrap">
      <table className="data-table" {...rest}>
        <thead><tr>{headers.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// ---- RunButton (DESIGN.md §5) -------------------------------------------------------
export function RunButton({ variant = "primary", running, runningLabel, children, ...rest }: {
  variant?: "primary" | "ghost" | "danger"; running?: boolean; runningLabel?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`run-btn ${variant}`} disabled={running || rest.disabled} {...rest}>
      {running ? (
        <>
          <svg className="spinner" width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
          </svg>
          {runningLabel ?? "Running…"}
        </>
      ) : (
        children
      )}
    </button>
  );
}

// ---- Badge (DESIGN.md §5) ------------------------------------------------------------
export function Badge({ variant, children }: { variant: "success" | "warning" | "error" | "info" | "accent"; children: ReactNode }) {
  return <span className={`badge ${variant}`}>{children}</span>;
}

// ---- StatusDot (DESIGN.md §5) -----------------------------------------------------------
export function StatusDot({ variant, running }: { variant: "success" | "warning" | "error" | "info"; running?: boolean }) {
  return <span className={`status-dot ${variant} ${running ? "running" : ""}`} aria-hidden="true" />;
}

// ---- CodeBlock (DESIGN.md §5) --------------------------------------------------------------
export function CodeBlock({ children, maxHeight }: { children: string; maxHeight?: number }) {
  return <pre className="code-block" style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}>{children}</pre>;
}

// ---- Toggle (DESIGN.md §5) -------------------------------------------------------------------
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="row" style={{ cursor: "pointer", gap: 8 }}>
      <span className="toggle">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
        <span className="track" />
        <span className="knob" />
      </span>
      <span className="body-sm text-secondary">{label}</span>
    </label>
  );
}

// ---- Toast (DESIGN.md §5) -----------------------------------------------------------------------
export type ToastKind = "success" | "error" | "info";
export interface ToastItem { id: number; kind: ToastKind; message: string }
const ToastCtx = createContext<(kind: ToastKind, message: string) => void>(() => {});
export function useToast() { return useContext(ToastCtx); }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  const push = useCallback((kind: ToastKind, message: string) => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, kind, message }]);
    if (kind !== "error") {
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
    }
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
            <span className="text-tertiary">{t.kind === "success" ? Icons.check : t.kind === "error" ? Icons.warn : Icons.ledger}</span>
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---- MonoChip (copyable) --------------------------------------------------------------------------
export function MonoChip({ text }: { text: string }) {
  const toast = useToast();
  return (
    <button
      className="mono-chip"
      title="Copy"
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); toast("success", "Copied"); } catch { toast("error", "Copy failed"); }
      }}
    >
      {text}
    </button>
  );
}

// ---- useAsync hook (loading/error/data) ---------------------------------------------------------------
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const run = useCallback(() => {
    setLoading(true); setError(null);
    fn().then(setData).catch((e: unknown) => setError((e as Error).message)).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { data, error, loading, reload: run };
}
