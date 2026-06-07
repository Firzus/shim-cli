import { test, expect } from "bun:test";
import { buildRefreshRequest, needsRefresh, parseCodexAuth } from "./auth.ts";

function jwt(payload: Record<string, unknown>): string {
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `header.${b64}.sig`;
}

test("parses codex auth.json deriving account id, plan and expiry from JWTs", () => {
  const idToken = jwt({ email: "a@b.c", "https://api.openai.com/auth": { chatgpt_account_id: "acc_1", chatgpt_plan_type: "plus" } });
  const accessToken = jwt({ exp: 2_000_000_000 });
  const raw = JSON.stringify({ tokens: { id_token: idToken, access_token: accessToken, refresh_token: "rt" } });

  const c = parseCodexAuth(raw);
  expect(c.accessToken).toBe(accessToken);
  expect(c.chatgptAccountId).toBe("acc_1");
  expect(c.planType).toBe("plus");
  expect(c.expiresAt).toBe(2_000_000_000 * 1000);
  expect(c.refreshToken).toBe("rt");
});

test("needsRefresh is true within the 60s margin of expiry", () => {
  const c = { accessToken: "a", refreshToken: "r", chatgptAccountId: "x", planType: "plus", expiresAt: 1_000_000 };
  expect(needsRefresh(c, 1_000_000 - 120_000)).toBe(false);
  expect(needsRefresh(c, 1_000_000 - 30_000)).toBe(true);
});

test("builds the codex OAuth refresh request (form-urlencoded)", () => {
  const r = buildRefreshRequest("rt");
  expect(r.url).toBe("https://auth.openai.com/oauth/token");
  expect(r.headers["content-type"]).toBe("application/x-www-form-urlencoded");
  const p = new URLSearchParams(r.body);
  expect(p.get("grant_type")).toBe("refresh_token");
  expect(p.get("refresh_token")).toBe("rt");
  expect(p.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
});
