import { test, expect } from "bun:test";
import {
  abbreviateCount,
  formatActivityTokens,
  formatCacheRate,
  formatPlanUsage,
  formatResetCountdown,
  usageLevel,
} from "./tui.ts";

test("abbreviateCount leaves values <= 1000 unabbreviated", () => {
  expect(abbreviateCount(0)).toBe("0");
  expect(abbreviateCount(999)).toBe("999");
  expect(abbreviateCount(1000)).toBe("1k");
});

test("abbreviateCount uses k notation above 1000", () => {
  expect(abbreviateCount(1200)).toBe("1.2k");
  expect(abbreviateCount(2700)).toBe("2.7k");
  expect(abbreviateCount(12_000)).toBe("12k");
});

test("abbreviateCount uses M notation above one million", () => {
  expect(abbreviateCount(1_000_000)).toBe("1M");
  expect(abbreviateCount(2_500_000)).toBe("2.5M");
});

test("usageLevel bands at 70% (warn) and 90% (crit)", () => {
  expect(usageLevel(0)).toBe("ok");
  expect(usageLevel(0.699)).toBe("ok");
  expect(usageLevel(0.7)).toBe("warn");
  expect(usageLevel(0.899)).toBe("warn");
  expect(usageLevel(0.9)).toBe("crit");
  expect(usageLevel(1)).toBe("crit");
});

test("formatResetCountdown renders days, hours, minutes, and edge cases", () => {
  const now = 1_000_000_000_000;
  expect(formatResetCountdown(now + 2 * 86_400_000 + 3 * 3_600_000, now)).toBe("2d 3h");
  expect(formatResetCountdown(now + 1 * 3_600_000 + 2 * 60_000, now)).toBe("1h 2m");
  expect(formatResetCountdown(now + 5 * 60_000, now)).toBe("5m");
  expect(formatResetCountdown(now + 30_000, now)).toBe("<1m");
  expect(formatResetCountdown(now, now)).toBe("now");
  expect(formatResetCountdown(now - 60_000, now)).toBe("now"); // already past
});

test("formatPlanUsage renders a bar, percent, and reset countdown", () => {
  const now = 1_000_000_000_000;
  expect(
    formatPlanUsage("5h", { utilization: 0.71, resetAt: now + 3_600_000 + 2 * 60_000, status: "allowed" }, now),
  ).toBe("5h     [███████░░░]  71%  resets in 1h 2m");
});

test("formatPlanUsage appends a non-allowed status so throttling is visible", () => {
  const now = 1_000_000_000_000;
  expect(
    formatPlanUsage("5h", { utilization: 1, resetAt: now + 60_000, status: "rejected" }, now),
  ).toBe("5h     [██████████] 100%  resets in 1m  rejected");
});

test("formatPlanUsage clamps utilization into the bar and percent", () => {
  const now = 1_000_000_000_000;
  expect(formatPlanUsage("weekly", { utilization: 0, resetAt: now, status: "allowed" }, now)).toBe(
    "weekly [░░░░░░░░░░]   0%  resets in now",
  );
  expect(
    formatPlanUsage("5h", { utilization: 1.4, resetAt: now + 60_000, status: "allowed" }, now),
  ).toBe("5h     [██████████] 100%  resets in 1m");
});

test("formatActivityTokens shows the cached witness when cache reads landed", () => {
  expect(
    formatActivityTokens({ prompt_tokens: 12000, completion_tokens: 200, cached_tokens: 11500 }),
  ).toBe(" 12000→200tok (cached 11.5k)");
});

test("formatActivityTokens omits the cached segment when there are no cache reads", () => {
  expect(
    formatActivityTokens({ prompt_tokens: 500, completion_tokens: 200, cached_tokens: 0 }),
  ).toBe(" 500→200tok");
  expect(
    formatActivityTokens({ prompt_tokens: 500, completion_tokens: 200, cached_tokens: null }),
  ).toBe(" 500→200tok");
});

test("formatActivityTokens renders unknown counts as ? but still shows cached", () => {
  expect(
    formatActivityTokens({ prompt_tokens: null, completion_tokens: 200, cached_tokens: 300 }),
  ).toBe(" ?→200tok (cached 300)");
});

test("formatActivityTokens is empty when no token counts were recorded", () => {
  expect(
    formatActivityTokens({ prompt_tokens: null, completion_tokens: null, cached_tokens: null }),
  ).toBe("");
  // A pending row with no usage yet shows nothing, even if cached were somehow set.
  expect(
    formatActivityTokens({ prompt_tokens: null, completion_tokens: null, cached_tokens: 99 }),
  ).toBe("");
});

test("formatCacheRate renders an integer percentage with abbreviated counts", () => {
  expect(formatCacheRate({ cached: 1200, input: 2700 }, "24h")).toBe(
    "cache rate (24h)  44%  (1.2k cached / 2.7k input)",
  );
});

test("formatCacheRate rounds the percentage to an integer", () => {
  expect(formatCacheRate({ cached: 1, input: 3 }, "24h")).toBe(
    "cache rate (24h)  33%  (1 cached / 3 input)",
  );
});

test("formatCacheRate surfaces the active period label", () => {
  expect(formatCacheRate({ cached: 1, input: 2 }, "7d")).toBe(
    "cache rate (7d)  50%  (1 cached / 2 input)",
  );
  expect(formatCacheRate({ cached: 0, input: 0 }, "all")).toBe("cache rate (all)  —");
});

test("formatCacheRate shows a dim dash when there is no usable input", () => {
  expect(formatCacheRate({ cached: 0, input: 0 }, "24h")).toBe("cache rate (24h)  —");
});

test("formatCacheRate treats negative input as the empty state", () => {
  expect(formatCacheRate({ cached: 0, input: -5 }, "24h")).toBe("cache rate (24h)  —");
});
