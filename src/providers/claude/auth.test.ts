import { test, expect } from "bun:test";
import { buildRefreshRequest, needsRefresh, parseCredentials } from "./auth.ts";

test("parses Claude Code credentials into claims", () => {
  const raw = JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-oat01-x",
      refreshToken: "sk-ant-ort01-y",
      expiresAt: 1780868990192,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: "max",
    },
  });
  const c = parseCredentials(raw);
  expect(c.accessToken).toBe("sk-ant-oat01-x");
  expect(c.refreshToken).toBe("sk-ant-ort01-y");
  expect(c.expiresAt).toBe(1780868990192);
  expect(c.subscriptionType).toBe("max");
});

test("needsRefresh is true within the 60s margin of expiry", () => {
  const claims = { accessToken: "a", refreshToken: "r", expiresAt: 1_000_000, scopes: [], subscriptionType: "max" };
  expect(needsRefresh(claims, 1_000_000 - 120_000)).toBe(false); // 2 min before -> fresh
  expect(needsRefresh(claims, 1_000_000 - 30_000)).toBe(true); // within 60s margin -> refresh
  expect(needsRefresh(claims, 1_000_000 + 1)).toBe(true); // expired -> refresh
});

test("builds the OAuth refresh request for the Claude Code client", () => {
  const r = buildRefreshRequest("sk-ant-ort01-y");
  expect(r.url).toBe("https://console.anthropic.com/v1/oauth/token");
  expect(r.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(r.body)).toEqual({
    grant_type: "refresh_token",
    refresh_token: "sk-ant-ort01-y",
    client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  });
});
