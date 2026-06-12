# 5. All-time counters, cache rate without a sparkline

Date: 2026-06-11

## Status

Accepted, then qualified by [ADR-0006](./0006-activity-retention-7-days.md)
("all-time" becomes the retained history — at most 7 days). Amends
[ADR-0004](./0004-cache-rate-all-time.md) (drops the bucketed sparkline) and
[ADR-0002](./0002-usage-metrics-model.md) (drops the windowed counters and the
cache-rate period selector).

## Context

ADR-0004 made the cache rate an all-time figure but kept a 20-glyph bucketed
sparkline beside it; ADR-0002 kept the request/error **counters** scoped to a
selectable `w` period (`5h / 24h / 7d / 30d / all`). The TUI redesign (issue
#48) reorganized the panel into a navigable activity stream plus a right
sidebar, and a design pass on the sidebar found both carried weight they did not
earn:

- The sparkline competed with the activity stream for the operator's eye while
  adding no decision-relevant signal the headline percent did not already carry.
- The `w` period was the only time-window concept left in the panel (the cache
  rate is already all-time). One windowed metric among otherwise all-time
  numbers was a source of "which period is this?" ambiguity, and the `w` key
  spent a keycap on it.

## Decision

- **Counters are all-time.** `requests` and `errors` count every row in the
  `activity` table — `activityCounters()`, no `WHERE ts >= since`. The `w` key
  and the `Period` machinery (`PERIODS`, `periodSince`, `nextPeriod`,
  `DEFAULT_PERIOD`) are removed.
- **The cache rate keeps no sparkline.** It is a single percent plus the
  `X cached / Y input` detail, derived from `cacheTotals()` —
  `SUM(cached_tokens) / SUM(prompt_tokens)` over all measured rows, a plain
  aggregate with no `NTILE` bucketing. `bucketedCacheSamples`,
  `CACHE_SPARK_BUCKETS`, and the `sparkline` presenter are removed.

Carried over from ADR-0004 (still in force):

- **Unmeasured rows are excluded outright** (`WHERE cached_tokens IS NOT NULL
  AND prompt_tokens IS NOT NULL`), never scored as 0% misses.
- **Cache creation is never folded into the rate**; a cold write stays visible
  as the `wrote` witness on the activity row.

## Consequences

- The panel has no time-window concept at all: both the cache rate and the
  counters are all-time, so there is nothing to ask "which period?" about.
- The live per-response signal continues to live in the activity stream's
  per-row `cached` / `wrote` witnesses and, now, the per-row inline detail — not
  in a sparkline.
- The headline cache percent is a long-run figure: a fresh response barely moves
  it, by design (unchanged from ADR-0004).
