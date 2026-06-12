import { test, expect } from "bun:test";
import { buildResponsesRequest } from "./translate.ts";

test("maps system to instructions, messages to input[], and effort to reasoning", () => {
  const body = {
    model: "Cursor",
    stream: true,
    messages: [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ],
  };
  const out = buildResponsesRequest(body, { model: "gpt-5.4", effort: "high" });
  expect(out.model).toBe("gpt-5.4");
  expect(out.instructions).toBe("be terse");
  expect(out.reasoning).toEqual({ effort: "high" });
  expect(out.prompt_cache_key).toBe("cursor-relay:codex:gpt-5.4");
  expect(out.prompt_cache_retention).toBe("24h");
  expect(out.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
  expect(out.stream).toBe(true);
  expect(out.store).toBe(false);
});

test("converts nested OpenAI tools to flat Responses function tools", () => {
  const body = {
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { type: "function", function: { name: "Read", description: "read", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "Glob", description: "find", parameters: { type: "object", properties: {} } } },
    ],
  };
  const out = buildResponsesRequest(body, { model: "gpt-5.4", effort: "low" });
  expect(out.tools).toEqual([
    { type: "function", name: "Glob", description: "find", parameters: { type: "object", properties: {} } },
    { type: "function", name: "Read", description: "read", parameters: { type: "object", properties: {} } },
  ]);
});

test("maps assistant tool_calls to function_call and tool results to function_call_output", () => {
  const body = {
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [], tool_calls: [{ id: "call_1", type: "function", function: { name: "Glob", arguments: '{"x":1}' } }] },
      { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "res" }] },
    ],
  };
  const out = buildResponsesRequest(body, { model: "gpt-5.4", effort: "low" });
  expect(out.input).toEqual([
    { role: "user", content: [{ type: "input_text", text: "go" }] },
    { type: "function_call", call_id: "call_1", name: "Glob", arguments: '{"x":1}' },
    { type: "function_call_output", call_id: "call_1", output: "res" },
  ]);
});

// --- stream helpers ---
import { responsesStreamToOpenAI } from "./translate.ts";
import { collectText, parseOpenAIChunks, sseStream as responsesSSE } from "../test-helpers.ts";

test("translates Responses output_text deltas to OpenAI content chunks with usage and [DONE]", async () => {
  const upstream = responsesSSE([
    { event: "response.output_text.delta", data: { delta: "Hello" } },
    { event: "response.output_text.delta", data: { delta: " world" } },
    { event: "response.completed", data: { response: { status: "completed", usage: { input_tokens: 10, output_tokens: 5 } } } },
  ]);
  const out = await collectText(responsesStreamToOpenAI(upstream, { model: "gpt-5.4" }));
  expect(out).toContain("data: [DONE]");
  const chunks = parseOpenAIChunks(out);
  const content = chunks.flatMap((c) => (typeof c.choices?.[0]?.delta?.content === "string" ? [c.choices[0].delta.content] : [])).join("");
  expect(content).toBe("Hello world");
  expect(chunks.find((c) => c.choices?.[0]?.finish_reason)?.choices?.[0]?.finish_reason).toBe("stop");
  expect(chunks.find((c) => c.usage)?.usage).toEqual({
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    prompt_tokens_details: { cached_tokens: 0 },
  });
});

test("reports cached_tokens from input_tokens_details with prompt total unchanged", async () => {
  let reported: { promptTokens?: number; completionTokens?: number; cachedTokens?: number } | undefined;
  const upstream = responsesSSE([
    { event: "response.output_text.delta", data: { delta: "hi" } },
    {
      event: "response.completed",
      data: {
        response: {
          status: "completed",
          usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 80 } },
        },
      },
    },
  ]);
  const chunks = parseOpenAIChunks(
    await collectText(responsesStreamToOpenAI(upstream, { model: "gpt-5.4", report: (u) => { reported = u; } })),
  );
  // input_tokens already includes cache, so the prompt total is unchanged.
  expect(chunks.find((c) => c.usage)?.usage).toEqual({
    prompt_tokens: 100,
    completion_tokens: 5,
    total_tokens: 105,
    prompt_tokens_details: { cached_tokens: 80 },
  });
  expect(reported).toEqual({ promptTokens: 100, completionTokens: 5, cachedTokens: 80 });
});

test("translates Responses reasoning deltas to reasoning_content", async () => {
  const upstream = responsesSSE([
    { event: "response.reasoning_text.delta", data: { delta: "thinking..." } },
    { event: "response.completed", data: { response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } } },
  ]);
  const chunks = parseOpenAIChunks(await collectText(responsesStreamToOpenAI(upstream, { model: "gpt-5.4" })));
  const r = chunks.flatMap((c) => (typeof c.choices?.[0]?.delta?.reasoning_content === "string" ? [c.choices[0].delta.reasoning_content] : [])).join("");
  expect(r).toBe("thinking...");
});

test("translates Responses function_call streaming to OpenAI tool_calls", async () => {
  const upstream = responsesSSE([
    { event: "response.output_item.added", data: { item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "Glob" } } },
    { event: "response.function_call_arguments.delta", data: { call_id: "call_1", delta: '{"x":' } },
    { event: "response.function_call_arguments.delta", data: { call_id: "call_1", delta: "1}" } },
    { event: "response.completed", data: { response: { status: "completed", usage: { input_tokens: 1, output_tokens: 1 } } } },
  ]);
  const chunks = parseOpenAIChunks(await collectText(responsesStreamToOpenAI(upstream, { model: "gpt-5.4" })));
  const toolDeltas = chunks.flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? []);
  expect(toolDeltas.find((t: any) => t.id)).toMatchObject({ index: 0, id: "call_1", type: "function", function: { name: "Glob" } });
  expect(toolDeltas.map((t: any) => t.function?.arguments ?? "").join("")).toBe('{"x":1}');
  expect(chunks.find((c) => c.choices?.[0]?.finish_reason)?.choices?.[0]?.finish_reason).toBe("tool_calls");
});
