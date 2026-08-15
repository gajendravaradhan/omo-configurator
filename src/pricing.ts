// Time-aware pricing (DeepSeek peak / off-peak, effective 16:00 UTC 2026-08-16).
//
// WHAT CHANGED, AND WHY IT IS NOT A DISCOUNT
// DeepSeek's announcement is a PRICE INCREASE with a peak surcharge, not an off-peak discount.
// V4-Flash output goes from a flat $0.28/Mtok to $1.32 peak / $0.66 off-peak. Even the off-peak
// rate is 2.4x today's price; peak is 4.7x. Framing this as "use DeepSeek off-peak to save money"
// is the wrong read — the correct read is that DeepSeek's cost advantage narrowed sharply, and at
// peak it disappears against GPT-5.6 Luna entirely:
//
//   DeepSeek V4-Flash PEAK : $0.44 in / $1.32 out
//   GPT-5.6 Luna           : $0.20 in / $1.20 out   <- cheaper on BOTH axes
//   DeepSeek V4-Flash OFF  : $0.22 in / $0.66 out   <- wins on output, loses on input
//
// THE ARBITRAGE THAT ACTUALLY MATTERS
// DeepSeek is reachable two ways here: the metered direct subscription (exposed to this schedule)
// and opencode-go, a FLAT subscription whose quota is unaffected by DeepSeek's per-token pricing.
// During peak, routing DeepSeek work to opencode-go costs nothing extra. That is the real "more
// miles out of the subscription" lever, and it is bigger than any model substitution.
//
// Peak windows: 01:00-04:00 and 06:00-10:00 UTC. All other hours off-peak.
// Source: https://api-docs.deepseek.com/quick_start/pricing/

/** Half-open UTC hour ranges [startHour, endHour). */
export interface PeakWindow { startHourUtc: number; endHourUtc: number }

export interface PricingSchedule {
  /** Provider this schedule applies to (matched case-insensitively against the provider id). */
  provider: string;
  /** Date-time at/after which the schedule is in force (ISO). Before this, legacy flat rates apply. */
  effectiveFrom: string;
  windows: PeakWindow[];
  /** Model id prefix -> peak and off-peak blended $/Mtok. */
  rates: Record<string, { peakIn: number; peakOut: number; offIn: number; offOut: number }>;
  sourceUrl: string;
}

export const DEEPSEEK_SCHEDULE: PricingSchedule = {
  provider: "deepseek",
  effectiveFrom: "2026-08-16T16:00:00Z",
  windows: [
    { startHourUtc: 1, endHourUtc: 4 },
    { startHourUtc: 6, endHourUtc: 10 },
  ],
  rates: {
    "deepseek-v4-flash": { peakIn: 0.44, peakOut: 1.32, offIn: 0.22, offOut: 0.66 },
    "deepseek-v4-pro": { peakIn: 1.32, peakOut: 3.96, offIn: 0.66, offOut: 1.98 },
  },
  sourceUrl: "https://api-docs.deepseek.com/quick_start/pricing/",
};

/** True when `at` falls inside a peak window (UTC hours, half-open). */
export function isPeak(schedule: PricingSchedule, at: Date): boolean {
  const h = at.getUTCHours();
  return schedule.windows.some((w) => h >= w.startHourUtc && h < w.endHourUtc);
}

/** True once the new rate card is in force. Before then the legacy flat rates in tiers.json stand. */
export function scheduleActive(schedule: PricingSchedule, at: Date): boolean {
  return at.getTime() >= Date.parse(schedule.effectiveFrom);
}

/** Longest-prefix rate lookup, so `deepseek-v4-flash-0731` matches `deepseek-v4-flash`. */
function rateFor(schedule: PricingSchedule, model: string) {
  let best: PricingSchedule["rates"][string] | undefined, len = 0;
  for (const [id, r] of Object.entries(schedule.rates)) {
    if (model.startsWith(id) && id.length > len) { best = r; len = id.length; }
  }
  return best;
}

/**
 * Time-aware blended $/Mtok (output weighted 3x, matching quality.blendedPrice).
 * Returns undefined when the schedule does not cover this provider/model or is not yet in force,
 * so the caller falls back to the static price in tiers.json.
 */
export function scheduledBlendedPrice(
  provider: string, model: string, at: Date, schedule: PricingSchedule = DEEPSEEK_SCHEDULE,
): number | undefined {
  if (!provider.toLowerCase().includes(schedule.provider)) return undefined;
  if (!scheduleActive(schedule, at)) return undefined;
  const r = rateFor(schedule, model);
  if (!r) return undefined;
  const peak = isPeak(schedule, at);
  const inp = peak ? r.peakIn : r.offIn, out = peak ? r.peakOut : r.offOut;
  return (inp + 3 * out) / 4;
}

/** Next boundary at or after `at` where peak state flips — used to generate the cron schedule. */
export function nextTransition(schedule: PricingSchedule, at: Date): Date {
  const bounds = new Set<number>();
  for (const w of schedule.windows) { bounds.add(w.startHourUtc); bounds.add(w.endHourUtc); }
  const sorted = [...bounds].sort((a, b) => a - b);
  const h = at.getUTCHours();
  const nextHour = sorted.find((b) => b > h);
  const d = new Date(at);
  d.setUTCMinutes(0, 0, 0);
  if (nextHour === undefined) { d.setUTCDate(d.getUTCDate() + 1); d.setUTCHours(sorted[0]!); }
  else d.setUTCHours(nextHour);
  return d;
}

/** Crontab lines (UTC) that re-run the optimizer at every peak/off-peak boundary. */
export function cronLines(schedule: PricingSchedule, command: string): string[] {
  const bounds = new Set<number>();
  for (const w of schedule.windows) { bounds.add(w.startHourUtc); bounds.add(w.endHourUtc); }
  return [...bounds].sort((a, b) => a - b)
    .map((h) => `0 ${h} * * *  ${command}   # DeepSeek peak/off-peak boundary (${String(h).padStart(2, "0")}:00 UTC)`);
}

/** Human-readable status line for the report. */
export function pricingStatus(at: Date, schedule: PricingSchedule = DEEPSEEK_SCHEDULE): string {
  if (!scheduleActive(schedule, at)) {
    return `DeepSeek peak/off-peak pricing is NOT yet in force (starts ${schedule.effectiveFrom}); legacy flat rates apply.`;
  }
  const peak = isPeak(schedule, at);
  const next = nextTransition(schedule, at);
  return `DeepSeek is in ${peak ? "PEAK" : "OFF-PEAK"} pricing at ${at.toISOString()}; next transition ${next.toISOString()}.`;
}
