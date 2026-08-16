// API client — talks to the omo-plutus server (same origin; server serves API + static).
// Error contract: server returns { error: string, exitCode?: number } with 4xx/5xx.

export interface ApiError extends Error {
  status: number;
  exitCode?: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw Object.assign(new Error(`Cannot reach the omo-plutus server at ${location.origin}. Is it running?`), {
      status: 0,
    }) as ApiError;
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const msg = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
    const err = Object.assign(new Error(msg), { status: res.status }) as ApiError;
    if (body && typeof body === "object" && "exitCode" in body) err.exitCode = Number((body as { exitCode: unknown }).exitCode);
    throw err;
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }),
};

// ---- shared response types (mirror server/index.ts) --------------------------
export interface Status {
  ok: boolean;
  omoVersion: string;
  probedOmoVersion: string;
  p8Pass: boolean;
  chainSha: string | null;
  drift: { ok: boolean; detail: string };
  inventoryPath: string;
  inventoryExists: boolean;
  dbPath: string;
  dbExists: boolean;
  ledgerPath: string;
  pinnedPath: string;
  schemaId: string | null;
}

export interface ChainEntry { model: string; providers: string[]; position: number }
export interface SlotChainInfo { kind: string; name: string; fallbackChain: ChainEntry[] }
export interface ProviderBudget {
  provider: string; capacityTokens: number | null; remainingTokens: number | null;
  consumedTokens: number; trusted: boolean; overCommitted: boolean;
}
export interface BudgetResult {
  budgets: ProviderBudget[];
  demoted: Array<{ slot: string; from: string; to: string; reason: string }>;
  overCommitted: string[];
  enforced: boolean;
}
export interface BurnForecast {
  provider: string; burnPerHour: number; hoursToReset: number | null;
  projectedTokens: number; remainingTokens: number | null;
  willExhaust: boolean; hoursToExhaustion: number | null;
}
export interface PricingInfo {
  status: string; peakNow: boolean; effectiveFrom: string;
  windows: Array<{ startHourUtc: number; endHourUtc: number }>;
  nextTransition: string; sourceUrl: string; cron: string[];
}

export interface SolvePreview {
  assignments: Array<{
    slot: string;
    kind: string;
    primary: { model: string; provider: string; fit: number; capability: number; quality: number; trusted: boolean
  budget?: BudgetResult;
  burn?: BurnForecast[];
  pricing?: string;
  demandSource?: Record<string, string>;
};
    fallbacks: Array<{ model: string; provider: string; fit: number }>;
    rationale: string;
    untrusted?: boolean;
  }>;
  allUntrusted: boolean;
  skippedPinned: string[];
  report: string;
}

export interface BudgetBearing {
  budget?: BudgetResult; burn?: BurnForecast[]; pricing?: string;
  demandSource?: Record<string, string>;
}

export interface TokenHistory {
  available: boolean;
  dbPath: string;
  rows: Array<{ agent: string; model: string; calls: number; inputTokens: number; outputTokens: number; reasoningTokens: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number }>;
}
