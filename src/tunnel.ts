import { existsSync } from "node:fs";
import { Tunnel as CfTunnel, bin, install } from "cloudflared";
import { DEBUG_LOG, PORT, TUNNEL_HOSTNAME, TUNNEL_TOKEN } from "./config.ts";

const TUNNEL_READY_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 2_000;

export interface TunnelHandle {
  /** Public base URL Cursor should target (e.g. https://host), or null when disabled. */
  readonly url: string | null;
  readonly connected: boolean;
  close(): Promise<void>;
}

/**
 * Open the Cloudflare named tunnel that fronts the local server.
 *
 * Cursor routes BYOK requests through its cloud backend, so a localhost URL is
 * rejected — a public hostname is required. We drive cloudflared through the
 * `cloudflared` npm package: it auto-installs the binary, exposes connection
 * events, and `stop()` tears the process down cleanly (no orphaned workers).
 *
 * A named tunnel's public URL is fixed by its hostname, so it is known before
 * cloudflared finishes dialing the edge. We treat the edge connection as
 * best-effort and self-healing: a slow/offline network at boot must never bring
 * the local proxy down.
 *
 * When no token is configured we warn and run server-only (useful for local
 * tests, but Cursor's cloud will not be able to reach it).
 */
export async function openTunnel(): Promise<TunnelHandle> {
  if (!TUNNEL_TOKEN) {
    console.warn(
      "[shim] CLOUDFLARE_TUNNEL_TOKEN not set — tunnel disabled. The server is localhost-only and Cursor's cloud cannot reach it.",
    );
    return { url: null, connected: false, async close() {} };
  }

  if (!existsSync(bin)) {
    console.log("[shim] installing cloudflared binary (first run, ~25 MB)…");
    await install(bin);
  }

  const localUrl = `http://127.0.0.1:${PORT}`;
  const url = TUNNEL_HOSTNAME
    ? TUNNEL_HOSTNAME.startsWith("http")
      ? TUNNEL_HOSTNAME
      : `https://${TUNNEL_HOSTNAME}`
    : null;

  let cf: CfTunnel | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let connected = false;
  let signalFirstConnect: (() => void) | null = null;
  const firstConnect = new Promise<void>((resolve) => {
    signalFirstConnect = resolve;
  });

  const start = (): void => {
    const instance = CfTunnel.withToken(TUNNEL_TOKEN, { "--url": localUrl });
    if (DEBUG_LOG) {
      instance.on("stdout", (line: string) => console.log(`[cf-out] ${line}`));
      instance.on("stderr", (line: string) => console.log(`[cf-err] ${line}`));
    }
    // An "error" event with no listener crashes the whole process, taking the
    // healthy local proxy with it. Always absorb it; "exit" drives reconnection.
    instance.on("error", (err: Error) => console.warn(`[shim] cloudflared error: ${err.message}`));
    instance.on("connected", () => {
      connected = true;
      signalFirstConnect?.();
      signalFirstConnect = null;
    });
    instance.once("exit", () => {
      connected = false;
      if (closed) return;
      console.warn("[shim] cloudflared exited; reconnecting…");
      scheduleReconnect();
    });
    cf = instance;
  };

  const scheduleReconnect = (): void => {
    if (closed || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!closed) start();
    }, RECONNECT_DELAY_MS);
  };

  start();

  // Best effort: give the edge a moment so the banner is accurate, but never
  // fail. At boot the network/DNS is often not ready in time; the tunnel keeps
  // retrying in the background while the proxy serves.
  await waitOrTimeout(firstConnect, TUNNEL_READY_TIMEOUT_MS);
  if (!connected) {
    console.warn(
      `[shim] tunnel not connected within ${TUNNEL_READY_TIMEOUT_MS / 1000}s — ` +
        "retrying in the background; the local proxy stays up.",
    );
  }

  return {
    url,
    get connected() {
      return connected;
    },
    async close() {
      closed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (cf) {
        try {
          cf.removeAllListeners();
        } catch {
          // ignore
        }
        try {
          cf.stop();
        } catch {
          // ignore
        }
      }
    },
  };
}

function waitOrTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
