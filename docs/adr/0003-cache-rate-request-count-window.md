# 3. Cache rate is a request-count window, not a time window

Date: 2026-06-09

## Status

Superseded by [ADR-0004](./0004-cache-rate-all-time.md) (the cache rate is now
all-time; the NULL-exclusion, `id` ordering, and never-fold-creation decisions
below remain in force). Superseded the cache-rate windowing decision in
[ADR-0002](./0002-usage-metrics-model.md) (the request/error **counters** keep
the time-windowed `w` period; only the cache rate moves).

## Context

ADR-0002 scoped the TUI cache rate to a selectable **time** window (`5h / 24h /
7d / 30d / all`, default `24h`), cycled with `w`, to keep cold pre-cache history
out of the denominator. In practice this window has two failure modes that make
the displayed rate misleading:

1. **It lags reality by hours.** A single Cursor response is a burst of ~10–30
   proxy requests (the agentic tool loop). The caching works well per request
   (observed 84–97%), but a handful of full cache *misses* sitting in the window
   — first-turn cold starts, 5-minute-TTL expiries on think-gaps, or rows from a
   previous service build — dominate the aggregate. With a 5h *minimum* window,
   those misses linger for hours: a fresh 90% response barely moves the number.
   The headline read 65% while the live efficiency was ~89%.

2. **Unmeasured rows were scored as 0% misses.** `cached_tokens IS NULL` means a
   request was never measured — it is pending, or was recorded by an older build
   that did not report cache tokens. The old `cacheTotals` summed `cached` with
   `COALESCE(…,0)` but kept `prompt_tokens` in the denominator, so every
   unmeasured row counted as a full miss and dragged the rate down.

The goal is a number that reflects *current* cache efficiency and converges
within the first response — the behaviour of the `claude-code-to-cursor`
prototype's overview card.

## Decision

Scope the cache rate to the **last N measured requests** (`CACHE_RATE_SAMPLE =
20`), ordered by `id` (newest first), excluding rows with a NULL
`cached_tokens`. `cacheTotalsRecent(n)` replaces the time-windowed
`cacheTotals(since)`. The TUI label becomes `cache rate (last 20)`.

- **Request-count, not time.** Because one response is many requests, a 20-request
  window fills within a single response and never holds stale history. It is
  self-contained in the TUI (`ORDER BY id DESC LIMIT n`) — no cross-process
  plumbing of a "session start" between the `serve` and `tui` processes.
- **Exclude unmeasured rows.** The `WHERE cached_tokens IS NOT NULL` filter runs
  *before* the limit, so the sample reaches back to the last N genuinely measured
  requests even when the newest rows are pending or unmeasured. Unmeasured ≠ 0%
  miss.
- **Counters stay time-windowed.** The request/error counters keep the `w` period
  (`5h…all`), which now scopes the counters only; the period label moved onto the
  counters line so `w`'s target stays legible.

Decisions made:

- **N = 20**, not a time bucket and not "last request". One request is too noisy
  (a single tool call swings it); 20 covers a response's worth of requests and
  smooths the per-request jitter while still converging fast.
- **Order by `id`, not `ts`.** `id` is monotonic with insertion; it gives a stable
  newest-first order without depending on clock writes.
- **Realistic ceiling ~82–88%, not 95%.** The residual gap is structural — Cursor
  varies its system prompt between turns (breaking the stable prefix on some
  requests) and the 5-minute ephemeral TTL expires across think-gaps. Closing it
  further would mean porting the prototype's fuller request normalization (`mcp_`
  tool-name prefix, tool-id normalization, `stop_sequences`) and/or extending the
  cache TTL — deliberately out of scope here.

## Consequences

- The displayed cache rate now tracks live efficiency and converges within one
  response, at the cost of the historical time-windowed view of the rate (the
  counters retain time windowing).
- `cacheTotalsRecent` is the single source for the rate; any future "session" or
  historical cache-rate view would be a new function, not a reinterpretation of
  this one.
- The NULL-exclusion also protects the rate from future unmeasured rows (e.g. a
  stream that errors before reporting usage), which the time-windowed version
  silently scored as misses.

## Amendment (TUI panel redesign, 2026-06-10)

The single store read behind the rate is now `recentCacheSamples(n)`, which
returns the per-request `(cached, input)` pairs of the same last-N-measured
window (oldest → newest) instead of pre-summed totals. The TUI derives **both**
the aggregate percent (`Σcached / Σinput` — unchanged definition) and the
per-request cache-rate sparkline from that one sample, so the two can never
disagree. Cache creation is still never folded into the rate; a cold cache
write stays visible via the `wrote` witness on the activity row and as a
trough in the sparkline.
