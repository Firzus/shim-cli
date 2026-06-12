import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  type ActivityRow,
  activityCounters,
  activityPage,
  cacheTotals,
  getPlanUsage,
  pendingCount,
  type PlanUsageRecord,
  type PlanUsageSnapshot,
  purgeExpiredActivity,
  RETENTION_MS,
  savePlanUsage,
  shouldPersistUsage,
  sweepPendingActivity,
} from "./state.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Build a throwaway activity table with the columns cacheTotals reads. Rows are
 * inserted in array order, so `id` ascends with the array index.
 */
function seedDb(rows: Array<{ cached: number | null; input: number | null }>): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE activity (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      cached_tokens INTEGER,
      prompt_tokens INTEGER
    );
  `);
  const insert = db.query(
    "INSERT INTO activity (cached_tokens, prompt_tokens) VALUES ($cached, $input)",
  );
  for (const r of rows) insert.run({ $cached: r.cached, $input: r.input });
  return db;
}

test("cacheTotals sums cached and input over all measured rows", () => {
  const db = seedDb([
    { cached: 10, input: 100 },
    { cached: 20, input: 100 },
    { cached: 90, input: 100 },
    { cached: 80, input: 100 },
  ]);
  expect(cacheTotals(db)).toEqual({ cached: 200, input: 400 });
});

test("cacheTotals excludes unmeasured rows (NULL in either token column)", () => {
  const db = seedDb([
    { cached: 90, input: 100 }, // measured
    { cached: null, input: 40_000 }, // cached missing — excluded
    { cached: 50, input: null }, // input missing — excluded
  ]);
  expect(cacheTotals(db)).toEqual({ cached: 90, input: 100 });
});

test("cacheTotals is zeros when no measured rows exist", () => {
  expect(cacheTotals(seedDb([{ cached: null, input: 100 }]))).toEqual({ cached: 0, input: 0 });
  expect(cacheTotals(seedDb([]))).toEqual({ cached: 0, input: 0 });
});

/** Build a throwaway activity table with the columns the page + counters reads need. */
function seedActivity(rows: Array<{ ts: number; status: string }>): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE activity (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      request_id  TEXT,
      provider    TEXT,
      model       TEXT,
      effort      TEXT,
      status      TEXT NOT NULL,
      prompt_tokens     INTEGER,
      completion_tokens INTEGER,
      cached_tokens     INTEGER,
      cache_creation    INTEGER,
      duration_ms INTEGER,
      note        TEXT
    );
  `);
  const insert = db.query("INSERT INTO activity (ts, status) VALUES ($ts, $status)");
  for (const r of rows) insert.run({ $ts: r.ts, $status: r.status });
  return db;
}

test("activityCounters counts all requests and errors", () => {
  const now = 1_000_000_000_000;
  const db = seedActivity([
    { ts: now - 2 * HOUR, status: "ok" },
    { ts: now - 3 * HOUR, status: "error" },
    { ts: now - 4 * HOUR, status: "pending" },
    { ts: now - 10 * HOUR, status: "error" },
  ]);
  expect(activityCounters(db)).toEqual({ requests: 4, errors: 2 });
});

test("activityCounters is zeros on an empty table", () => {
  expect(activityCounters(seedActivity([]))).toEqual({ requests: 0, errors: 0 });
});

test("activityPage returns the newest rows first, limited", () => {
  const now = 1_000_000_000_000;
  const db = seedActivity([
    { ts: now - 4 * HOUR, status: "ok" }, // id 1
    { ts: now - 3 * HOUR, status: "error" }, // id 2
    { ts: now - 2 * HOUR, status: "ok" }, // id 3
    { ts: now - 1 * HOUR, status: "pending" }, // id 4
  ]);
  const page = activityPage(2, undefined, "all", db);
  expect(page.map((r) => r.id)).toEqual([4, 3]);
});

