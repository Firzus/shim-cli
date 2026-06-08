import { ulid } from "ulid";
import type { ChatContext, Provider, ProviderModel } from "../types.ts";
import { ProviderError } from "../types.ts";
import { safeResponseText } from "../../http.ts";
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

    let auth = await getAuth();
    const call = (a: typeof auth) =>
      callCodex(body, { accessToken: a.accessToken, accountId: a.chatgptAccountId }, sessionId, ctx.signal);

    let res = await call(auth);
    if (res.status === 401) {
      await res.body?.cancel().catch(() => {});
      invalidateAuthCache();
      auth = await getAuth(true);
      res = await call(auth);
    }

    if (!res.ok || !res.body) {
      const text = res.body
        ? await safeResponseText(res, { limit: 500, fallback: "<unreadable>" })
        : "<no body>";
      throw new ProviderError(`Codex ${res.status}: ${text}`, res.status, text);
    }

    return responsesStreamToOpenAI(res.body, {
      model: ctx.selection.model,
      report: ctx.report,
    });
  },
};
