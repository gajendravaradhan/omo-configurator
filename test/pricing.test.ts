import { describe, expect, test } from "bun:test";
import {
  DEEPSEEK_SCHEDULE, isPeak, scheduleActive, scheduledBlendedPrice, nextTransition, cronLines,
} from "../src/pricing.ts";

const D = (iso: string) => new Date(iso);

describe("DeepSeek peak/off-peak schedule", () => {
  test("peak windows are 01:00-04:00 and 06:00-10:00 UTC, half-open", () => {
    expect(isPeak(DEEPSEEK_SCHEDULE, D("2026-08-17T01:00:00Z"))).toBe(true);
    expect(isPeak(DEEPSEEK_SCHEDULE, D("2026-08-17T03:59:00Z"))).toBe(true);
    expect(isPeak(DEEPSEEK_SCHEDULE, D("2026-08-17T04:00:00Z"))).toBe(false); // half-open
    expect(isPeak(DEEPSEEK_SCHEDULE, D("2026-08-17T05:30:00Z"))).toBe(false);
    expect(isPeak(DEEPSEEK_SCHEDULE, D("2026-08-17T06:00:00Z"))).toBe(true);
    expect(isPeak(DEEPSEEK_SCHEDULE, D("2026-08-17T10:00:00Z"))).toBe(false);
    expect(isPeak(DEEPSEEK_SCHEDULE, D("2026-08-17T14:00:00Z"))).toBe(false);
  });

  test("schedule is NOT in force before 16:00 UTC 2026-08-16 — legacy flat rates stand", () => {
    expect(scheduleActive(DEEPSEEK_SCHEDULE, D("2026-08-16T15:59:00Z"))).toBe(false);
    expect(scheduleActive(DEEPSEEK_SCHEDULE, D("2026-08-16T16:00:00Z"))).toBe(true);
    // Before the switch-over, even a peak hour returns undefined so the static tier price is used.
    expect(scheduledBlendedPrice("deepseek", "deepseek-v4-flash", D("2026-08-15T02:00:00Z"))).toBeUndefined();
  });

  test("peak costs exactly 2x off-peak, and the dated build resolves by prefix", () => {
    const peak = scheduledBlendedPrice("deepseek", "deepseek-v4-flash", D("2026-08-17T02:00:00Z"))!;
    const off = scheduledBlendedPrice("deepseek", "deepseek-v4-flash", D("2026-08-17T14:00:00Z"))!;
    expect(peak).toBeCloseTo(2 * off, 6);
    expect(scheduledBlendedPrice("deepseek", "deepseek-v4-flash-0731", D("2026-08-17T02:00:00Z"))).toBeCloseTo(peak, 6);
  });

  test("KEY ARBITRAGE: opencode-go is a FLAT subscription — never exposed to peak surcharges", () => {
    // Same model, different provider: the metered direct sub is scheduled, opencode-go is not.
    expect(scheduledBlendedPrice("deepseek", "deepseek-v4-flash", D("2026-08-17T02:00:00Z"))).toBeDefined();
    expect(scheduledBlendedPrice("opencode-go", "deepseek-v4-flash", D("2026-08-17T02:00:00Z"))).toBeUndefined();
  });

  test("PEAK DeepSeek is more expensive than GPT-5.6 Luna on BOTH axes", () => {
    // Luna: $0.20 in / $1.20 out. DeepSeek Flash peak: $0.44 in / $1.32 out.
    const lunaBlend = (0.2 + 3 * 1.2) / 4;
    const dsPeak = scheduledBlendedPrice("deepseek", "deepseek-v4-flash", D("2026-08-17T02:00:00Z"))!;
    expect(dsPeak).toBeGreaterThan(lunaBlend);
    // ...but off-peak DeepSeek wins again.
    const dsOff = scheduledBlendedPrice("deepseek", "deepseek-v4-flash", D("2026-08-17T14:00:00Z"))!;
    expect(dsOff).toBeLessThan(lunaBlend);
  });

  test("nextTransition finds the next boundary, wrapping past midnight", () => {
    expect(nextTransition(DEEPSEEK_SCHEDULE, D("2026-08-17T02:00:00Z")).toISOString()).toBe("2026-08-17T04:00:00.000Z");
    expect(nextTransition(DEEPSEEK_SCHEDULE, D("2026-08-17T23:00:00Z")).toISOString()).toBe("2026-08-18T01:00:00.000Z");
  });

  test("cronLines emits one entry per boundary (4 transitions/day)", () => {
    const lines = cronLines(DEEPSEEK_SCHEDULE, "echo hi");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("0 1 * * *");
    expect(lines[3]).toContain("0 10 * * *");
  });
});
