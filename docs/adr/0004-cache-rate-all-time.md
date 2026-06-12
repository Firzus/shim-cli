# 4. Cache rate is all-time, with a bucketed history sparkline

Date: 2026-06-10

## Status

Accepted, then amended by [ADR-0005](./0005-all-time-counters-no-sparkline.md)
(the bucketed sparkline is dropped; the counters become all-time too). Supersedes
[ADR-0003](./0003-cache-rate-request-count-window.md) (the request-count window).

## Context

ADR-0003 scoped the cache rate to the last 20 measured requests so the number
would track *live* efficiency and converge within one Cursor response. In
practice the panel reads better as a long-run efficiency figure: the reference
implementation in `claude-code-to-cursor` aggregates
`cacheHitRate = totalCacheRead / (input + cacheRead + cacheCreation)` over the
whole stored period, and that is the number the operator compares against. A
20-request window also makes the sparkline a 20-glyph live ticker — useful for
spotting one cold write, useless for seeing how efficiency evolved across
sessions. (Issue #45.)

In shim-cli `prompt_tokens` is already normalized to the full input (raw input
+ cache read + cache creation), so the reference formula reduces to
`SUM(cached_tokens) / SUM(prompt_tokens)` over every measured row.

## Decision

Compute the cache rate over **all measured requests in the activity database**
(all-time, across sessions), and bucket the whole history into a fixed glyph
count for the sparkline.

- **One SQL read, `bucketedCacheSamples(buckets)`.** NTILE over insertion order
  splits the measured rows into at most `CACHE_SPARK_BUCKETS = 20` equal-size
  buckets; each bucket returns its summed `(cached, input)`. The aggregation
  runs in SQL — the table grows unbounded and the TUI polls every 400ms, so a
  full-table row fetch into JS is off the table.
- **The aggregate and the sparkline come from the same read.** Bucket sums add
  up to the exact table-wide totals, so the TUI derives the all-time percent
  (`Σcached / Σinput`) and the per-bucket glyphs from one result and the two
  can never disagree — the invariant carried over from ADR-0003's amendment.
- **Label `cache rate (all)`**, replacing `cache rate (last 20)`.
- **No measured rows renders 0%**, matching the reference's empty case.

Carried over from ADR-0003 (still in force):

- **Unmeasured rows are excluded outright** (`WHERE cached_tokens IS NOT NULL
  AND prompt_tokens IS NOT NULL`), never scored as 0% misses.
- **Order by `id`, not `ts`** — monotonic with insertion, no clock dependency.
- **Cache creation is never folded into the rate**; a cold write stays visible
  as the `wrote` witness on the activity row.

## Consequences

- The headline percent is now a stable long-run figure: a fresh response barely
  moves it, by design. The live per-response signal moves to the activity
  stream's per-row `cached`/`wrote` witnesses.
- Each sparkline glyph is a bucket of ~`rows / 20` requests, oldest → newest —
  the shape of efficiency over the whole history. With fewer than 20 measured
  rows, each glyph is a single request.
- The rate ignores the `w` period entirely (so does its label); only the
  counters are windowed.
