import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { DB_PATH, SHIM_DIR } from "../paths.ts";

let db: Database | null = null;

/** Open (and migrate) the shared sqlite store. Idempotent; cached per process. */
export function getDb(): Database {
  if (db) return db;
  mkdirSync(SHIM_DIR, { recursive: true });
  const d = new Database(DB_PATH, { create: true });
  // WAL lets the service and the TUI read/write concurrently without locking.
  d.exec("PRAGMA journal_mode = WAL;");
  d.exec("PRAGMA busy_timeout = 5000;");
  d.exec(`
    CREATE TABLE IF NOT EXISTS selection (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      provider   TEXT NOT NULL,
      model      TEXT NOT NULL,
      effort     TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      ts                INTEGER NOT NULL,
      request_id        TEXT NOT NULL,
      provider          TEXT NOT NULL,
      model             TEXT NOT NULL,
      effort            TEXT NOT NULL,
      status            TEXT NOT NULL,
      prompt_tokens     INTEGER,
      completion_tokens INTEGER,
      cached_tokens     INTEGER,
      cache_creation    INTEGER,
      duration_ms       INTEGER,
      note              TEXT
    );
    CREATE INDEX IF NOT EXISTS activity_ts ON activity (ts DESC);
    CREATE TABLE IF NOT EXISTS plan_usage (
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
  migrateActivityColumns(d);
  db = d;
  return d;
}

/**
 * Add columns introduced after a database was first created. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so each addition is guarded by a PRAGMA check —
 * keeping pre-existing databases migrated without data loss.
 */
function migrateActivityColumns(d: Database): void {
  const existing = new Set(
    (d.query("PRAGMA table_info(activity)").all() as { name: string }[]).map((c) => c.name),
  );
  if (!existing.has("cached_tokens")) {
    d.exec("ALTER TABLE activity ADD COLUMN cached_tokens INTEGER;");
  }
  // `cache_creation` (cold cache write) lands separately from `cached_tokens`
  // (cache read); existing rows keep NULL = unmeasured. See issue #27.
  if (!existing.has("cache_creation")) {
    d.exec("ALTER TABLE activity ADD COLUMN cache_creation INTEGER;");
  }
}