test("activityPage paginates by keyset on id (rows older than the cursor)", () => {
  const now = 1_000_000_000_000;
  const db = seedActivity([
    { ts: now - 4 * HOUR, status: "ok" }, // id 1
    { ts: now - 3 * HOUR, status: "error" }, // id 2
    { ts: now - 2 * HOUR, status: "ok" }, // id 3
    { ts: now - 1 * HOUR, status: "pending" }, // id 4
  ]);
  const page = activityPage(2, 3, "all", db); // rows with id < 3
  expect(page.map((r) => r.id)).toEqual([2, 1]);
});

test("activityPage scopes by status filter", () => {
  const now = 1_000_000_000_000;
  const db = seedActivity([
    { ts: now - 4 * HOUR, status: "ok" }, // id 1
    { ts: now - 3 * HOUR, status: "error" }, // id 2
    { ts: now - 2 * HOUR, status: "pending" }, // id 3
    { ts: now - 1 * HOUR, status: "error" }, // id 4
  ]);
  expect(activityPage(10, undefined, "errors", db).map((r: ActivityRow) => r.id)).toEqual([4, 2]);
  expect(activityPage(10, undefined, "pending", db).map((r: ActivityRow) => r.id)).toEqual([3]);
});

test("pendingCount counts in-flight rows regardless of the window", () => {
  const now = 1_000_000_000_000;
  const db = seedActivity([
    { ts: now - 1 * HOUR, status: "pending" },
    { ts: now - 20 * DAY, status: "pending" }, // old, but still in-flight (point-in-time)
    { ts: now - 1 * HOUR, status: "ok" },
    { ts: now - 1 * HOUR, status: "error" },
  ]);
  expect(pendingCount(db)).toBe(2);
});

test("pendingCount is 0 when nothing is in-flight", () => {
  const now = 1_000_000_000_000;
  const db = seedActivity([{ ts: now - 1 * HOUR, status: "ok" }]);
  expect(pendingCount(db)).toBe(0);
});

test("sweepPendingActivity errors out every pending row and leaves others alone", () => {
  const now = 1_000_000_000_000;
  const db = seedActivity([
    { ts: now - 1 * HOUR, status: "pending" },
    { ts: now - 20 * DAY, status: "pending" },
    { ts: now - 1 * HOUR, status: "ok" },
    { ts: now - 1 * HOUR, status: "error" },
  ]);
  expect(sweepPendingActivity(db)).toBe(2);
  expect(pendingCount(db)).toBe(0);
  expect(activityCounters(db)).toEqual({ requests: 4, errors: 3 });
  const swept = activityPage(10, undefined, "errors", db).find((r) => r.id === 1);
  expect(swept?.note).toBe("interrupted by server restart");
});

test("sweepPendingActivity is a no-op when nothing is pending", () => {
  const now = 1_000_000_000_000;
  const db = seedActivity([{ ts: now - 1 * HOUR, status: "ok" }]);
  expect(sweepPendingActivity(db)).toBe(0);
  expect(activityCounters(db)).toEqual({ requests: 1, errors: 0 });
});

test("purgeExpiredActivity deletes rows past retention and keeps the rest", () => {
  const now = 1_000_000_000_000;
  const db = seedActivity([
    { ts: now - 8 * DAY, status: "ok" }, // id 1 — expired
    { ts: now - 8 * DAY, status: "pending" }, // id 2 — expired, pending is not spared
    { ts: now - 6 * DAY, status: "error" }, // id 3 — retained
    { ts: now - 1 * HOUR, status: "ok" }, // id 4 — retained
  ]);
  expect(purgeExpiredActivity(now, db)).toBe(2);
  expect(activityPage(10, undefined, "all", db).map((r) => r.id)).toEqual([4, 3]);
});

test("purgeExpiredActivity keeps a row exactly at the retention boundary", () => {
  const now = 1_000_000_000_000;
  const db = seedActivity([{ ts: now - RETENTION_MS, status: "ok" }]);
  expect(purgeExpiredActivity(now, db)).toBe(0);
  expect(activityCounters(db)).toEqual({ requests: 1, errors: 0 });
});

