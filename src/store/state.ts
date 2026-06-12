import type { Database } from "bun:sqlite";
import { getDb } from "./db.ts";
import type { Effort, ProviderId, Selection } from "../providers/types.ts";

/** Used the first time the store is opened with no selection yet. */
export const DEFAULT_SELECTION: Selection = {
  provider: "claude",
  model: "claude-opus-4-8",
  effort: "medium",
};

export function getSelection(): Selection {
  const row = getDb()
    .query("SELECT provider, model, effort FROM selection WHERE id = 1")
    .get() as { provider: string; model: string; effort: string } | null;
  if (!row) {
    setSelection(DEFAULT_SELECTION);
    return { ...DEFAULT_SELECTION };
  }
  return { provider: row.provider as ProviderId, model: row.model, effort: normalizeEffort(row.effort) };
}

function normalizeEffort(effort: string): Effort {
  return effort === "extra" ? "xhigh" : (effort as Effort);
}

export function setSelection(sel: Selection): void {
  getDb()
    .query(
      `INSERT INTO selection (id, provider, model, effort, updated_at)
       VALUES (1, $provider, $model, $effort, $ts)
       ON CONFLICT(id) DO UPDATE SET
         provider = $provider, model = $model, effort = $effort, updated_at = $ts`,
    )
    .run({ $provider: sel.provider, $model: sel.model, $effort: sel.effort, $ts: Date.now() });
}

export interface ActivityRow {
  id: number;
  ts: number;
  request_id: string;
  provider: string;
  model: string;
  effort: string;
  status: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  cache_creation: number | null;
  duration_ms: number | null;
  note: string | null;
}

/** Insert an in-flight activity row and return its id. */
export function startActivity(input: {
  requestId: string;
  provider: string;
  model: string;
  effort: string;
}): number {
  const res = getDb()
    .query(
      `INSERT INTO activity (ts, request_id, provider, model, effort, status)
       VALUES ($ts, $rid, $provider, $model, $effort, 'pending')`,
    )
    .run({
      $ts: Date.now(),
      $rid: input.requestId,
      $provider: input.provider,
      $model: input.model,
      $effort: input.effort,
    });
  return Number(res.lastInsertRowid);
}

/** Finalize an activity row with outcome + token counts. */
export function finishActivity(
  id: number,
  outcome: {
    status: string;
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
    cacheCreationTokens?: number;
    durationMs?: number;
    note?: string;
  },
): void {
  getDb()
    .query(
      `UPDATE activity SET status = $status, prompt_tokens = $pt, completion_tokens = $ct,
         cached_tokens = $cached, cache_creation = $creation, duration_ms = $dur, note = $note
         WHERE id = $id`,
    )
    .run({
      $id: id,
      $status: outcome.status,
      $pt: outcome.promptTokens ?? null,
      $ct: outcome.completionTokens ?? null,
      $cached: outcome.cachedTokens ?? null,
      $creation: outcome.cacheCreationTokens ?? null,
      $dur: outcome.durationMs ?? null,
      $note: outcome.note ?? null,
    });
}

/**
 * Mark every `pending` row as errored. Call only from the server at startup:
 * no request survives a process restart, so any row still pending belongs to a
 * previous instance that died mid-stream and would otherwise count as
 * in-flight forever. Returns the number of rows swept. `db` is injectable for
 * tests.
 */
export function sweepPendingActivity(db: Database = getDb()): number {
  const res = db
    .query(
      `UPDATE activity SET status = 'error', note = 'interrupted by server restart'
         WHERE status = 'pending'`,
    )
    .run();
  return Number(res.changes);
}

/** Activity rows older than this are purged — the store keeps at most 7 days. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete every activity row older than `RETENTION_MS`. The service runs this at
 * startup and on a periodic timer, so the table never holds more than ~7 days
 * of history (see ADR-0006). A `pending` row that old belongs to no live
 * request and is purged like any other. The `activity_ts` index covers the
 * predicate. Returns the number of rows purged. `db` is injectable for tests.
 */
