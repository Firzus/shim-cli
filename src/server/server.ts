import { PORT, SENTINEL_MODEL } from "../config.ts";
import { purgeExpiredActivity, sweepPendingActivity } from "../store/state.ts";
import { dispatchChat } from "./dispatch.ts";

/** How often the running service re-purges activity rows past retention. */
const PURGE_INTERVAL_MS = 60 * 60 * 1000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Start the local OpenAI-compatible HTTP server bound to 127.0.0.1. */
export function startServer() {
  const swept = sweepPendingActivity();
  if (swept > 0) {
    console.log(`[shim] swept ${swept} pending activity row(s) left by a previous instance.`);
  }
  const purged = purgeExpiredActivity();
  if (purged > 0) {
    console.log(`[shim] purged ${purged} activity row(s) past the 7-day retention.`);
  }
  // The service can outlive the retention horizon, so re-purge periodically.
  setInterval(() => purgeExpiredActivity(), PURGE_INTERVAL_MS);
  return Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/health") {
        return json({ ok: true });
      }

      // Cursor does not require this, but proxies implement it as courtesy.
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return json({
          object: "list",
          data: [{ id: SENTINEL_MODEL, object: "model", created: 0, owned_by: "shim" }],
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return json({ error: { message: "invalid JSON body", type: "invalid_request_error" } }, 400);
        }
        return dispatchChat(body, req.signal);
      }

      return json({ error: { message: "not found", type: "invalid_request_error" } }, 404);
    },
  });
}
