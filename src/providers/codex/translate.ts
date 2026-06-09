import type { Effort } from "../types.ts";
import { chatChunk, newCompletionId, sse, SSE_DONE } from "../../openai.ts";

/**
 * OpenAI Chat Completions <-> OpenAI Responses translation for the Codex
 * provider. The ChatGPT Codex backend speaks the Responses API; Cursor speaks
 * Chat Completions. Ported/adapted from codex-cursor-proxy.
 */

const EFFORT_MAP: Record<Effort, string> = {
  low: "low",
  medium: "medium",
  high: "high",
  extra: "xhigh",
};

export interface CodexOptions {
  model: string;
  effort: Effort;
}

export interface ResponsesBody {
  model: string;
  instructions: string;
  input: Array<Record<string, unknown>>;
  stream: true;
  store: false;
  reasoning?: { effort: string };
  tools?: unknown[];
}

export function buildResponsesRequest(
  body: Record<string, unknown>,
  opts: CodexOptions,
): ResponsesBody {
  const messagesIn = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
  const instructionsParts: string[] = [];
  const input: Array<Record<string, unknown>> = [];

  for (const m of messagesIn) {
    const role = m.role as string;
    if (role === "system" || role === "developer") {
      const text = extractText(m.content);
      if (text) instructionsParts.push(text);
      continue;
    }

    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id ?? "",
        output: extractText(m.content),
      });
      continue;
    }

    if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      for (const tc of m.tool_calls as Array<Record<string, unknown>>) {
        const fn = (tc.function ?? {}) as Record<string, unknown>;
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: fn.name ?? "",
          arguments: typeof fn.arguments === "string" ? fn.arguments : "",
        });
      }
      const text = extractText(m.content);
      if (text) input.push({ role: "assistant", content: [{ type: "output_text", text }] });
      continue;
    }

    input.push({
      role,
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text: extractText(m.content) }],
    });
  }

  const req: ResponsesBody = {
    model: opts.model,
    instructions: instructionsParts.length ? instructionsParts.join("\n\n") : "You are a helpful coding assistant.",
    input,
    stream: true,
    store: false,
    reasoning: { effort: EFFORT_MAP[opts.effort] },
  };
  const tools = mapTools(body.tools);
  if (tools) req.tools = tools;
  return req;
}

/** Nested Chat tools `{function:{...}}` -> flat Responses tools `{type:function, name, parameters}`. */
function mapTools(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const t of tools) {
    const fn = ((t as { function?: Record<string, unknown> }).function ?? t) as Record<string, unknown>;
    if (typeof fn.name !== "string") continue;
    out.push({
      type: "function",
      name: fn.name,
      description: fn.description ?? "",
      parameters: fn.parameters ?? fn.input_schema ?? { type: "object", properties: {} },
    });
  }
  return out.length ? out : undefined;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

// --- streaming: Responses SSE -> OpenAI chat.completion.chunk ---------------

export interface StreamOptions {
  model: string;
  // `cacheCreationTokens` is in the shared shape but never set here: the
  // Responses API has no cold-cache-write counter (only `cached_tokens` reads).
  report?: (usage: {
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
    cacheCreationTokens?: number;
  }) => void;
}

interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** Cached input tokens; a subset already included in prompt_tokens. */
  cached_tokens: number;
}

function mapUsage(raw: unknown): ChatUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  // Responses `input_tokens` already INCLUDES cache, so prompt total is unchanged.
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: u.total_tokens ?? input + output,
    cached_tokens: cached,
  };
}

