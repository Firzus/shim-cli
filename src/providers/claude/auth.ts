/**
 * Claude Code OAuth credential handling. Reads ~/.claude/.credentials.json,
 * refreshes the access token proactively/on 401, and reports auth status.
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { CLAUDE_CREDENTIALS } from "../../paths.ts";
import type { AuthStatus } from "../types.ts";

export interface ClaudeClaims {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
  scopes: string[];
  subscriptionType: string | null;
}

const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const REFRESH_MARGIN_MS = 60_000;

/** The OAuth refresh request shape Claude Code uses (JSON body, public client id). */
export function buildRefreshRequest(refreshToken: string): {
  url: string;
  body: string;
  headers: Record<string, string>;
} {
  return {
    url: TOKEN_URL,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  };
}

/** True when the token is expired or within the refresh margin of expiring. */
export function needsRefresh(claims: ClaudeClaims, now: number): boolean {
  return now >= claims.expiresAt - REFRESH_MARGIN_MS;
}

export class ClaudeAuthError extends Error {
  constructor(
    message: string,
    readonly code: "missing" | "malformed" | "refresh_failed",
  ) {
    super(message);
    this.name = "ClaudeAuthError";
  }
}

export function parseCredentials(raw: string): ClaudeClaims {
  let parsed: { claudeAiOauth?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ClaudeAuthError("malformed .credentials.json", "malformed");
  }
  const o = parsed.claudeAiOauth;
  if (!o || typeof o.accessToken !== "string") {
    throw new ClaudeAuthError("missing claudeAiOauth.accessToken", "malformed");
  }
  return {
    accessToken: o.accessToken,
    refreshToken: typeof o.refreshToken === "string" ? o.refreshToken : null,
    expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : 0,
    scopes: Array.isArray(o.scopes) ? (o.scopes as string[]) : [],
    subscriptionType: typeof o.subscriptionType === "string" ? o.subscriptionType : null,
  };
}

// --- credential loading + refresh (network/file) ----------------------------

let cached: ClaudeClaims | null = null;

/** Return valid claims, refreshing the token proactively or on demand. */
export async function getAuth(forceRefresh = false): Promise<ClaudeClaims> {
  if (!forceRefresh && cached && !needsRefresh(cached, Date.now())) return cached;

  const claims = parseCredentials(await readCreds());
  const fresh = forceRefresh || needsRefresh(claims, Date.now()) ? await refresh(claims) : claims;
  cached = fresh;
  return fresh;
}

export function invalidateAuthCache(): void {
  cached = null;
}

export async function authStatus(): Promise<AuthStatus> {
  try {
    const claims = await getAuth();
    const mins = Math.round((claims.expiresAt - Date.now()) / 60_000);
    const plan = claims.subscriptionType ?? "unknown";
    return { ok: true, detail: `${plan} plan · token valid ${mins}m`, expiresAt: claims.expiresAt };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function readCreds(): Promise<string> {
  try {
    return await readFile(CLAUDE_CREDENTIALS, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ClaudeAuthError(`Claude Code credentials not found at ${CLAUDE_CREDENTIALS}`, "missing");
    }
    throw err;
  }
}

async function refresh(claims: ClaudeClaims): Promise<ClaudeClaims> {
  if (!claims.refreshToken) {
    throw new ClaudeAuthError("no refresh token in credentials", "refresh_failed");
  }
  const req = buildRefreshRequest(claims.refreshToken);
  let payload: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body });
    if (!res.ok) {
      throw new ClaudeAuthError(`token refresh failed (${res.status})`, "refresh_failed");
    }
    payload = (await res.json()) as typeof payload;
  } catch (err) {
    if (err instanceof ClaudeAuthError) throw err;
    throw new ClaudeAuthError(`token refresh failed: ${err instanceof Error ? err.message : String(err)}`, "refresh_failed");
  }

  const next: ClaudeClaims = {
    ...claims,
    accessToken: payload.access_token ?? claims.accessToken,
    refreshToken: payload.refresh_token ?? claims.refreshToken,
    expiresAt: payload.expires_in ? Date.now() + payload.expires_in * 1000 : claims.expiresAt,
  };
  await persist(next);
  return next;
}

/** Rewrite ~/.claude/.credentials.json atomically, preserving unknown fields. */
async function persist(claims: ClaudeClaims): Promise<void> {
  let existing: { claudeAiOauth?: Record<string, unknown> } = {};
  try {
    existing = JSON.parse(await readFile(CLAUDE_CREDENTIALS, "utf8"));
  } catch {
    // start fresh if unreadable
  }
  const merged = {
    ...existing,
    claudeAiOauth: {
      ...(existing.claudeAiOauth ?? {}),
      accessToken: claims.accessToken,
      refreshToken: claims.refreshToken,
      expiresAt: claims.expiresAt,
    },
  };
  await mkdir(dirname(CLAUDE_CREDENTIALS), { recursive: true });
  const tmp = `${CLAUDE_CREDENTIALS}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(merged, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, CLAUDE_CREDENTIALS);
}
