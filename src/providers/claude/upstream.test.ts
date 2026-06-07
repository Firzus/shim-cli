import { test, expect } from "bun:test";
import { buildHeaders } from "./upstream.ts";

test("builds Claude Code-style headers carrying the OAuth bearer", () => {
  const h = buildHeaders("sk-ant-oat01-x");
  expect(h["Authorization"]).toBe("Bearer sk-ant-oat01-x");
  expect(h["anthropic-version"]).toBe("2023-06-01");
  expect(h["anthropic-beta"]).toContain("oauth-2025-04-20");
  expect(h["x-app"]).toBe("cli");
  expect(h["user-agent"]).toContain("claude-cli/");
  expect(h["content-type"]).toBe("application/json");
});