export function responsesStreamToOpenAI(
  upstream: ReadableStream<Uint8Array>,
  opts: StreamOptions,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const id = newCompletionId();
  const created = Math.floor(Date.now() / 1000);
  let roleEmitted = false;
  let finishEmitted = false;
  const toolCalls = new Map<string, { index: number; id: string }>();
  let lastTool: { index: number; id: string } | undefined;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (delta: Record<string, unknown>, finish: string | null = null): void => {
        if (!roleEmitted) {
          controller.enqueue(enc.encode(sse(chatChunk(id, opts.model, created, { role: "assistant" }))));
          roleEmitted = true;
        }
        controller.enqueue(enc.encode(sse(chatChunk(id, opts.model, created, delta, finish))));
      };

      let finalUsage: ChatUsage | null = null;
      try {
        for await (const ev of parseResponsesSSE(upstream)) {
          switch (ev.event) {
            case "response.output_text.delta": {
              const delta = (ev.data as { delta?: string }).delta;
              if (delta) emit({ content: delta });
              break;
            }
            case "response.reasoning_text.delta":
            case "response.reasoning.delta":
            case "response.reasoning_summary_text.delta": {
              const delta = (ev.data as { delta?: string }).delta;
              if (delta) emit({ reasoning_content: delta });
              break;
            }
            case "response.output_item.added": {
              const item = (ev.data as { item?: { type?: string; id?: string; call_id?: string; name?: string } }).item;
              if (item?.type === "function_call" || item?.type === "custom_tool_call") {
                const callId = item.call_id ?? item.id ?? `call_${toolCalls.size}`;
                const tc = { index: toolCalls.size, id: callId };
                toolCalls.set(callId, tc);
                if (item.id && item.id !== callId) toolCalls.set(item.id, tc);
                lastTool = tc;
                emit({ tool_calls: [{ index: tc.index, id: callId, type: "function", function: { name: item.name ?? "", arguments: "" } }] });
              }
              break;
            }
            case "response.function_call_arguments.delta":
            case "response.custom_tool_call_input.delta": {
              const data = ev.data as { delta?: string; item_id?: string; call_id?: string };
              const key = data.call_id ?? data.item_id ?? "";
              const target = (key ? toolCalls.get(key) : undefined) ?? lastTool;
              if (target && data.delta) {
                emit({ tool_calls: [{ index: target.index, function: { arguments: data.delta } }] });
              }
              break;
            }
            case "response.completed": {
              const resp = (ev.data as { response?: { status?: string; incomplete_details?: { reason?: string }; usage?: unknown } }).response;
              finalUsage = mapUsage(resp?.usage);
              const reason =
                resp?.status === "incomplete" || resp?.incomplete_details?.reason === "max_output_tokens"
                  ? "length"
                  : toolCalls.size > 0
                    ? "tool_calls"
                    : "stop";
              emit({}, reason);
              finishEmitted = true;
              break;
            }
            case "response.failed":
            case "error": {
              const data = ev.data as { error?: { message?: string }; message?: string };
              throw new Error(data.error?.message ?? data.message ?? "upstream error");
            }
            default:
              break;
          }
        }
        if (!finishEmitted) emit({}, "stop");
        if (finalUsage) {
          const usage = {
            prompt_tokens: finalUsage.prompt_tokens,
            completion_tokens: finalUsage.completion_tokens,
            total_tokens: finalUsage.total_tokens,
          };
          controller.enqueue(enc.encode(sse({ id, object: "chat.completion.chunk", created, model: opts.model, choices: [], usage })));
          opts.report?.({
            promptTokens: finalUsage.prompt_tokens,
            completionTokens: finalUsage.completion_tokens,
            cachedTokens: finalUsage.cached_tokens,
          });
        }
        controller.enqueue(enc.encode(SSE_DONE));
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ content: `\n\n[shim] stream error: ${message}` }, "stop");
        controller.enqueue(enc.encode(SSE_DONE));
        controller.close();
      }
    },
  });
}

interface ResponsesEvent {
  event: string;
  data: unknown;
}

async function* parseResponsesSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<ResponsesEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const ev = parseBlock(block);
        if (ev) yield ev;
      }
    }
    const tail = parseBlock(buffer);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseBlock(block: string): ResponsesEvent | null {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join("\n");
  if (dataStr === "[DONE]") return null;
  try {
    return { event: eventName, data: JSON.parse(dataStr) };
  } catch {
    return { event: eventName, data: dataStr };
  }
}
