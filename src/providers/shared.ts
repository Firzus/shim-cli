/** Helpers shared by the provider implementations (Claude, Codex). */

import { ProviderError } from "./types.ts";
import { safeResponseText } from "../http.ts";

/** Refresh OAuth tokens this long before they actually expire. */
export const REFRESH_MARGIN_MS = 60_000;

/** True when the token is expired or within the refresh margin of expiring. */
export function tokenNeedsRefresh(expiresAt: number, now: number): boolean {
  return now >= expiresAt - REFRESH_MARGIN_MS;
}

/**
 * Call upstream with fresh credentials, force-refreshing and retrying once on
 * 401 (the token may have been revoked out from under the cache).
 */
export async function fetchWithAuthRetry<Auth>(
  getAuth: (forceRefresh?: boolean) => Promise<Auth>,
  invalidateAuthCache: () => void,
  call: (auth: Auth) => Promise<Response>,
): Promise<Response> {
  let res = await call(await getAuth());
  if (res.status === 401) {
    await res.body?.cancel().catch(() => {});
    invalidateAuthCache();
    res = await call(await getAuth(true));
  }
  return res;
}

/** Return the response body, or throw a ProviderError describing the failure. */
export async function upstreamBodyOrThrow(res: Response, providerLabel: string): Promise<ReadableStream<Uint8Array>> {
  if (res.ok && res.body) return res.body;
  const text = res.body ? await safeResponseText(res, { limit: 500, fallback: "<unreadable>" }) : "<no body>";
  throw new ProviderError(`${providerLabel} ${res.status}: ${text}`, res.status, text);
}