test("purgeExpiredActivity is a no-op when everything is within retention", () => {
  const now = 1_000_000_000_000;
  const db = seedActivity([
    { ts: now - 1 * HOUR, status: "ok" },
    { ts: now - 6 * DAY, status: "error" },
  ]);
  expect(purgeExpiredActivity(now, db)).toBe(0);
  expect(activityCounters(db)).toEqual({ requests: 2, errors: 1 });
});

// --- plan usage --------------------------------------------------------------

const SNAP: PlanUsageSnapshot = {
  fiveHour: { utilization: 0.71, resetAt: 1780926000000, status: "allowed" },
  weekly: { utilization: 0.19, resetAt: 1781409600000, status: "allowed" },
};

function rec(capturedAt: number, fiveStatus = "allowed", weekStatus = "allowed"): PlanUsageRecord {
  return {
    capturedAt,
    fiveHour: { ...SNAP.fiveHour, status: fiveStatus },
    weekly: { ...SNAP.weekly, status: weekStatus },
  };
}

test("shouldPersistUsage persists when there is no prior row", () => {
  expect(shouldPersistUsage(null, SNAP, 1000)).toBe(true);
});

test("shouldPersistUsage throttles repeated readings within the window", () => {
  const prev = rec(10_000);
  expect(shouldPersistUsage(prev, SNAP, 10_000 + 4_999)).toBe(false);
  expect(shouldPersistUsage(prev, SNAP, 10_000 + 5_000)).toBe(true); // at the boundary
});

test("shouldPersistUsage always persists on a status change, even within the window", () => {
  const prev = rec(10_000, "allowed", "allowed");
  const throttled = SNAP; // 1s later, normally throttled
  expect(shouldPersistUsage(prev, throttled, 11_000)).toBe(false);
  const fiveChanged = rec(10_000, "rejected", "allowed");
  expect(shouldPersistUsage(fiveChanged, SNAP, 11_000)).toBe(true);
  const weekChanged = rec(10_000, "allowed", "rejected");
  expect(shouldPersistUsage(weekChanged, SNAP, 11_000)).toBe(true);
});

/** In-memory plan_usage table mirroring db.ts. */
function planDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE plan_usage (
      provider           TEXT PRIMARY KEY,
      captured_at        INTEGER NOT NULL,
      fiveh_utilization  REAL NOT NULL,
      fiveh_reset        INTEGER NOT NULL,
      fiveh_status       TEXT NOT NULL,
      weekly_utilization REAL NOT NULL,
      weekly_reset       INTEGER NOT NULL,
      weekly_status      TEXT NOT NULL
    );
  `);
  return db;
}

test("savePlanUsage / getPlanUsage round-trip a snapshot", () => {
  const db = planDb();
  expect(getPlanUsage("claude", db)).toBeNull();
  savePlanUsage("claude", SNAP, 50_000, db);
  expect(getPlanUsage("claude", db)).toEqual({ capturedAt: 50_000, ...SNAP });
});

test("savePlanUsage upserts a single row per provider", () => {
  const db = planDb();
  savePlanUsage("claude", SNAP, 50_000, db);
  const next: PlanUsageSnapshot = {
    fiveHour: { utilization: 0.95, resetAt: 1780930000000, status: "rejected" },
    weekly: { utilization: 0.2, resetAt: 1781409600000, status: "allowed" },
  };
  savePlanUsage("claude", next, 60_000, db);
  expect(getPlanUsage("claude", db)).toEqual({ capturedAt: 60_000, ...next });
  const count = db.query("SELECT COUNT(*) AS n FROM plan_usage").get() as { n: number };
  expect(count.n).toBe(1);
});

test("getPlanUsage isolates rows per provider", () => {
  const db = planDb();
  savePlanUsage("claude", SNAP, 50_000, db);
  expect(getPlanUsage("codex", db)).toBeNull();
});
