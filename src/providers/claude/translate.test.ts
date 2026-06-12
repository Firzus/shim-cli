import { test, expect } from "bun:test";
import { anthropicStreamToOpenAI, buildAnthropicRequest, CACHE_CONTROL, CLAUDE_CODE_IDENTITY } from "./translate.ts";
import { collectText, parseOpenAIChunks, sseStream as anthropicSSE } from "../test-helpers.ts";

test("injects the Claude Code identity as the first system block, Cursor's system second", () => {
  const body = {
    model: "Cursor",
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

test("the cache breakpoint carries the configured TTL, defaulting to 1h (issue #28)", () => {
  // CACHE_TTL defaults to "1h" with no env override; all breakpoints inherit it
  // from this single marker, so asserting the marker pins the whole request.
  expect(CACHE_CONTROL).toEqual({ type: "ephemeral", ttl: "1h" });
});

test("maps effort to adaptive thinking + output_config.effort, clamping 'xhigh' per model", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };

  const sonnetHigh = buildAnthropicRequest(body, { model: "claude-sonnet-4-6", effort: "high" });
  expect(sonnetHigh.thinking).toEqual({ type: "adaptive", display: "summarized" });
  expect(sonnetHigh.output_config).toEqual({ effort: "high" });

  // 'xhigh' clamps differently: fable/opus accept xhigh, sonnet rejects xhigh but accepts max.
  const fableExtra = buildAnthropicRequest(body, { model: "claude-fable-5", effort: "xhigh" });
  expect(fableExtra.output_config).toEqual({ effort: "xhigh" });
  const opusExtra = buildAnthropicRequest(body, { model: "claude-opus-4-8", effort: "xhigh" });
  expect(opusExtra.output_config).toEqual({ effort: "xhigh" });
  const sonnetExtra = buildAnthropicRequest(body, { model: "claude-sonnet-4-6", effort: "xhigh" });
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

// --- conversation breakpoints (issue #6) -----------------------------------
function cacheMarked(messages: Array<{ role: string; content: unknown }>): number[] {
  return messages.flatMap((m, i) => {
    const content = m.content;
    if (!Array.isArray(content) || content.length === 0) return [];
    const last = content[content.length - 1] as { cache_control?: unknown };
    return last?.cache_control ? [i] : [];
  });
}

test("marks no conversation breakpoint for a single user message (it is the new last message)", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  const out = buildAnthropicRequest(body, { model: "claude-sonnet-4-6", effort: "medium" });
  expect(cacheMarked(out.messages)).toEqual([]);
});

test("marks no conversation breakpoint when there are no user messages", () => {
  const body = { messages: [{ role: "assistant", content: "preface" }] };
  const out = buildAnthropicRequest(body, { model: "claude-sonnet-4-6", effort: "medium" });
  expect(cacheMarked(out.messages)).toEqual([]);
});

test("marks the fixed anchor (first user message) when a later turn follows it", () => {
  const body = {
    messages: [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" }, // new last message -> never marked
    ],
  };
  const out = buildAnthropicRequest(body, { model: "claude-sonnet-4-6", effort: "medium" });
  // Fixed and rolling anchor both resolve to the first user message; last is untouched.
  expect(cacheMarked(out.messages)).toEqual([0]);
  expect((out.messages[0]!.content as Array<{ cache_control?: unknown }>)[0]!.cache_control).toEqual(CACHE_CONTROL);
  expect((out.messages[2]!.content as Array<{ cache_control?: unknown }>)[0]!.cache_control).toBeUndefined();
});

test("marks distinct fixed and rolling anchors across three user turns", () => {
  const body = {
    messages: [
      { role: "user", content: "u1" }, // fixed anchor
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" }, // rolling anchor (second-to-last user)
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" }, // new last message -> never marked
    ],
  };
  const out = buildAnthropicRequest(body, { model: "claude-sonnet-4-6", effort: "medium" });
  expect(cacheMarked(out.messages)).toEqual([0, 2]);
  expect(cacheMarked(out.messages).length).toBeLessThanOrEqual(2); // 2 of the 4-breakpoint budget
});

test("never exceeds 4 cache breakpoints across system + tools + conversation", () => {
  const tool = (name: string) => ({ type: "function", function: { name, description: "", parameters: {} } });
  const body = {
    tools: [tool("Read"), tool("Write")],
    messages: [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
    ],
  };
  const out = buildAnthropicRequest(body, { model: "claude-sonnet-4-6", effort: "medium" });
  const systemMarks = out.system.filter((b) => b.cache_control).length;
  const toolMarks = (out.tools as Array<{ cache_control?: unknown }>).filter((t) => t.cache_control).length;
  const convMarks = cacheMarked(out.messages).length;
  expect(systemMarks).toBe(1);
  expect(toolMarks).toBe(1);
  expect(convMarks).toBe(2);
  expect(systemMarks + toolMarks + convMarks).toBe(4);
});

test("anchors a tool_result user turn on its last block (defensive, no missing-block reference)", () => {
  const body = {
    messages: [
      { role: "user", content: "go" }, // fixed anchor
      {
        role: "assistant",
        content: [],
        tool_calls: [{ id: "call_a", type: "function", function: { name: "Read", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_a", content: "resA" }, // batched into a user turn (rolling anchor)
      { role: "user", content: "again" }, // new last message -> never marked
    ],
  };
  const out = buildAnthropicRequest(body, { model: "claude-sonnet-4-6", effort: "medium" });
  // user("go"), assistant(tool_use), user(tool_result), user("again")
  expect(cacheMarked(out.messages)).toEqual([0, 2]);
  const toolResultTurn = out.messages[2]!.content as Array<{ type: string; cache_control?: unknown }>;
  expect(toolResultTurn[toolResultTurn.length - 1]!.cache_control).toEqual(CACHE_CONTROL);
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
  let reported: { promptTokens?: number; completionTokens?: number; cachedTokens?: number; cacheCreationTokens?: number } | undefined;
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
  expect(usageChunk?.usage).toEqual({
    prompt_tokens: 42,
    completion_tokens: 17,
    total_tokens: 59,
    prompt_tokens_details: { cached_tokens: 0 },
  });
  expect(reported).toEqual({ promptTokens: 42, completionTokens: 17, cachedTokens: 0, cacheCreationTokens: 0 });
});

test("normalizes the prompt total to include cache for both the Cursor chunk and the store report", async () => {
  let reported: { promptTokens?: number; completionTokens?: number; cachedTokens?: number; cacheCreationTokens?: number } | undefined;
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
  // The chunk streamed to Cursor uses the full input (OpenAI semantics):
  // prompt total = input + cache_read + cache_creation = 150.
  const usageChunk = chunks.find((c) => c.usage);
  expect(usageChunk?.usage).toEqual({
    prompt_tokens: 150,
    completion_tokens: 17,
    total_tokens: 167,
    prompt_tokens_details: { cached_tokens: 100 },
  });
  // The store report uses the same normalized prompt total, and surfaces the
  // cold-write count (cache_creation) separately from the cache reads.
  expect(reported).toEqual({ promptTokens: 150, completionTokens: 17, cachedTokens: 100, cacheCreationTokens: 8 });
});
