import { LOG_FILE } from "./paths.ts";

/**
 * Windows scheduled-task integration: run `shim serve` at logon in the
 * background. The TUI (`shim`) attaches separately and controls the running
 * service through the shared sqlite store.
 */

const TASK_NAME = "ShimCliProxy";

function serveCommand(): string {
  // process.execPath is the bun binary; argv[1] is this script's entry.
  const bun = process.execPath;
  const entry = Bun.fileURLToPath(new URL("./index.ts", import.meta.url));
  return `"${bun}" "${entry}" serve`;
}

async function run(cmd: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, out: (out + err).trim() };
}

export async function installService(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("service install is Windows-only");
  }
  const { code, out } = await run([
    "schtasks",
    "/Create",
    "/F",
    "/SC",
    "ONLOGON",
    "/TN",
    TASK_NAME,
    "/TR",
    serveCommand(),
  ]);
  if (code !== 0) throw new Error(`schtasks create failed: ${out}`);
  console.log(`[shim] scheduled task "${TASK_NAME}" installed (runs at logon). Logs: ${LOG_FILE}`);
}

export async function uninstallService(): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("service uninstall is Windows-only");
  }
  const { code, out } = await run(["schtasks", "/Delete", "/F", "/TN", TASK_NAME]);
  if (code !== 0) throw new Error(`schtasks delete failed: ${out}`);
  console.log(`[shim] scheduled task "${TASK_NAME}" removed.`);
}
