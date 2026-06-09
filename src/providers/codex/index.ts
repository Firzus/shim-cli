import { ulid } from "ulid";
import type { ChatContext, Provider, ProviderModel } from "../types.ts";
import { fetchWithAuthRetry, upstreamBodyOrThrow } from "../shared.ts";
import { buildResponsesRequest, responsesStreamToOpenAI } from "./translate.ts";
import { callCodex } from "./upstream.ts";
import { authStatus, getAuth, invalidateAuthCache } from "./auth.ts";

/**
 * Codex provider — ChatGPT Codex (Responses API) via Codex CLI OAuth.
 * Ported/adapted from codex-cursor-proxy.
 */

// Real models the ChatGPT-account Codex backend accepts (from ~/.codex/models_cache.json).
// Other gpt-5.x ids return "model is not supported when using Codex with a ChatGPT account".
const MODELS: readonly ProviderModel[] = [
  { id: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "medium", "high", "extra"] },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini", efforts: ["low", "medium", "high", "extra"] },
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
    const sessionId = ulid().toLowerCase();

    const res = await fetchWithAuthRetry(getAuth, invalidateAuthCache, (auth) =>
      callCodex(body, { accessToken: auth.accessToken, accountId: auth.chatgptAccountId }, sessionId, ctx.signal),
    );
    const upstreamBody = await upstreamBodyOrThrow(res, "Codex");

    return responsesStreamToOpenAI(upstreamBody, {
      model: ctx.selection.model,
      report: ctx.report,
    });
  },
};
