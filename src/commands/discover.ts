// Thin command shim — implementation lives in src/discover.ts (W3.4).
export { discover, parseQuotaOutput, mergeQuota, writeInventoryAtomic, fetchQuota } from "../discover.ts";
export type { QuotaSnapshot, DiscoverArgs } from "../discover.ts";
