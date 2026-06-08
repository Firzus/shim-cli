import { test, expect } from "bun:test";
import { anthropicStreamToOpenAI, buildAnthropicRequest, CACHE_CONTROL, CLAUDE_CODE_IDENTITY } from "./translate.ts";

// --- stream test helpers ---------------------------------------------------
function anthropicSSE(events: Array<{ event: string; data: unknown }>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join("");
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(text));
      c.close();
    },
  });
}

async function collectText(stream: ReadableStream<Uint8Array>): Promise<string> {
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

interface OpenAIChunk {
  choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}
function parseOpenAIChunks(sse: string): OpenAIChunk[] {
  return sse
    .split("\n\n")
    .map((b) => b.replace(/^data: /, "").trim())
    .filter((d) => d.length > 0 && d !== "[DONE]")
    .map((d) => JSON.parse(d) as OpenAIChunk);
}

test("injects the Claude Code identity as the first system block, Cursor's system second", () => {
  const body = {
    model: "shim",
    stream: true,
    messages: [
      { role: "system", content: "You are a coding assistant." },
      { role: "user", content: "hi" },
    ],
  };

  const out = buildAnthropicRequest(body, { model: "claude-sonnet-4-6", effort: "medium" });

  expect(out.model).toBe("claude-sonnet-4-6");
  expect(out.system[0]).toEqual({ type: "text", text: CLAUDE_CODE_IDENTITY });
  // The last system block carries the cache breakpoint.
  expect(out.system[1]).toEqual({ type: "text", text: "You are a coding assistant.", cache_control: CACHE_CONTROL });
  expect(out.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
});

test("maps effort to adaptive thinking + output_config.effort, clamping 'extra' per model", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };

  const sonnetHigh = buildAnthropicRequest(body, { model: "claude-sonnet-4-6", effort: "high" });
  expect(sonnetHigh.thinking).toEqual({ type: "adaptive" });
  expect(sonnetHigh.output_config).toEqual({ effort: "high" });

  // 'extra' clamps differently: opus accepts xhigh, sonnet rejects xhigh but accepts max.
  const opusExtra = buildAnthropicRequest(body, { model: "claude-opus-4-8", effort: "extra" });
  expect(opusExtra.output_config).toEqual({ effort: "xhigh" });
  const sonnetExtra = buildAnthropicRequest(body, { model: "claude-sonnet-4-6", effort: "extra" });
  expect(sonnetExtra.output_config).toEqual({ effort: "max" });
});

test("sets a default max_tokens and never forwards temperature/top_p", () => {
  const body = { messages: [{ role: "user", content: "hi" }], temperature: 0.7, top_p: 0.9 };
  const out = buildAnthropicRequest(body, { model: "claude-opus-4-8", effort: "low" });
  expect(out.max_tokens).toBe(64000);
  expect(out.temperature).toBeUndefined();
  expect(out.top_p).toBeUndefined();
});

test("converts nested OpenAI tools to Anthropic name/description/input_schema", () => {
  const body = {
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: {
          name: "Glob",
          description: "find files",
          parameters: { type: "object", properties: { glob_pattern: { type: "string" } }, required: ["glob_pattern"] },
        },
      },
    ],
  };
  const out = buildAnthropicRequest(body, { model: "claude-sonnet-4-6", effort: "medium" });
  expect(out.tools).toEqual([
    {
      name: "Glob",
      description: "find files",
      input_schema: { type: "object", properties: { glob_pattern: { type: "string" } }, required: ["glob_pattern"] },
      // Last (here only) tool carries the cache breakpoint.
      cache_control: CACHE_CONTROL,
    },
  ]);
});

test("sorts tools alphabetically by name and marks only the last with cache_control", () => {
  const tool = (name: string) => ({ type: "function", function: { name, description: "", parameters: {} } });
  const body = {
    messages: [{ role: "user", content: "hi" }],
    tools: [tool("Write"), tool("Glob"), tool("Read")],
  };
  const out = buildAnthropicRequest(body, { model: "claude-sonnet-4-6", effort: "medium" });
  const tools = out.tools as Array<Record<string, unknown>>;
  // Deterministic order across turns regardless of input order.
  expect(tools.map((t) => t.name)).toEqual(["Glob", "Read", "Write"]);
  // Exactly one breakpoint, on the last entry.
  expect(tools.filter((t) => t.cache_control).length).toBe(1);
  expect(tools[0]!.cache_control).toBeUndefined();
  expect(tools[tools.length - 1]!.cache_control).toEqual(CACHE_CONTROL);
});

test("emits no tools marker (and no error) when no tools are present", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  const out = buildAnthropicRequest(body, { model: "claude-sonnet-4-6", effort: "medium" });
  expect(out.tools).toBeUndefined();
  // System still gets its breakpoint even with no tools.
  expect(out.system[out.system.length - 1]!.cache_control).toEqual(CACHE_CONTROL);
});

test("converts assistant tool_calls to tool_use blocks (arguments parsed) and drops empty content", () => {
  const body = {
    messages: [
      { role: "user", content: "find md" },
      {
        role: "assistant",
        content: [],
        tool_calls: [
          { id: "call_1", index: 0, type: "function", function: { name: "Glob", arguments: '{"glob_pattern":"*.md"}' } },
        ],
      },
    ],
  };
  const out = buildAnthropicRequest(body, { model: "claude-sonnet-4-6", effort: "medium" });
  const assistant = out.messages[1]!;
  expect(assistant.role).toBe("assistant");
  expect(assistant.content).toEqual([{ type: "tool_use", id: "call_1", name: "Glob", input: { glob_pattern: "*.md" } }]);
});

