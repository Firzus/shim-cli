import type { Database } from "bun:sqlite";
import { getDb } from "./db.ts";
import type { Effort, ProviderId, Selection } from "../providers/types.ts";

/** Selectable cache-rate windows, ordered for cycling in the TUI. */
export const PERIODS = ["5h", "24h", "7d", "30d", "all"] as const;
export type Period = (typeof PERIODS)[number];

/** Counters window to 24h by default — recent enough to read the live signal. */
export const DEFAULT_PERIOD: Period = "24h";

/**
 * Cache rate is scoped to the last N *measured* requests, not a time window. One
 * Cursor response is a burst of proxy requests, so a request-count window
 * converges within a single response and never lingers behind stale history the
 * way a time window does. See ADR-0003.
 */
export const CACHE_RATE_SAMPLE = 20;

const PERIOD_MS: Record<Exclude<Period, "all">, number> = {
  "5h": 5 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/**
 * Epoch (ms) lower bound for a period window, given the current time. `all`
 * maps to 0 — no bound, the whole table. Pure: `now` is injected so callers
 * (and tests) control the reference point.
 */
export function periodSince(period: Period, now: number): number {
  if (period === "all") return 0;
  return now - PERIOD_MS[period];
}

/** Next period in the cycle order, wrapping `all` back to `5h`. */
export function nextPeriod(period: Period): Period {
  const i = PERIODS.indexOf(period);
  return PERIODS[(i + 1) % PERIODS.length] as Period;
}

/** Used the first time the store is opened with no selection yet. */
export const DEFAULT_SELECTION: Selection = {
  provider: "claude",
  model: "claude-sonnet-4-6",
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
  return { provider: row.provider as ProviderId, model: row.model, effort: row.effort as Effort };
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

export function recentActivity(limit = 50): ActivityRow[] {
  return getDb()
    .query("SELECT * FROM activity ORDER BY id DESC LIMIT $limit")
    .all({ $limit: limit }) as ActivityRow[];
}

/**
 * Token-weighted cache totals over the last `n` **measured** requests (newest
 * by id). A row is measured only when both token columns are present; a NULL in
 * either is *unmeasured* — a pending request, or one recorded by an older build
 * that never reported cache tokens — and is excluded outright, not counted as a
 * 0% miss that would drag the rate down. The cache rate is `cached / input`.
 * `db` is injectable for tests against a temporary database. See ADR-0003.
 */
export function cacheTotalsRecent(
  n = CACHE_RATE_SAMPLE,
  db: Database = getDb(),
): { cached: number; input: number } {
  const row = db
    .query(
      `SELECT COALESCE(SUM(cached_tokens), 0) AS cached,
              COALESCE(SUM(prompt_tokens), 0) AS input
         FROM (SELECT cached_tokens, prompt_tokens FROM activity
                WHERE cached_tokens IS NOT NULL AND prompt_tokens IS NOT NULL
                ORDER BY id DESC LIMIT $n)`,
    )
    .get({ $n: n }) as { cached: number; input: number };
  return { cached: row.cached, input: row.input };
}

/**
 * Request + error counts over a bounded window — rows with `ts >= since`.
 * `requests` is every row in the window (all statuses); `errors` is the subset
 * with `status = 'error'`. The `w` period scopes these counters only; the cache
 * rate is request-count scoped (see [[cacheTotalsRecent]]). Pass `since = 0` for
 * the whole table. `db` is injectable for tests against a temporary database.
 */
export function windowedCounters(
  since = 0,
  db: Database = getDb(),
): { requests: number; errors: number } {
  const row = db
    .query(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors
         FROM activity WHERE ts >= $since`,
    )
    .get({ $since: since }) as { requests: number; errors: number };
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
