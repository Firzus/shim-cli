import pc from "picocolors";
import { PORT, SENTINEL_MODEL, TUNNEL_HOSTNAME, TUNNEL_TOKEN } from "./config.ts";
import { startServer } from "./server/server.ts";
import { openTunnel } from "./tunnel.ts";
import { installShutdown, onShutdown } from "./shutdown.ts";
import { runTui } from "./tui/tui.ts";
import { installService, uninstallService } from "./service.ts";
import { allProviders } from "./providers/registry.ts";
import { getSelection } from "./store/state.ts";

const VERSION = "0.1.0";

export async function run(argv: string[]): Promise<void> {
  const cmd = argv[2] ?? "tui";
  switch (cmd) {
    case "serve":
      await serve();
      return;
    case "tui":
    case "":
      await runTui();
      return;
    case "up":
      await installService();
      return;
    case "down":
      await uninstallService();
      return;
    case "status":
      await status();
      return;
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      console.error(`unknown command: ${cmd}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

async function serve(): Promise<void> {
  installShutdown();
  const server = startServer();
  const tunnel = await openTunnel();
  onShutdown(async () => {
    server.stop(true);
    await tunnel.close();
  });

  const base = tunnel.url ? `${tunnel.url}/v1` : `http://127.0.0.1:${PORT}/v1`;
  const tunnelBadge = tunnel.url
    ? tunnel.connected
      ? pc.green("connected")
      : pc.yellow("connecting…")
    : pc.yellow("disabled");
  console.log(pc.bold(pc.cyan("cursor-relay")) + pc.dim(" proxy running"));
  console.log(`  ${pc.dim("Cursor Base URL")}  ${base}`);
  console.log(`  ${pc.dim("Cursor model")}     ${SENTINEL_MODEL}`);
  console.log(`  ${pc.dim("local")}            http://127.0.0.1:${PORT}`);
  console.log(`  ${pc.dim("tunnel")}           ${tunnelBadge}`);
  console.log(pc.dim("\n  Run `cursor-relay` in another terminal to open the control panel."));
}

async function status(): Promise<void> {
  const sel = getSelection();
  console.log(pc.bold("Selection"));
  console.log(`  ${sel.provider} / ${sel.model} / effort ${sel.effort}\n`);

  console.log(pc.bold("Providers"));
  for (const p of allProviders()) {
    const a = await p.authStatus();
    const badge = a.ok ? pc.green("ok") : pc.red("not ready");
    console.log(`  ${p.id.padEnd(8)} ${badge}  ${pc.dim(a.detail)}`);
  }

  console.log("\n" + pc.bold("Tunnel"));
  console.log(`  token     ${TUNNEL_TOKEN ? pc.green("set") : pc.yellow("missing")}`);
  console.log(`  hostname  ${TUNNEL_HOSTNAME || pc.yellow("missing")}`);
}

function printHelp(): void {
  console.log(`cursor-relay - multi-provider (Codex + Claude) OpenAI-compatible proxy for Cursor

Usage: cursor-relay [command]

Commands:
  (default)  Open the TUI control panel (switch provider/model/effort, watch activity)
  serve      Run the proxy server + Cloudflare tunnel in the foreground
  up         Install the Windows scheduled task (auto-start at logon)
  down       Remove the scheduled task
  status     Show selection, provider auth, and tunnel config
  version    Print the version
  help       Show this help

Env:
  PORT                        Local HTTP port (default 8787)
  DEBUG_LOG                   Set to 1 for verbose SSE/tunnel logs
  CLOUDFLARE_TUNNEL_TOKEN     Named Cloudflare tunnel token (required for Cursor)
  CLOUDFLARE_TUNNEL_HOSTNAME  Public hostname for the named tunnel`);
}