test("batches consecutive tool messages into one Anthropic user turn of tool_result blocks", () => {
  const body = {
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [],
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "Glob", arguments: "{}" } },
          { id: "call_b", type: "function", function: { name: "Read", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: [{ type: "text", text: "resA" }] },
      { role: "tool", tool_call_id: "call_b", content: "resB" },
    ],
  };
  const out = buildAnthropicRequest(body, { model: "claude-sonnet-4-6", effort: "medium" });
  expect(out.messages.length).toBe(3); // user, assistant(2 tool_use), user(2 tool_result)
  expect(out.messages[2]).toEqual({
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "call_a", content: "resA" },
      { type: "tool_result", tool_use_id: "call_b", content: "resB" },
    ],
  });
});

test("translates Anthropic text_delta events into OpenAI content chunks ending with [DONE]", async () => {
  const upstream = anthropicSSE([
    { event: "message_start", data: { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, output_tokens: 1 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
  const out = await collectText(anthropicStreamToOpenAI(upstream, { model: "claude-sonnet-4-6" }));
  expect(out).toContain("data: [DONE]");
  const chunks = parseOpenAIChunks(out);
  const contents = chunks.flatMap((c) => {
    const d = c.choices?.[0]?.delta?.content;
    return typeof d === "string" ? [d] : [];
  });
  expect(contents.join("")).toBe("Hello world");
  const finish = chunks.find((c) => c.choices?.[0]?.finish_reason);
  expect(finish?.choices?.[0]?.finish_reason).toBe("stop");
});

test("translates thinking_delta to reasoning_content and ignores signature_delta", async () => {
  const upstream = anthropicSSE([
    { event: "message_start", data: { type: "message_start", message: { id: "m", usage: { input_tokens: 5, output_tokens: 1 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "let me think" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIGNATURE" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
  const chunks = parseOpenAIChunks(await collectText(anthropicStreamToOpenAI(upstream, { model: "claude-opus-4-8" })));
  const reasoning = chunks.flatMap((c) => {
    const r = c.choices?.[0]?.delta?.reasoning_content;
    return typeof r === "string" ? [r] : [];
  });
  expect(reasoning.join("")).toBe("let me think");
  expect(JSON.stringify(chunks)).not.toContain("SIGNATURE");
});

test("translates tool_use content blocks to OpenAI tool_calls with fragmented arguments", async () => {
  const upstream = anthropicSSE([
    { event: "message_start", data: { type: "message_start", message: { id: "m", usage: { input_tokens: 5, output_tokens: 1 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "Glob", input: {} } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"glob_' } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'pattern":"*.md"}' } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 8 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
  const chunks = parseOpenAIChunks(await collectText(anthropicStreamToOpenAI(upstream, { model: "claude-sonnet-4-6" })));
  const toolDeltas = chunks.flatMap((c) => ((c.choices?.[0]?.delta as Record<string, unknown> | undefined)?.tool_calls as any[]) ?? []);
  const start = toolDeltas.find((t) => t.id);
  expect(start).toMatchObject({ index: 0, id: "toolu_1", type: "function", function: { name: "Glob" } });
  const args = toolDeltas.map((t) => t.function?.arguments ?? "").join("");
  expect(args).toBe('{"glob_pattern":"*.md"}');
  const finish = chunks.find((c) => c.choices?.[0]?.finish_reason);
  expect(finish?.choices?.[0]?.finish_reason).toBe("tool_calls");
});

test("emits a final usage chunk from Anthropic input/output tokens and reports usage", async () => {
  let reported: { promptTokens?: number; completionTokens?: number; cachedTokens?: number } | undefined;
  const upstream = anthropicSSE([
    { event: "message_start", data: { type: "message_start", message: { id: "m", usage: { input_tokens: 42, output_tokens: 1 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 17 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
  const chunks = parseOpenAIChunks(
    await collectText(anthropicStreamToOpenAI(upstream, { model: "claude-sonnet-4-6", report: (u) => { reported = u; } })),
  );
  const usageChunk = chunks.find((c) => c.usage);
  expect(usageChunk?.usage).toEqual({ prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 });
  expect(reported).toEqual({ promptTokens: 42, completionTokens: 17, cachedTokens: 0 });
});

test("normalizes the reported prompt total to include cache, but keeps the Cursor-facing chunk's raw input_tokens", async () => {
  let reported: { promptTokens?: number; completionTokens?: number; cachedTokens?: number } | undefined;
  const upstream = anthropicSSE([
    {
      event: "message_start",
      data: {
        type: "message_start",
        message: {
          id: "m",
          usage: {
            input_tokens: 42,
            output_tokens: 1,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 8,
          },
        },
      },
    },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 17 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
  const chunks = parseOpenAIChunks(
    await collectText(anthropicStreamToOpenAI(upstream, { model: "claude-sonnet-4-6", report: (u) => { reported = u; } })),
  );
  // The chunk streamed to Cursor must keep the raw input_tokens (cache excluded).
  const usageChunk = chunks.find((c) => c.usage);
  expect(usageChunk?.usage).toEqual({ prompt_tokens: 42, completion_tokens: 17, total_tokens: 59 });
  // The store report normalizes prompt total = input + cache_read + cache_creation.
  expect(reported).toEqual({ promptTokens: 150, completionTokens: 17, cachedTokens: 100 });
});
