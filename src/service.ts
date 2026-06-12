import { spawnSync } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PORT } from "./config.ts";
import { CURSOR_RELAY_DIR, LOG_FILE, migrateLegacyRuntimeState } from "./paths.ts";

/**
 * Windows scheduled-task integration: run `cursor-relay serve` at logon in the
 * background. The TUI (`cursor-relay`) attaches separately and controls the running
 * service through the shared sqlite store.
 *
 * The task launches a hidden `.vbs` → `runner.cmd` chain rather than bun
 * directly, which: (1) `cd`s to the project root so Bun can load `.env`
 * (scheduled tasks start from System32), (2) redirects output to LOG_FILE, and
 * (3) runs with no visible console window.
 */

const TASK_NAME = "CursorRelayProxy";
const LEGACY_TASK_NAME = "ShimCliProxy";
const RUNNER_CMD = join(CURSOR_RELAY_DIR, "runner.cmd");
const LAUNCHER_VBS = join(CURSOR_RELAY_DIR, "launcher.vbs");

/** PID from the port-probe output, or null when free / invalid / self / a system pid. Pure. */
export function parsePortOwnerPid(raw: string, selfPid: number): number | null {
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(pid) || pid <= 4 || pid === selfPid) return null;
  return pid;
}

/**
 * Kill whatever process tree still owns the proxy port. `schtasks /End` stops
 * the launcher chain (vbs → cmd) but NOT the child bun server: the orphan keeps
 * the port, keeps serving the code it loaded at start, and the next `/Run`
 * silently fails to bind — restarts restart nothing. Killing the owner's tree
 * (`taskkill /T`) also reaps its cloudflared child. No-op when the port is
 * free; never targets this process or a system pid.
 */
export function killPortOwner(port = PORT): void {
  const probe = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
    ],
    { encoding: "utf8" },
  );
  const pid = parsePortOwnerPid(probe.stdout ?? "", process.pid);
  if (pid == null) return;
  const kill = spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { encoding: "utf8" });
  if (kill.status === 0) {
    console.log(`[cursor-relay] killed stale server process tree on port ${port} (pid ${pid}).`);
  } else {
    console.log(
      `[cursor-relay] could not kill pid ${pid} on port ${port}: ${trimOutput(kill.stderr || kill.stdout || "unknown error")}`,
    );
  }
}

export async function installService(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("service install is Windows-only");
  }
  migrateLegacyRuntimeState();
  await mkdir(CURSOR_RELAY_DIR, { recursive: true });
  removeScheduledTask(LEGACY_TASK_NAME);

  const bunPath = process.execPath;
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
  // Scheduled tasks start from System32; run from the project root so Bun loads `.env`.
  const projectRoot = resolve(dirname(entry), "..");

  const runnerContent =
    `@echo off\r\n` +
    `cd /D "${projectRoot}"\r\n` +
    `"${bunPath}" run "${entry}" serve >> "${LOG_FILE}" 2>&1\r\n`;
  await writeFile(RUNNER_CMD, runnerContent, "utf8");

  const vbsContent =
    `Set WshShell = CreateObject("WScript.Shell")\r\n` +
    `WshShell.Run """${RUNNER_CMD}""", 0, False\r\n`;
  await writeFile(LAUNCHER_VBS, vbsContent, "utf8");

  const taskAction = `wscript.exe "${LAUNCHER_VBS}"`;
  const create = spawnSync(
    "schtasks",
    ["/Create", "/TN", TASK_NAME, "/TR", taskAction, "/SC", "ONLOGON", "/F"],
    { encoding: "utf8" },
  );
  if (create.status !== 0) {
    throw new Error(formatSchtasksError("/Create", create.stderr || create.stdout));
  }

  // A previous instance (or an orphan left by `schtasks /End`) would keep the
  // port and make the fresh run a silent no-op — free it first.
  killPortOwner();
  const run = spawnSync("schtasks", ["/Run", "/TN", TASK_NAME], { encoding: "utf8" });
  console.log(
    `[cursor-relay] scheduled task "${TASK_NAME}" installed (auto-start at logon). Logs: ${LOG_FILE}`,
  );
  if (run.status === 0) {
    console.log("[cursor-relay] service started now (running in the background).");
  } else {
    console.log(
      `[cursor-relay] task created but failed to start now: ${trimOutput(run.stderr || run.stdout || "unknown error")}`,
    );
    console.log(`[cursor-relay] it will start on next logon, or run: schtasks /Run /TN ${TASK_NAME}`);
  }
}

export async function uninstallService(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("service uninstall is Windows-only");
  }
  spawnSync("schtasks", ["/End", "/TN", TASK_NAME], { encoding: "utf8" });
  spawnSync("schtasks", ["/End", "/TN", LEGACY_TASK_NAME], { encoding: "utf8" });
  // `/End` stops the launcher chain only; the bun server survives as an orphan.
  killPortOwner();
  deleteScheduledTaskOrThrow(TASK_NAME);
  removeScheduledTask(LEGACY_TASK_NAME);
  await safeUnlink(LAUNCHER_VBS);
  await safeUnlink(RUNNER_CMD);
  console.log(`[cursor-relay] scheduled task "${TASK_NAME}" removed.`);
}

function removeScheduledTask(taskName: string): void {
  spawnSync("schtasks", ["/End", "/TN", taskName], { encoding: "utf8" });
  const del = spawnSync("schtasks", ["/Delete", "/TN", taskName, "/F"], { encoding: "utf8" });
  if (del.status === 0 || isTaskNotFound(del.stderr || del.stdout)) return;
  console.log(
    `[cursor-relay] could not remove legacy scheduled task "${taskName}": ${trimOutput(del.stderr || del.stdout || "unknown error")}`,
  );
}

function deleteScheduledTaskOrThrow(taskName: string): void {
  const del = spawnSync("schtasks", ["/Delete", "/TN", taskName, "/F"], { encoding: "utf8" });
  if (del.status === 0 || isTaskNotFound(del.stderr || del.stdout)) return;
  throw new Error(formatSchtasksError("/Delete", del.stderr || del.stdout));
}

function isTaskNotFound(raw: string): boolean {
  const out = raw.toLowerCase();
  return out.includes("does not exist") || out.includes("cannot find") || out.includes("the system cannot find");
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

function trimOutput(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

function formatSchtasksError(op: string, raw: string): string {
  const trimmed = trimOutput(raw);
  const lower = trimmed.toLowerCase();
  const denied =
    lower.includes("access is denied") ||
    lower.includes("access denied") ||
    trimmed.includes("Accès refusé") ||
    trimmed.includes("acces refuse");
  if (denied) {
    return `schtasks ${op} refused (Access denied). Re-run this command in a PowerShell launched as Administrator.`;
  }
  return `schtasks ${op} failed: ${trimmed}`;
}