export function purgeExpiredActivity(now: number = Date.now(), db: Database = getDb()): number {
  const res = db
    .query("DELETE FROM activity WHERE ts < $cutoff")
    .run({ $cutoff: now - RETENTION_MS });
  return Number(res.changes);
}

/** The status filter applied to an activity page, cycled by the `f` key in the TUI. */
export type ActivityFilter = "all" | "errors" | "pending";

/**
 * One keyset page of activity rows, newest → oldest. `cursor` is the exclusive
 * upper bound on `id` (rows with `id < cursor`); pass `undefined` for the first
 * page (the newest rows). `filter` scopes by status: `all` (every row),
 * `errors` (`status = 'error'`), or `pending` (`status = 'pending'`). Keyset
 * pagination on the primary key needs no extra index and is stable as new rows
 * arrive at the head. `db` is injectable for tests.
 */
export function activityPage(
  limit: number,
  cursor?: number,
  filter: ActivityFilter = "all",
  db: Database = getDb(),
): ActivityRow[] {
  const statusClause = filter === "errors" ? "AND status = 'error'" : filter === "pending" ? "AND status = 'pending'" : "";
  const cursorClause = cursor != null ? "AND id < $cursor" : "";
  return db
    .query(
      `SELECT * FROM activity
        WHERE 1 = 1 ${cursorClause} ${statusClause}
        ORDER BY id DESC LIMIT $limit`,
    )
    .all({ $limit: limit, ...(cursor != null ? { $cursor: cursor } : {}) }) as ActivityRow[];
}

/** The cache-rate inputs: summed cached + prompt tokens over all measured rows. */
export interface CacheTotals {
  cached: number;
  input: number;
}

/**
 * Cache totals over the retained history: `Σcached_tokens / Σprompt_tokens`
 * over every *measured* row (both token columns present). A NULL in either
 * column is unmeasured — a pending request, or one recorded by an older build
 * that never reported cache tokens — and is excluded outright, not counted as
 * a 0% miss that would drag the rate down. The query stays unwindowed; the
 * 7-day bound comes from retention purging old rows (ADR-0006). The
 * aggregation runs in SQL (the TUI polls frequently). `db` is injectable for
 * tests. See ADR-0004.
 */
export function cacheTotals(db: Database = getDb()): CacheTotals {
  const row = db
    .query(
      `SELECT COALESCE(SUM(cached_tokens), 0) AS cached,
              COALESCE(SUM(prompt_tokens), 0) AS input
         FROM activity
        WHERE cached_tokens IS NOT NULL AND prompt_tokens IS NOT NULL`,
    )
    .get() as CacheTotals;
  return { cached: row.cached, input: row.input };
}

/**
 * Request + error counts over the retained history. `requests` is every row;
 * `errors` is the subset with `status = 'error'`. Neither the cache rate nor
 * these counters carry a time window — the queries scan the whole table, and
 * the 7-day bound comes from retention (ADR-0006). `db` is injectable for
 * tests against a temporary database.
 */
