# SPIKE-06 — Go (opencode-go) request-tiered accounting

**Status:** UNVERIFIED — data unobtainable. Written finding (W3.5, 3h timebox).
**Date:** 2026-08-07
**Gates:** W4 Go budgeting logic. **Locked decision below remains in force until this finding is re-opened with real billing data.**

## Question

How does the `opencode-go` provider account for usage? Specifically:

1. Is it metered per token, flat, or request-tiered (buckets of requests / tokens per tier)?
2. If request-tiered, what are the tier boundaries and does a "request" cost the same regardless of model/tokens?
3. Can remaining capacity be expressed as a 0..1 quota headroom number comparable to subscription providers?

## Attempted verification (timeboxed)

- Live `~/.cache/opencode/models.json` `opencode-go` provider block: structure only — `{id, env, npm, api, name, doc, models}` — **no pricing/tier fields** (verified 2026-08-05/07; 180 providers, 5939 models).
- `opencode-go` npm package: not a billing surface (SDK client only).
- Provider docs surfaced by the cache: no public tier/pricing table for programmatic consumption.
- `bun x @slkiser/opencode-quota show --json` (live, this sandbox): reports `opencode-go` as `status: "unavailable"` — the quota tool itself has no verified Go capacity data.

**Conclusion: the request-tiered accounting model is UNVERIFIED. No authoritative data source exists in this environment, and none is reachable without a real billing account/statement.**

## Locked decision (in force until re-opened)

Per bundle §4 / W2.4, Go budgeting is:

1. **Overflow-only** — Go (opencode-go) is treated as an untrusted provider: it is assigned only after trusted windows fill.
2. **1× over-estimate** — when Go is used, projected consumption is estimated at 1× the slot's projected metered cost (no discounting, no averaging).
3. **Loud warning** — every run that assigns to Go prints a warning that Go capacity is unverified (never silent).

## Re-open gate

Re-open this spike only with one of:
- A real Go billing statement or dashboard export showing request tiers and per-tier token counts;
- An authoritative provider pricing API response;
- Omo telemetry (ledger P3) accumulating enough real Go usage to infer the tier model statistically.

Until then, **the overflow-only + 1× over-estimate + loud warning budget stands** — see `src/solver.ts` (untrusted/overflow-only) and the W2.4 commit.

## Budget status map

| Provider class | Budget treatment |
|---|---|
| Trusted subscription (non-null cap) | windowed quota 0..1, normal assignment |
| Trusted metered (non-null cap, priced) | projected metered cost |
| Untrusted (cap=null) — incl. Go | overflow-only + 1× over-estimate + loud warning |
| All caps null (P1/S3b) | quality-optimal only; single banner; no budget enforcement |
