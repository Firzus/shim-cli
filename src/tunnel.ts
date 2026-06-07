import { DEBUG, TUNNEL_HOSTNAME, TUNNEL_TOKEN } from "./config.ts";

export interface TunnelHandle {
  /** Public hostname Cursor should target, or null when the tunnel is disabled. */
  readonly hostname: string | null;
  stop(): void;
}

/**
 * Start the Cloudflare named tunnel that fronts the local server.
 *
 * Cursor routes BYOK requests through its cloud backend, so a localhost URL is
 * rejected — a public hostname is required. A token-based named tunnel carries
 * its ingress config remotely (dashboard maps the hostname to localhost:PORT).
 *
 * When no token is configured we warn and run server-only (useful for local
 * tests, but Cursor's cloud will not be able to reach it).
 */
export function startTunnel(): TunnelHandle {
  if (!TUNNEL_TOKEN) {
    console.warn(
      "[shim] CLOUDFLARE_TUNNEL_TOKEN not set — tunnel disabled. The server is localhost-only and Cursor's cloud cannot reach it.",
    );
    return { hostname: null, stop() {} };
  }

  const proc = Bun.spawn(["cloudflared", "tunnel", "run", "--token", TUNNEL_TOKEN], {
    stdout: DEBUG ? "inherit" : "ignore",
    stderr: DEBUG ? "inherit" : "ignore",
  });

  return {
    hostname: TUNNEL_HOSTNAME || null,
    stop() {
      try {
        proc.kill();
      } catch {
        // already dead
      }
    },
  };
}
