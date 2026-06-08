import type { ChatContext, Provider, ProviderModel } from "../types.ts";
import { ProviderError } from "../types.ts";
import { safeResponseText } from "../../http.ts";
import { anthropicStreamToOpenAI, buildAnthropicRequest } from "./translate.ts";
import { callClaude } from "./upstream.ts";
import { authStatus, getAuth, invalidateAuthCache } from "./auth.ts";
import { parseAnthropicRateLimitHeaders } from "./usage.ts";
import { recordPlanUsage } from "../../store/state.ts";

/**
 * Claude provider — Anthropic Messages API via Claude Code OAuth.
 *
 * Model set: opus-4-8 + sonnet-4-6 (haiku dropped — it rejects adaptive/effort).
 * Thinking: thinking:{type:"adaptive"} + output_config.effort for both models.
 * The translator always injects the mandatory Claude Code identity system block.
 */

const MODELS: readonly ProviderModel[] = [
  { id: "claude-opus-4-8", label: "Opus 4.8", efforts: ["low", "medium", "high", "extra"] },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", efforts: ["low", "medium", "high", "extra"] },
];

export const claudeProvider: Provider = {
  id: "claude",
  reportsPlanUsage: true,
  models() {
    return MODELS;
  },
  authStatus() {
    return authStatus();
  },
  async usage() {
    return [];
  },
  async chat(ctx: ChatContext): Promise<ReadableStream<Uint8Array>> {
    const body = buildAnthropicRequest(ctx.body, {
      model: ctx.selection.model,
      effort: ctx.selection.effort,
    });
    body.stream = true;

    let claims = await getAuth();
    let res = await callClaude(body, claims.accessToken, ctx.signal);
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      invalidateAuthCache();
      claims = await getAuth(true);
      res = await callClaude(body, claims.accessToken, ctx.signal);
    }

    if (!res.ok || !res.body) {
      const text = res.body
        ? await safeResponseText(res, { limit: 500, fallback: "<unreadable>" })
        : "<no body>";
      throw new ProviderError(`Anthropic ${res.status}: ${text}`, res.status, text);
    }

    // Capture plan usage from headers (separate from the body stream, so this
    // never affects what Cursor receives). Parsing is cheap and inline; the
    // sqlite write is deferred so it stays off the path that returns the stream.
    // Best-effort throughout — telemetry must never break a request.
    try {
      const snapshot = parseAnthropicRateLimitHeaders(res.headers);
      if (snapshot) {
        queueMicrotask(() => {
          try {
            recordPlanUsage("claude", snapshot);
          } catch {
            // ignore — usage capture is best-effort
          }
        });
      }
    } catch {
      // ignore — header parsing is best-effort
    }

    return anthropicStreamToOpenAI(res.body, {
      model: ctx.selection.model,
      report: ctx.report,
    });
  },
};
