import { ulid } from "ulid";
import type { ChatContext } from "../providers/types.ts";
import { getProvider } from "../providers/registry.ts";
import { getSelection, startActivity, finishActivity } from "../store/state.ts";
import { SSE_HEADERS, openAiTextStream } from "../openai.ts";

/**
 * Resolve the active selection from the store, dispatch to its provider, and
 * stream the OpenAI SSE response back to Cursor — recording activity start/end.
 */
export async function dispatchChat(
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const selection = getSelection();
  const provider = getProvider(selection.provider);
  const requestId = ulid().toLowerCase();
  const activityId = startActivity({
    requestId,
    provider: selection.provider,
    model: selection.model,
    effort: selection.effort,
  });
  const startedAt = Date.now();

  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let cachedTokens: number | undefined;
  let cacheCreationTokens: number | undefined;
  const ctx: ChatContext = {
    selection,
    body,
    requestId,
    signal,
    report: (u) => {
      if (u.promptTokens !== undefined) promptTokens = u.promptTokens;
      if (u.completionTokens !== undefined) completionTokens = u.completionTokens;
      if (u.cachedTokens !== undefined) cachedTokens = u.cachedTokens;
      if (u.cacheCreationTokens !== undefined) cacheCreationTokens = u.cacheCreationTokens;
    },
  };

  const finalize = (status: string, note?: string): void => {
    finishActivity(activityId, {
      status,
      promptTokens,
      completionTokens,
      cachedTokens,
      cacheCreationTokens,
      durationMs: Date.now() - startedAt,
      note,
    });
  };

  try {
    const source = await provider.chat(ctx);
    return new Response(tapEnd(source, finalize), { headers: SSE_HEADERS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finalize("error", message);
    // Surface the error to Cursor as a normal stream so it renders inline.
    return new Response(openAiTextStream(selection.model, `[cursor-relay] upstream error: ${message}`), {
      headers: SSE_HEADERS,
    });
  }
}

/** Pass through a byte stream, invoking `onEnd` exactly once when it settles. */
function tapEnd(
  source: ReadableStream<Uint8Array>,
  onEnd: (status: string, note?: string) => void,
): ReadableStream<Uint8Array> {
  let done = false;
  const settle = (status: string, note?: string): void => {
    if (done) return;
    done = true;
    onEnd(status, note);
  };
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      try {
        for (;;) {
          const { value, done: finished } = await reader.read();
          if (finished) break;
          controller.enqueue(value);
        }
        settle("ok");
        controller.close();
      } catch (err) {
        settle("error", err instanceof Error ? err.message : String(err));
        try {
          controller.error(err);
        } catch {
          // already closed
        }
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) {
      settle("cancelled", typeof reason === "string" ? reason : undefined);
      void source.cancel(reason).catch(() => {});
    },
  });
}
