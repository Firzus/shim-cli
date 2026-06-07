import { randomUUID } from "node:crypto";

/** Shared helpers for building OpenAI `chat.completion.chunk` SSE output. */

export function newCompletionId(): string {
  return "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 24);
}

export interface ChunkDelta {
  role?: "assistant";
  content?: string;
  reasoning_content?: string;
  tool_calls?: unknown[];
}

export function chatChunk(
  id: string,
  model: string,
  created: number,
  delta: ChunkDelta,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

/** A minimal OpenAI SSE stream that emits `text` then stops. Used by stubs/errors. */
export function openAiTextStream(model: string, text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const id = newCompletionId();
  const created = Math.floor(Date.now() / 1000);
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(sse(chatChunk(id, model, created, { role: "assistant" }))));
      c.enqueue(enc.encode(sse(chatChunk(id, model, created, { content: text }))));
      c.enqueue(enc.encode(sse(chatChunk(id, model, created, {}, "stop"))));
      c.enqueue(enc.encode(SSE_DONE));
      c.close();
    },
  });
}
