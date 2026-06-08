import { test, expect } from "bun:test";
import { parseAnthropicRateLimitHeaders } from "./usage.ts";

/** The exact header set captured live in issue #11 (subset that matters). */
function liveHeaders(): Headers {
  return new Headers({
    "anthropic-ratelimit-unified-5h-utilization": "0.71",
    "anthropic-ratelimit-unified-5h-reset": "1780926000",
    "anthropic-ratelimit-unified-5h-status": "allowed",
    "anthropic-ratelimit-unified-7d-utilization": "0.19",
    "anthropic-ratelimit-unified-7d-reset": "1781409600",
    "anthropic-ratelimit-unified-7d-status": "allowed",
    // model-scoped weekly — must be ignored in favour of the general 7d window
    "anthropic-ratelimit-unified-7d_sonnet-utilization": "0.0",
    "anthropic-ratelimit-unified-7d_sonnet-reset": "1781409600",
    "anthropic-ratelimit-unified-7d_sonnet-status": "allowed",
  });
}

test("parseAnthropicRateLimitHeaders returns 5h + weekly with normalized shapes", () => {
  const snap = parseAnthropicRateLimitHeaders(liveHeaders());
  expect(snap).toEqual({
    fiveHour: { utilization: 0.71, resetAt: 1780926000 * 1000, status: "allowed" },
    weekly: { utilization: 0.19, resetAt: 1781409600 * 1000, status: "allowed" },
  });
});

test("parseAnthropicRateLimitHeaders clamps an overage utilization to 1, not down to ~0", () => {
  const h = liveHeaders();
  h.set("anthropic-ratelimit-unified-5h-utilization", "1.05"); // 105% overage
  const snap = parseAnthropicRateLimitHeaders(h);
  expect(snap?.fiveHour.utilization).toBe(1); // capped at maxed, not folded to 0.0105
});

test("parseAnthropicRateLimitHeaders clamps a negative utilization to 0", () => {
  const h = liveHeaders();
  h.set("anthropic-ratelimit-unified-5h-utilization", "-0.2");
  const snap = parseAnthropicRateLimitHeaders(h);
  expect(snap?.fiveHour.utilization).toBe(0);
});

test("parseAnthropicRateLimitHeaders passes through a reset already in milliseconds", () => {
  const h = liveHeaders();
  h.set("anthropic-ratelimit-unified-5h-reset", "1780926000000"); // already ms (13 digits)
  const snap = parseAnthropicRateLimitHeaders(h);
  expect(snap?.fiveHour.resetAt).toBe(1780926000000);
});

test("parseAnthropicRateLimitHeaders returns null when a window is absent", () => {
  const h = liveHeaders();
  h.delete("anthropic-ratelimit-unified-7d-utilization");
  expect(parseAnthropicRateLimitHeaders(h)).toBeNull();
});

test("parseAnthropicRateLimitHeaders returns null on a non-OAuth response (no headers)", () => {
  expect(parseAnthropicRateLimitHeaders(new Headers())).toBeNull();
});

test("parseAnthropicRateLimitHeaders returns null when a value is unparseable", () => {
  const h = liveHeaders();
  h.set("anthropic-ratelimit-unified-5h-utilization", "n/a");
  expect(parseAnthropicRateLimitHeaders(h)).toBeNull();
});
