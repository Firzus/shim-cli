import { getDb } from "./db.ts";
import type { Effort, ProviderId, Selection } from "../providers/types.ts";

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
    durationMs?: number;
    note?: string;
  },
): void {
  getDb()
    .query(
      `UPDATE activity SET status = $status, prompt_tokens = $pt, completion_tokens = $ct,
         cached_tokens = $cached, duration_ms = $dur, note = $note WHERE id = $id`,
    )
    .run({
      $id: id,
      $status: outcome.status,
      $pt: outcome.promptTokens ?? null,
      $ct: outcome.completionTokens ?? null,
      $cached: outcome.cachedTokens ?? null,
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
 * Token-weighted cache totals across the entire activity table (all statuses).
 * NULL `cached_tokens` (pre-migration rows) count as 0. The session cache rate
 * is `cached / input`.
 */
export function cacheTotals(): { cached: number; input: number } {
  const row = getDb()
    .query(
      `SELECT COALESCE(SUM(cached_tokens), 0) AS cached,
              COALESCE(SUM(prompt_tokens), 0) AS input
         FROM activity`,
    )
    .get() as { cached: number; input: number };
  return { cached: row.cached, input: row.input };
}
