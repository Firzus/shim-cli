# 6. Activity rows are retained at most 7 days

Date: 2026-06-11

## Status

Accepted. Qualifies [ADR-0004](./0004-cache-rate-all-time.md) and
[ADR-0005](./0005-all-time-counters-no-sparkline.md): their "all-time" scope
now means *the retained history* — at most the last 7 days.

## Context

The `activity` table records one row per proxied request and, until now, grew
without bound. ADR-0004/0005 made the cache rate and the counters whole-table
aggregates precisely because windowing them in the UI added ambiguity — but an
unbounded table means unbounded growth of a local sqlite file holding
per-request metadata nobody consults beyond recent history. The requirement is
now explicit: stored data must be kept **at most 7 days**.

## Decision

- **Retention, not a query window.** Rows with `ts` older than 7 days
  (`RETENTION_MS`) are **deleted** by `purgeExpiredActivity()`. The read
  queries (`cacheTotals`, `activityCounters`, `activityPage`) stay unwindowed
  whole-table scans — the bound lives in what is stored, not in what is
  queried. The ADR-0005 principle stands: the panel has no time-window concept.
- **The service enforces it.** The purge runs at server startup (next to the
  pending sweep) and on an hourly timer, since the service can outlive the
  retention horizon. The TUI stays a reader and never purges.
- **Pending rows are not spared.** A `pending` row older than 7 days belongs to
  no live request; it is purged like any other. (`finishActivity` on a purged
  id is a harmless no-op `UPDATE`.)
- **Boundary:** `DELETE WHERE ts < now - RETENTION_MS` — a row exactly 7 days
  old is kept. The existing `activity_ts` index covers the predicate.
- `selection` and `plan_usage` are unaffected: both are single-row upserts
  holding only the latest state, not accumulating history.

## Consequences

- The cache rate and the counters read as "over the last 7 days" once the
  store is older than that; labels and queries are unchanged. Docs say
  "retained history" instead of "all-time".
- If the service is down, expired rows linger until its next start — the TUI
  may briefly show slightly more than 7 days. Acceptable: retention is a
  storage bound, not a freshness guarantee.
- The headline cache percent now forgets ancient sessions, so it tracks recent
  efficiency a little closer than the true all-time figure did — still a
  long-run number relative to any single response (ADR-0004's intent holds).
