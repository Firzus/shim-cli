import type { ChatContext, Provider, ProviderModel } from "../types.ts";
import { fetchWithAuthRetry, upstreamBodyOrThrow } from "../shared.ts";
import { buildResponsesRequest, responsesStreamToOpenAI } from "./translate.ts";
import { callCodex } from "./upstream.ts";
import { authStatus, getAuth, invalidateAuthCache } from "./auth.ts";
import { safeResponseText } from "../../http.ts";

/**
 * Codex provider — ChatGPT Codex (Responses API) via Codex CLI OAuth.
 * Ported/adapted from codex-cursor-proxy.
 */

// Real models the ChatGPT-account Codex backend accepts (from ~/.codex/models_cache.json).
// Other gpt-5.x ids return "model is not supported when using Codex with a ChatGPT account".
const MODELS: readonly ProviderModel[] = [
  { id: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini", efforts: ["low", "medium", "high", "xhigh"] },
];

export const codexProvider: Provider = {
  id: "codex",
  reportsPlanUsage: false,
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
    const body = buildResponsesRequest(ctx.body, {
      model: ctx.selection.model,
      effort: ctx.selection.effort,
    });
    const sessionId = body.prompt_cache_key ?? ctx.requestId;

    const call = (requestBody: typeof body) =>
      fetchWithAuthRetry(getAuth, invalidateAuthCache, (auth) =>
        callCodex(requestBody, { accessToken: auth.accessToken, accountId: auth.chatgptAccountId }, sessionId, ctx.signal),
      );
    let res = await call(body);
    let requestBody = body;
    if (await rejectsPromptCacheRetention(res)) {
      requestBody = withoutPromptCacheRetention(requestBody);
      res = await call(requestBody);
    }
    if (await rejectsPromptCacheKey(res)) {
      requestBody = withoutPromptCacheKey(requestBody);
      res = await call(requestBody);
    }
    const upstreamBody = await upstreamBodyOrThrow(res, "Codex");

    return responsesStreamToOpenAI(upstreamBody, {
      model: ctx.selection.model,
      report: ctx.report,
    });
  },
};

async function rejectsPromptCacheRetention(res: Response): Promise<boolean> {
  if (res.status !== 400 && res.status !== 422) return false;
  const text = await safeResponseText(res.clone(), { limit: 1000, fallback: "" });
  return text.includes("prompt_cache_retention");
}

async function rejectsPromptCacheKey(res: Response): Promise<boolean> {
  if (res.status !== 400 && res.status !== 422) return false;
  const text = await safeResponseText(res.clone(), { limit: 1000, fallback: "" });
  return text.includes("prompt_cache_key");
}

function withoutPromptCacheRetention<T extends { prompt_cache_retention?: string }>(
  body: T,
): Omit<T, "prompt_cache_retention"> {
  const { prompt_cache_retention: _retention, ...rest } = body;
  return rest;
}

function withoutPromptCacheKey<T extends { prompt_cache_key?: string }>(
  body: T,
): Omit<T, "prompt_cache_key"> {
  const { prompt_cache_key: _key, ...rest } = body;
  return rest;
}