export function activityCounters(db: Database = getDb()): { requests: number; errors: number } {
  const row = db
    .query(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors
         FROM activity`,
    )
    .get() as { requests: number; errors: number };
  return { requests: row.requests, errors: row.errors };
}

/**
 * Point-in-time count of in-flight (`pending`) requests — current load, not a
 * windowed metric, so it ignores any period. `db` is injectable for tests.
 */
export function pendingCount(db: Database = getDb()): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM activity WHERE status = 'pending'")
    .get() as { n: number };
  return row.n;
}

// --- plan usage (subscription consumption, from Anthropic headers) -----------

/** One rate-limit window: normalized utilization fraction + reset + status. */
export interface PlanWindow {
  /** 0–1 fraction (Anthropic's percent-as-fraction; e.g. 0.71 = 71%). */
  utilization: number;
  /** Epoch ms when this window resets. */
  resetAt: number;
  /** Anthropic status enum, e.g. "allowed". */
  status: string;
}

/** A plan-usage reading: the 5h + weekly windows captured from one response. */
export interface PlanUsageSnapshot {
  fiveHour: PlanWindow;
  weekly: PlanWindow;
}

/** A persisted snapshot, carrying when it was captured. */
export interface PlanUsageRecord extends PlanUsageSnapshot {
  /** Epoch ms of capture. */
  capturedAt: number;
}

/** Persist no more than one row per provider per this interval (unless status changes). */
export const USAGE_THROTTLE_MS = 5000;

/**
 * Throttle decision for plan-usage capture. Pure. Persist when there is no
 * prior row, when either window's status changed (a state transition is always
 * worth recording), or when the last persist is at least `USAGE_THROTTLE_MS`
 * old. Otherwise skip — the headers arrive on every response and barely move.
 */
export function shouldPersistUsage(
  prev: PlanUsageRecord | null,
  next: PlanUsageSnapshot,
  now: number,
): boolean {
  if (!prev) return true;
  if (prev.fiveHour.status !== next.fiveHour.status) return true;
  if (prev.weekly.status !== next.weekly.status) return true;
  return now - prev.capturedAt >= USAGE_THROTTLE_MS;
}

interface PlanUsageDbRow {
  captured_at: number;
  fiveh_utilization: number;
  fiveh_reset: number;
  fiveh_status: string;
  weekly_utilization: number;
  weekly_reset: number;
  weekly_status: string;
}

/** Read the latest plan-usage snapshot for a provider, or null if none stored. */
export function getPlanUsage(provider: string, db: Database = getDb()): PlanUsageRecord | null {
  const row = db
    .query(
      `SELECT captured_at, fiveh_utilization, fiveh_reset, fiveh_status,
              weekly_utilization, weekly_reset, weekly_status
         FROM plan_usage WHERE provider = $p`,
    )
    .get({ $p: provider }) as PlanUsageDbRow | null;
  if (!row) return null;
  return {
    capturedAt: row.captured_at,
    fiveHour: { utilization: row.fiveh_utilization, resetAt: row.fiveh_reset, status: row.fiveh_status },
    weekly: { utilization: row.weekly_utilization, resetAt: row.weekly_reset, status: row.weekly_status },
  };
}

/** Upsert the single plan-usage row for a provider. */
export function savePlanUsage(
  provider: string,
  snap: PlanUsageSnapshot,
  now: number,
  db: Database = getDb(),
): void {
  db.query(
    `INSERT INTO plan_usage (
       provider, captured_at,
       fiveh_utilization, fiveh_reset, fiveh_status,
       weekly_utilization, weekly_reset, weekly_status
     ) VALUES ($p, $ts, $fu, $fr, $fs, $wu, $wr, $ws)
     ON CONFLICT(provider) DO UPDATE SET
       captured_at = $ts,
       fiveh_utilization = $fu, fiveh_reset = $fr, fiveh_status = $fs,
       weekly_utilization = $wu, weekly_reset = $wr, weekly_status = $ws`,
  ).run({
    $p: provider,
    $ts: now,
    $fu: snap.fiveHour.utilization,
    $fr: snap.fiveHour.resetAt,
    $fs: snap.fiveHour.status,
    $wu: snap.weekly.utilization,
    $wr: snap.weekly.resetAt,
    $ws: snap.weekly.status,
  });
}

/**
 * Capture a plan-usage snapshot, throttled. Reads the prior row, applies
 * `shouldPersistUsage`, and upserts only when warranted. Impure orchestrator;
 * the decision and persistence pieces are independently testable above.
 */
export function recordPlanUsage(provider: string, snap: PlanUsageSnapshot, now = Date.now()): void {
  const prev = getPlanUsage(provider);
  if (shouldPersistUsage(prev, snap, now)) savePlanUsage(provider, snap, now);
}
