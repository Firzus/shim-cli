import { test, expect } from "bun:test";
import { codexProvider } from "./index.ts";
import type { ChatContext } from "../types.ts";

// Real network test against ChatGPT Codex using the local Codex CLI OAuth token.
// Skipped unless CURSOR_RELAY_E2E=1.
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

e2e("streams a real Codex response as OpenAI chunks with usage", async () => {
  let reported: { promptTokens?: number; completionTokens?: number } | undefined;
  const ctx: ChatContext = {
    selection: { provider: "codex", model: "gpt-5.5", effort: "low" },
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

  const out = await collect(await codexProvider.chat(ctx));
  expect(out).toContain("data: [DONE]");
  const chunks = out
    .split("\n\n")
    .map((b) => b.replace(/^data: /, "").trim())
    .filter((d) => d.length > 0 && d !== "[DONE]")
    .map((d) => JSON.parse(d));

  const content = chunks
    .flatMap((c) => (typeof c.choices?.[0]?.delta?.content === "string" ? [c.choices[0].delta.content] : []))
    .join("");
  expect(content.toLowerCase()).toContain("pong");
  expect(reported?.promptTokens).toBeGreaterThan(0);
});
