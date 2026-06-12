import { test, expect } from "bun:test";
import { claudeProvider } from "./index.ts";
import type { ChatContext } from "../types.ts";

// Real network test against Anthropic using the local Claude Code OAuth token.
// Skipped unless CURSOR_RELAY_E2E=1 so it does not run on every `bun test`.
const e2e = process.env.CURSOR_RELAY_E2E === "1" ? test : test.skip;

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
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

e2e("streams a real Claude response as OpenAI chunks with usage", async () => {
  let reported: { promptTokens?: number; completionTokens?: number } | undefined;
  const ctx: ChatContext = {
    selection: { provider: "claude", model: "claude-sonnet-4-6", effort: "low" },
    body: {
      model: "Cursor",
      stream: true,
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Reply with exactly one word: pong" },
      ],
    },
    requestId: "e2e",
    signal: new AbortController().signal,
    report: (u) => {
      reported = u;
    },
  };

  const out = await collect(await claudeProvider.chat(ctx));

  expect(out).toContain("data: [DONE]");
  const chunks = out
    .split("\n\n")
    .map((b) => b.replace(/^data: /, "").trim())
    .filter((d) => d.length > 0 && d !== "[DONE]")
    .map((d) => JSON.parse(d));

  const content = chunks
    .flatMap((c) => {
      const d = c.choices?.[0]?.delta?.content;
      return typeof d === "string" ? [d] : [];
    })
    .join("");
  expect(content.toLowerCase()).toContain("pong");

  const finish = chunks.find((c) => c.choices?.[0]?.finish_reason);
  expect(finish?.choices?.[0]?.finish_reason).toBe("stop");

  const usageChunk = chunks.find((c) => c.usage);
  expect(usageChunk?.usage?.prompt_tokens).toBeGreaterThan(0);
  expect(reported?.completionTokens).toBeGreaterThan(0);
});
