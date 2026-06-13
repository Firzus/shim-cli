import { test, expect } from "bun:test";
import { buildHeaders } from "./upstream.ts";

test("builds codex Responses headers with account id and session", () => {
  const h = buildHeaders("tok", "acc_1", "sess_1");
  expect(h["Authorization"]).toBe("Bearer tok");
  expect(h["Chatgpt-Account-Id"]).toBe("acc_1");
  expect(h["Originator"]).toBe("codex_cli_rs");
  expect(h["Accept"]).toBe("text/event-stream");
  expect(h["Session_id"]).toBe("sess_1");
  expect(h["Conversation_id"]).toBe("sess_1");
  expect(h["session-id"]).toBe("sess_1");
  expect(h["thread-id"]).toBe("sess_1");
  expect(h["x-client-request-id"]).toBe("sess_1");
  expect(h["content-type"]).toBe("application/json");
});
