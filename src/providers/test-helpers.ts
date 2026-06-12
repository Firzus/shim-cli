/** Shared fixtures for provider translate tests (not a test file itself). */

/** Build an upstream SSE byte stream from `event:`/`data:` pairs. */
export function sseStream(events: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(text));
      c.close();
    },
  });
}

/** Drain a byte stream and decode it to a single string. */
export async function collectText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
}

export interface OpenAIChunk {
  choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/** Parse an OpenAI chat.completion.chunk SSE transcript into its JSON chunks. */
export function parseOpenAIChunks(sse: string): OpenAIChunk[] {
  return sse
    .split("\n\n")
    .map((b) => b.replace(/^data: /, "").trim())
    .filter((d) => d.length > 0 && d !== "[DONE]")
    .map((d) => JSON.parse(d) as OpenAIChunk);
}
