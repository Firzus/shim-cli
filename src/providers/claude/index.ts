import type { ChatContext, Provider, ProviderModel } from "../types.ts";
import { fetchWithAuthRetry, upstreamBodyOrThrow } from "../shared.ts";
import { anthropicStreamToOpenAI, buildAnthropicRequest } from "./translate.ts";
import { callClaude } from "./upstream.ts";
import { authStatus, getAuth, invalidateAuthCache } from "./auth.ts";
import { parseAnthropicRateLimitHeaders } from "./usage.ts";
import { recordPlanUsage } from "../../store/state.ts";

/**
 * Claude provider — Anthropic Messages API via Claude Code OAuth.
 *
 * Model set: fable-5 + opus-4-8 + sonnet-4-6 (haiku dropped — it rejects adaptive/effort).
 * Thinking: thinking:{type:"adaptive"} + output_config.effort for all models.
 * The translator always injects the mandatory Claude Code identity system block.
 */

const MODELS: readonly ProviderModel[] = [
  { id: "claude-fable-5", label: "Fable 5", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "claude-opus-4-8", label: "Opus 4.8", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", efforts: ["low", "medium", "high", "xhigh"] },
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

    const res = await fetchWithAuthRetry(getAuth, invalidateAuthCache, (claims) =>
      callClaude(body, claims.accessToken, ctx.signal),
    );
    const upstreamBody = await upstreamBodyOrThrow(res, "Anthropic");

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

    return anthropicStreamToOpenAI(upstreamBody, {
      model: ctx.selection.model,
      report: ctx.report,
    });
  },
};
