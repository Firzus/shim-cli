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
      duration_ms       INTEGER,
      note              TEXT
    );
    CREATE INDEX IF NOT EXISTS activity_ts ON activity (ts DESC);
  `);
  db = d;
  return d;
}
