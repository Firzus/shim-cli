# 2. Usage metrics: windowed cache rate + header-sourced plan usage

Date: 2026-06-08

## Status

Accepted

## Context

cursor-relay surfaced a single "Session cache rate" that summed `cached_tokens / prompt_tokens` over the **entire** `activity` table (`cacheTotals()`), with no time bound. The result reads ~0% indefinitely: cold first-turn requests and any pre-cache traffic stay in the denominator forever, burying the live signal. It also conflated two different questions into one number.

Two predecessor tools solved this and are the references:

- `Firzus/claude-code-to-cursor` — computes `cacheHitRate` over a **bounded, selectable period** (per-request rows are timestamped; aggregation filters by `since`).
- `Firzus/shim` — reads real subscription quota from Anthropic's `anthropic-ratelimit-unified-{5h,7d}-*` response headers, not from self-counted tokens.

## Decision

Track **two separate metrics**, deliberately not merged:

1. **Cache rate** — cache *efficiency*. `cache_read / normalized_input` aggregated over a bounded period (`5h / 24h / 7d / 30d / all`, default **24h**), never an all-time sum. Windowing is a `WHERE ts >= since` filter on the existing `activity` table — no schema change, since rows already carry `ts`, `cached_tokens`, and normalized `prompt_tokens`. Canonical name stays **"cache rate"** (not "cache hit rate", per CONTEXT.md).
2. **Plan usage** — subscription *consumption*. Parse `anthropic-ratelimit-unified-{5h,7d}-*` (utilization + reset + status) from each Claude response, capture into a throttled one-row-per-provider snapshot, render two windows (5h + weekly).

Cache rate answers "do the ADR-0001 breakpoints work?"; plan usage answers "how much of my plan have I burned?". The original single-number design conflated efficiency with consumption.

## Consequences

- The Claude provider must read `res.headers` (currently dropped at `src/providers/claude/index.ts:40`). **Verified** (issue #11, live `max` plan call, 2026-06-08): the OAuth path returns the unified rate-limit headers. Observed shapes, load-bearing for the plan-usage slice:
  - `anthropic-ratelimit-unified-5h-{utilization,reset,status}` and `anthropic-ratelimit-unified-7d-{utilization,reset,status}` are both present.
  - `utilization` is a **0–1 fraction** (e.g. `0.71` = 71%), not a percent — render as `round(u * 100)`.
  - `reset` is an **epoch in seconds** (10 digits, e.g. `1780926000`), not ms — convert with `new Date(reset * 1000)`.
  - `status` is a string enum (`allowed` observed; expect `rejected`/throttled forms under pressure).
  - Extras also present, not required by this ADR but available: a window-less `anthropic-ratelimit-unified-{reset,status}` mirroring `-representative-claim` (`five_hour`), a model-scoped `-7d_sonnet-*` sub-window, and `-fallback`/`-fallback-percentage`/`-overage-status`/`-overage-disabled-reason`.
- New persistence: a throttled plan-usage snapshot store (one row per provider) alongside per-request `activity`.
- The TUI gains a period selector for cache rate and two plan-usage bars; the old all-time cache-rate line is removed.
- Plan usage is the authoritative consumption signal; cache rate is only a proxy for breakpoint health. Reuniting them later would re-introduce the bug this ADR exists to prevent.
