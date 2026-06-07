export function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const PORT = parsePositiveIntEnv("PORT", 8787);
export const MAX_CONCURRENCY = parsePositiveIntEnv("SHIM_MAX_CONCURRENCY", 20);
export const DEBUG = process.env.SHIM_DEBUG === "1" || process.env.SHIM_DEBUG === "true";

export const TUNNEL_TOKEN = process.env.CLOUDFLARE_TUNNEL_TOKEN ?? "";
export const TUNNEL_HOSTNAME = process.env.CLOUDFLARE_TUNNEL_HOSTNAME ?? "";

/** The single sentinel model id exposed to Cursor. */
export const SENTINEL_MODEL = "shim";
