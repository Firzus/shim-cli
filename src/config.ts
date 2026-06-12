function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const PORT = parsePositiveIntEnv("PORT", 8787);
export const DEBUG_LOG = process.env.DEBUG_LOG === "1" || process.env.DEBUG_LOG === "true";

/**
 * Prompt-cache breakpoint TTL. `1h` (extended) keeps the stable ~22k-token
 * prefix (identity + system + tools) warm across normal think-gaps between
 * turns, where the default `5m` ephemeral TTL would expire and force a cold
 * rewrite. On the OAuth/subscription path the 1h write premium is irrelevant
 * (no per-token billing), so `1h` is the default. See ADR-0001 and issue #28.
 */
export type CacheTtl = "5m" | "1h";

export function parseCacheTtlEnv(name: string, fallback: CacheTtl): CacheTtl {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1h" || raw === "5m" ? raw : fallback;
}

export const CACHE_TTL: CacheTtl = parseCacheTtlEnv("CACHE_TTL", "1h");

export const TUNNEL_TOKEN = process.env.CLOUDFLARE_TUNNEL_TOKEN ?? "";
export const TUNNEL_HOSTNAME = process.env.CLOUDFLARE_TUNNEL_HOSTNAME ?? "";

/** The single sentinel model id exposed to Cursor. */
export const SENTINEL_MODEL = "Cursor";
