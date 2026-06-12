import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";

const HOME = homedir();

/** Runtime state lives under ~/.cursor-relay/. */
export const CURSOR_RELAY_DIR = join(HOME, ".cursor-relay");
export const LEGACY_SHIM_DIR = join(HOME, ".shim");
export const DB_PATH = join(CURSOR_RELAY_DIR, "cursor-relay.db");
export const LOG_FILE = join(CURSOR_RELAY_DIR, "service.log");

interface RuntimeStateDirs {
  currentDir: string;
  legacyDir: string;
}

const LEGACY_RENAMES: Record<string, string> = {
  "shim.db": "cursor-relay.db",
  "shim.db-shm": "cursor-relay.db-shm",
  "shim.db-wal": "cursor-relay.db-wal",
};

/**
 * Move runtime state from the pre-rebrand ~/.shim directory into
 * ~/.cursor-relay. Existing target files win; conflicted legacy files are left
 * in place instead of being overwritten.
 */
export function migrateLegacyRuntimeState(
  dirs: RuntimeStateDirs = { currentDir: CURSOR_RELAY_DIR, legacyDir: LEGACY_SHIM_DIR },
): void {
  if (!existsSync(dirs.currentDir) && existsSync(dirs.legacyDir)) {
    renameSync(dirs.legacyDir, dirs.currentDir);
  }

  mkdirSync(dirs.currentDir, { recursive: true });
  if (!existsSync(dirs.legacyDir)) {
    renameLegacyFilesInsideCurrentDir(dirs.currentDir);
    return;
  }

  for (const entry of readdirSync(dirs.legacyDir)) {
    const targetName = LEGACY_RENAMES[entry] ?? entry;
    const from = join(dirs.legacyDir, entry);
    const to = join(dirs.currentDir, targetName);
    if (!existsSync(to)) renameSync(from, to);
  }
  renameLegacyFilesInsideCurrentDir(dirs.currentDir);

  try {
    rmdirSync(dirs.legacyDir);
  } catch {
    // Keep a non-empty legacy directory rather than deleting conflicted files.
  }
}

function renameLegacyFilesInsideCurrentDir(currentDir: string): void {
  for (const [legacyName, currentName] of Object.entries(LEGACY_RENAMES)) {
    const from = join(currentDir, legacyName);
    const to = join(currentDir, currentName);
    if (existsSync(from) && !existsSync(to)) renameSync(from, to);
  }
}

/** Provider credential sources, reused from the official CLIs. */
export const CLAUDE_CREDENTIALS = join(HOME, ".claude", ".credentials.json");
export const CODEX_AUTH = join(HOME, ".codex", "auth.json");
