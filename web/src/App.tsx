// App shell — fixed sidebar + scroll-owning main, tiny hash router (no dependency).
import { useEffect, useState } from "react";
import { Icons } from "./components/ui.tsx";
import { Dashboard } from "./views/Dashboard.tsx";
import { OptimizeView } from "./views/Optimize.tsx";
import { DiscoverView } from "./views/Discover.tsx";
import { ChainsView } from "./views/Chains.tsx";
import { TokenHistoryView } from "./views/TokenHistory.tsx";
import { InventoryView } from "./views/Inventory.tsx";
import { PinnedView } from "./views/Pinned.tsx";
import { RollbackView } from "./views/Rollback.tsx";
import { ChallengeView } from "./views/Challenge.tsx";
import { LedgerView } from "./views/Ledger.tsx";
import { ReportView } from "./views/Report.tsx";

const NAV: Array<{ hash: string; label: string; icon: React.ReactNode }> = [
  { hash: "#/", label: "Dashboard", icon: Icons.dashboard },
  { hash: "#/optimize", label: "Optimize", icon: Icons.optimize },
  { hash: "#/discover", label: "Discover", icon: Icons.discover },
  { hash: "#/chains", label: "Chains", icon: Icons.chains },
  { hash: "#/tokens", label: "Token History", icon: Icons.tokens },
  { hash: "#/inventory", label: "Inventory", icon: Icons.inventory },
  { hash: "#/pinned", label: "Pinned", icon: Icons.pinned },
  { hash: "#/rollback", label: "Rollback", icon: Icons.rollback },
  { hash: "#/challenge", label: "Challenge", icon: Icons.challenge },
  { hash: "#/ledger", label: "Ledger", icon: Icons.ledger },
  { hash: "#/report", label: "Report", icon: Icons.report },
];

function currentHash(): string {
  const h = location.hash || "#/";
  return h.split("?")[0];
}

export function App() {
  const [hash, setHash] = useState(currentHash());
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const onHash = () => { setHash(currentHash()); setSidebarOpen(false); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const go = (h: string) => { location.hash = h; };

  let view: React.ReactNode;
  switch (hash) {
    case "#/optimize": view = <OptimizeView />; break;
    case "#/discover": view = <DiscoverView />; break;
    case "#/chains": view = <ChainsView />; break;
    case "#/tokens": view = <TokenHistoryView />; break;
    case "#/inventory": view = <InventoryView />; break;
    case "#/pinned": view = <PinnedView />; break;
    case "#/rollback": view = <RollbackView />; break;
    case "#/challenge": view = <ChallengeView />; break;
    case "#/ledger": view = <LedgerView />; break;
    case "#/report": view = <ReportView />; break;
    default: view = <Dashboard />; break;
  }

  return (
    <div className="app-shell">
      <div className={`sidebar-backdrop ${sidebarOpen ? "show" : ""}`} onClick={() => setSidebarOpen(false)} />
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-brand">
          <span className="logo">{Icons.optimize}</span>
          <span className="name">omo-plutus</span>
        </div>
        <nav aria-label="Main">
          {NAV.map((n) => (
            <button
              key={n.hash}
              className={`nav-item ${hash === n.hash ? "active" : ""}`}
              onClick={() => go(n.hash)}
              aria-current={hash === n.hash ? "page" : undefined}
            >
              {n.icon}
              {n.label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="main">
        <div className="main-inner">{view}</div>
      </main>
    </div>
  );
}
