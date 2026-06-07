/**
 * Codex (ChatGPT) OAuth credential handling. Reads ~/.codex/auth.json, derives
 * the chatgpt_account_id and expiry from the embedded JWTs, and refreshes the
 * access token. Ported/adapted from codex-cursor-proxy.
 */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { CODEX_AUTH } from "../../paths.ts";
import type { AuthStatus } from "../types.ts";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SCOPE = "openid profile email offline_access";
const REFRESH_MARGIN_MS = 60_000;

export interface CodexClaims {
  accessToken: string;
  refreshToken: string | null;
  chatgptAccountId: string;
  planType: string | null;
  /** Epoch ms. */
  expiresAt: number;
}

/** True when the token is expired or within the refresh margin of expiring. */
export function needsRefresh(claims: CodexClaims, now: number): boolean {
  return now >= claims.expiresAt - REFRESH_MARGIN_MS;
}

/** The OAuth refresh request shape the Codex CLI uses (form-urlencoded). */
export function buildRefreshRequest(refreshToken: string): {
  url: string;
  body: string;
  headers: Record<string, string>;
} {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    scope: SCOPE,
  });
  return {
    url: TOKEN_URL,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  };
}

export class CodexAuthError extends Error {
  constructor(
    message: string,
    readonly code: "missing" | "malformed" | "refresh_failed",
  ) {
    super(message);
    this.name = "CodexAuthError";
  }
}

interface AuthFile {
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
}

export function parseCodexAuth(raw: string): CodexClaims {
  let file: AuthFile;
  try {
    file = JSON.parse(raw);
  } catch {
    throw new CodexAuthError("malformed auth.json", "malformed");
  }
  const tokens = file.tokens;
  if (!tokens?.access_token || !tokens.id_token) {
    throw new CodexAuthError("auth.json missing required tokens", "malformed");
  }
  const access = decodeJwt(tokens.access_token);
  const id = decodeJwt(tokens.id_token);
  const authBlock = (id["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  const chatgptAccountId =
    (authBlock.chatgpt_account_id as string | undefined) ?? tokens.account_id ?? "";
  if (!chatgptAccountId) {
    throw new CodexAuthError("could not derive chatgpt_account_id", "malformed");
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? null,
    chatgptAccountId,
    planType: (authBlock.chatgpt_plan_type as string | undefined) ?? null,
    expiresAt: typeof access.exp === "number" ? access.exp * 1000 : 0,
  };
}

function decodeJwt(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) throw new CodexAuthError("invalid JWT", "malformed");
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
}

// --- credential loading + refresh (network/file) ----------------------------

let cached: CodexClaims | null = null;

export async function getAuth(forceRefresh = false): Promise<CodexClaims> {
  if (!forceRefresh && cached && !needsRefresh(cached, Date.now())) return cached;
  const raw = await readAuthFile();
  let claims = parseCodexAuth(raw);
  if (forceRefresh || needsRefresh(claims, Date.now())) claims = await refresh(raw, claims);
  cached = claims;
  return claims;
}

export function invalidateAuthCache(): void {
  cached = null;
}

export async function authStatus(): Promise<AuthStatus> {
  try {
    const c = await getAuth();
    const mins = Math.round((c.expiresAt - Date.now()) / 60_000);
    return { ok: true, detail: `${c.planType ?? "unknown"} plan · token valid ${mins}m`, expiresAt: c.expiresAt };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

async function readAuthFile(): Promise<string> {
  try {
    return await readFile(CODEX_AUTH, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new CodexAuthError(`Codex credentials not found at ${CODEX_AUTH}`, "missing");
    }
    throw err;
  }
}

async function refresh(raw: string, claims: CodexClaims): Promise<CodexClaims> {
  if (!claims.refreshToken) throw new CodexAuthError("no refresh token in auth.json", "refresh_failed");
  const req = buildRefreshRequest(claims.refreshToken);
  let payload: { access_token?: string; id_token?: string; refresh_token?: string };
  try {
    const res = await fetch(req.url, { method: "POST", headers: req.headers, body: req.body });
    if (!res.ok) throw new CodexAuthError(`token refresh failed (${res.status})`, "refresh_failed");
    payload = (await res.json()) as typeof payload;
  } catch (err) {
    if (err instanceof CodexAuthError) throw err;
    throw new CodexAuthError(`token refresh failed: ${err instanceof Error ? err.message : String(err)}`, "refresh_failed");
  }
  if (!payload.access_token || !payload.id_token) {
    throw new CodexAuthError("refresh response missing tokens", "refresh_failed");
  }

  const file = JSON.parse(raw) as { tokens?: Record<string, unknown>; last_refresh?: string };
  file.tokens = {
    ...(file.tokens ?? {}),
    access_token: payload.access_token,
    id_token: payload.id_token,
    refresh_token: payload.refresh_token ?? claims.refreshToken,
  };
  file.last_refresh = new Date().toISOString();
  await persist(file);
  return parseCodexAuth(JSON.stringify(file));
}

async function persist(file: unknown): Promise<void> {
  await mkdir(dirname(CODEX_AUTH), { recursive: true });
  const tmp = `${CODEX_AUTH}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, CODEX_AUTH);
}
