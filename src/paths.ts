import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();

/** Runtime state lives under ~/.shim/. */
export const SHIM_DIR = join(HOME, ".shim");
export const DB_PATH = join(SHIM_DIR, "shim.db");
export const LOG_FILE = join(SHIM_DIR, "service.log");

/** Provider credential sources, reused from the official CLIs. */
export const CLAUDE_CREDENTIALS = join(HOME, ".claude", ".credentials.json");
export const CODEX_AUTH = join(HOME, ".codex", "auth.json");
