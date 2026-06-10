import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  bucketedCacheSamples,
  CACHE_SPARK_BUCKETS,
  DEFAULT_PERIOD,
  getPlanUsage,
  nextPeriod,
  pendingCount,
  type Period,
  type PlanUsageRecord,
  type PlanUsageSnapshot,
  periodSince,
  savePlanUsage,
  shouldPersistUsage,
  windowedCounters,
} from "./state.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test("periodSince maps fixed windows to their epoch lower bound", () => {
  const now = 1_000_000_000_000;
  expect(periodSince("5h", now)).toBe(now - 5 * HOUR);
  expect(periodSince("24h", now)).toBe(now - DAY);
  expect(periodSince("7d", now)).toBe(now - 7 * DAY);
  expect(periodSince("30d", now)).toBe(now - 30 * DAY);
});

test("periodSince maps 'all' to 0 regardless of now", () => {
  expect(periodSince("all", 1_000_000_000_000)).toBe(0);
  expect(periodSince("all", 0)).toBe(0);
});

test("nextPeriod cycles 5h → 24h → 7d → 30d → all → 5h", () => {
  const order: Period[] = [];
  let p: Period = "5h";
  for (let i = 0; i < 5; i++) {
    order.push(p);
    p = nextPeriod(p);
  }
  expect(order).toEqual(["5h", "24h", "7d", "30d", "all"]);
  expect(nextPeriod("all")).toBe("5h"); // wraps
});

test("the default launch period is 24h", () => {
  expect(DEFAULT_PERIOD).toBe("24h");
});

/**
 * Build a throwaway activity table with the columns bucketedCacheSamples reads.
 * Rows are inserted in array order, so `id` ascends with the array index —
 * the last array entry is the newest request.
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

test("the cache-rate sparkline is 20 glyphs wide", () => {
  expect(CACHE_SPARK_BUCKETS).toBe(20);
});

test("bucketedCacheSamples sums the whole history into equal-size buckets, oldest → newest", () => {
  // 4 measured rows into 2 buckets: [oldest two] then [newest two], each
  // carrying that bucket's summed tokens — the aggregation runs in SQL.
  const db = seedDb([
    { cached: 10, input: 100 }, // oldest
    { cached: 20, input: 100 },
    { cached: 90, input: 100 },
    { cached: 80, input: 100 }, // newest
  ]);
  expect(bucketedCacheSamples(2, db)).toEqual([
    { cached: 30, input: 200 },
    { cached: 170, input: 200 },
  ]);
});

test("bucketedCacheSamples bucket sums add up to the exact all-time totals", () => {
  // The TUI derives the aggregate rate from the bucket sums, so they must
  // reconstruct the table-wide totals regardless of how rows split into buckets.
  const rows = [11, 23, 35, 47, 59, 61, 73].map((c, i) => ({ cached: c, input: 100 + i }));
  const db = seedDb(rows);
  const samples = bucketedCacheSamples(3, db);
  expect(samples.reduce((s, b) => s + b.cached, 0)).toBe(rows.reduce((s, r) => s + r.cached, 0));
  expect(samples.reduce((s, b) => s + b.input, 0)).toBe(rows.reduce((s, r) => s + r.input, 0));
});

test("bucketedCacheSamples returns one bucket per row when rows are fewer than buckets", () => {
  const db = seedDb([
    { cached: 10, input: 100 }, // oldest
    { cached: 90, input: 100 }, // newest
  ]);
  expect(bucketedCacheSamples(20, db)).toEqual([
    { cached: 10, input: 100 },
    { cached: 90, input: 100 },
  ]);
});

test("bucketedCacheSamples excludes unmeasured rows instead of scoring them 0%", () => {
  // A NULL cached_tokens row is unmeasured (pending, or an old build that never
  // reported) — it must not enter the history as a 0% miss.
  const db = seedDb([
    { cached: 90, input: 100 }, // measured, 90%
    { cached: null, input: 40_000 }, // unmeasured — excluded outright
  ]);
  expect(bucketedCacheSamples(20, db)).toEqual([{ cached: 90, input: 100 }]); // 90%, not ~0%
});

test("bucketedCacheSamples excludes a row with a NULL prompt_tokens too", () => {
  // A measured cached count but a missing denominator is still unmeasured — it
  // must not contribute a numerator without a matching input.
  const db = seedDb([
    { cached: 90, input: 100 }, // fully measured
    { cached: 50, input: null }, // cached present, input missing — excluded
  ]);
  expect(bucketedCacheSamples(20, db)).toEqual([{ cached: 90, input: 100 }]);
});

test("bucketedCacheSamples is empty when no measured rows exist", () => {
  const db = seedDb([{ cached: null, input: 100 }]);
  expect(bucketedCacheSamples(20, db)).toEqual([]);
  expect(bucketedCacheSamples(20, seedDb([]))).toEqual([]);
});

/** Build a throwaway activity table with the columns the counters reads need. */
function seedActivity(rows: Array<{ ts: number; status: string }>): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE activity (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      ts     INTEGER NOT NULL,
      status TEXT NOT NULL
    );
  `);
  const insert = db.query("INSERT INTO activity (ts, status) VALUES ($ts, $status)");
  for (const r of rows) insert.run({ $ts: r.ts, $status: r.status });
  return db;
}

test("windowedCounters counts requests and errors only inside the window", () => {
  const now = 1_000_000_000_000;
  const db = seedActivity([
    { ts: now - 2 * HOUR, status: "ok" }, // inside
    { ts: now - 3 * HOUR, status: "error" }, // inside
    { ts: now - 4 * HOUR, status: "pending" }, // inside
    { ts: now - 10 * HOUR, status: "error" }, // outside 5h
  ]);
  expect(windowedCounters(periodSince("5h", now), db)).toEqual({ requests: 3, errors: 1 });
  expect(windowedCounters(periodSince("all", now), db)).toEqual({ requests: 4, errors: 2 });
});

test("windowedCounters is zeros on an empty window", () => {
  const now = 1_000_000_000_000;
  const db = seedActivity([{ ts: now - 2 * HOUR, status: "ok" }]);
  expect(windowedCounters(now + DAY, db)).toEqual({ requests: 0, errors: 0 });
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
