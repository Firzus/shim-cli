import type { Effort } from "../types.ts";
import { CACHE_TTL } from "../../config.ts";
import { chatChunk, extractText, newCompletionId, sse, SSE_DONE } from "../../openai.ts";
import { parseSSEEvent, sseBlocks } from "../../sse.ts";

/**
 * OpenAI Chat Completions <-> Anthropic Messages translation for the Claude
 * provider. The OAuth (subscription) path requires the first system block to be
 * exactly the Claude Code identity, so we always inject it.
 */

export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Cursor omits max_tokens but Anthropic requires it; default to a generous ceiling. */
export const DEFAULT_MAX_TOKENS = 64000;

/**
 * Prompt-cache breakpoint marker. Anthropic caching is opt-in: a block only
 * caches if it carries this marker. The TTL (`1h` extended, or `5m` ephemeral)
 * is read once from `CACHE_TTL` so all four breakpoints inherit the same value
 * from a single source. See ADR-0001 and issue #28.
 */
export const CACHE_CONTROL = { type: "ephemeral", ttl: CACHE_TTL } as const;

export interface ClaudeOptions {
  model: string;
  effort: Effort;
}

interface TextBlock {
  type: "text";
  text: string;
  cache_control?: typeof CACHE_CONTROL;
}

export interface AnthropicBody {
  model: string;
  system: TextBlock[];
  messages: Array<{ role: string; content: unknown }>;
  [k: string]: unknown;
}

export function buildAnthropicRequest(
  body: Record<string, unknown>,
  opts: ClaudeOptions,
): AnthropicBody {
  const messagesIn = Array.isArray(body.messages) ? (body.messages as Array<Record<string, unknown>>) : [];
  const system: TextBlock[] = [{ type: "text", text: CLAUDE_CODE_IDENTITY }];
  const messages: Array<{ role: string; content: unknown }> = [];

  // OpenAI sends each tool result as a separate role:"tool" message; Anthropic
  // wants them batched into a single user turn of tool_result blocks.
  let pendingToolResults: Array<Record<string, unknown>> = [];
  const flushToolResults = (): void => {
    if (pendingToolResults.length > 0) {
      messages.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  };

  for (const m of messagesIn) {
    const role = m.role as string;
    if (role === "system" || role === "developer") {
      const text = extractText(m.content);
      if (text) system.push({ type: "text", text });
      continue;
    }

    if (role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: extractText(m.content),
      });
      continue;
    }

    flushToolResults();

    if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const blocks: Array<Record<string, unknown>> = [];
      const text = extractText(m.content);
      if (text) blocks.push({ type: "text", text });
      for (const tc of m.tool_calls as Array<Record<string, unknown>>) {
        const fn = (tc.function ?? {}) as Record<string, unknown>;
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: fn.name ?? "",
          input: safeParseJson(fn.arguments),
        });
      }
      messages.push({ role: "assistant", content: blocks });
      continue;
    }

    messages.push({ role, content: [{ type: "text", text: extractText(m.content) }] });
  }
  flushToolResults();

  // Cache the stable system prefix: mark the last block (identity + Cursor
  // system prompt). The identity block always exists, so this is always safe.
  system[system.length - 1]!.cache_control = CACHE_CONTROL;

  markConversationBreakpoints(messages);

  const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : DEFAULT_MAX_TOKENS;
  const req: AnthropicBody = {
    model: opts.model,
    max_tokens: maxTokens,
    system,
    messages,
    ...mapThinking(opts.model, opts.effort),
  };
  const tools = mapTools(body.tools);
  if (tools) req.tools = tools;
  return req;
}

/**
 * Conversation breakpoints: cache growing history on top of the stable
 * system/tools prefix, spending the remaining 2 of Anthropic's 4-breakpoint
 * budget. Anchors live on **user** messages only — the stable turn boundaries:
 *
 * - **fixed anchor** on the first user message (caches the immutable head of a
 *   long conversation, the savings that compound most), and
 * - **rolling anchor** on the second-to-last user message (the position next
 *   turn's prefix still matches exactly, guaranteeing a cache read).
 *
 * The **last** message is never marked: it is new every turn, so a marker there
 * is a cache write with no matching read (reads already refresh the TTL). When
 * the only user message is also the last message, both anchors fall away.
 * Placement is defensive — at most 2 markers, only on blocks that exist. See
 * ADR-0001.
 */
function markConversationBreakpoints(messages: Array<{ role: string; content: unknown }>): void {
  const userIdx = messages.flatMap((m, i) => (m.role === "user" ? [i] : []));
  const anchors = new Set<number>();
  if (userIdx.length >= 1) anchors.add(userIdx[0]!); // fixed anchor
  if (userIdx.length >= 2) anchors.add(userIdx[userIdx.length - 2]!); // rolling anchor
  anchors.delete(messages.length - 1); // never mark the new last message
  for (const i of anchors) markLastBlock(messages[i]!);
}

/** Attach the cache breakpoint to a message's last content block, if any. */
function markLastBlock(message: { role: string; content: unknown }): void {
  if (!Array.isArray(message.content) || message.content.length === 0) return;
  const last = message.content[message.content.length - 1];
  if (last && typeof last === "object") {
    (last as { cache_control?: typeof CACHE_CONTROL }).cache_control = CACHE_CONTROL;
  }
}

/**
 * Accepts both nested `{type:function, function:{...}}` and flat `{name, parameters}` tools.
 * Tools are sorted alphabetically by name so the prefix is byte-identical across
 * turns (Cursor/MCP can emit them in varying order), then the last entry carries
 * the cache breakpoint. See ADR-0001.
 */
function mapTools(tools: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const t of tools) {
    const fn = ((t as { function?: Record<string, unknown> }).function ?? t) as Record<string, unknown>;
    if (typeof fn.name !== "string") continue;
    out.push({
      name: fn.name,
      description: fn.description ?? "",
      input_schema: fn.parameters ?? fn.input_schema ?? { type: "object", properties: {} },
    });
  }
  if (out.length === 0) return undefined;
  out.sort((a, b) => ((a.name as string) < (b.name as string) ? -1 : (a.name as string) > (b.name as string) ? 1 : 0));
  out[out.length - 1]!.cache_control = CACHE_CONTROL;
  return out;
}

/** All models use adaptive thinking; only the effort vocabulary differs. */
export function mapThinking(
  model: string,
  effort: Effort,
): { thinking: { type: "adaptive"; display: "summarized" }; output_config: { effort: string } } {
  return {
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: mapEffort(model, effort) },
  };
}

function mapEffort(model: string, effort: Effort): string {
  if (effort !== "xhigh") return effort; // low/medium/high pass through unchanged
  if (model.includes("fable")) return "xhigh"; // fable supports xhigh and max; xhigh is the agentic sweet spot
  if (model.includes("opus")) return "xhigh"; // opus-only top tier
  if (model.includes("sonnet")) return "max"; // sonnet rejects xhigh, accepts max
  return "high";
}

function safeParseJson(s: unknown): unknown {
  if (typeof s !== "string") return s ?? {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// --- streaming: Anthropic Messages SSE -> OpenAI chat.completion.chunk -------

export interface StreamOptions {
  model: string;
  report?: (usage: {
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
    cacheCreationTokens?: number;
  }) => void;
}

export function anthropicStreamToOpenAI(
  upstream: ReadableStream<Uint8Array>,
  opts: StreamOptions,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const id = newCompletionId();
  const created = Math.floor(Date.now() / 1000);
  let roleEmitted = false;
  let finishReason: string | null = null;
  let inputTokens = 0; // raw, EXCLUDING cache (as Anthropic reports it).
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let outputTokens = 0; // Anthropic reports this CUMULATIVELY in message_delta.
  // Anthropic content-block index -> sequential OpenAI tool_call index.
  const toolIndexByBlock = new Map<number, number>();
  let toolCount = 0;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (delta: Record<string, unknown>, finish: string | null = null): void => {
        if (!roleEmitted) {
          controller.enqueue(enc.encode(sse(chatChunk(id, opts.model, created, { role: "assistant" }))));
          roleEmitted = true;
        }
        controller.enqueue(enc.encode(sse(chatChunk(id, opts.model, created, delta, finish))));
      };

      try {
        for await (const data of parseAnthropicSSE(upstream)) {
          const ev = data as Record<string, unknown>;
          switch (ev.type) {
            case "message_start": {
              const usage = (ev.message as Record<string, unknown> | undefined)?.usage as
                | Record<string, unknown>
                | undefined;
              if (typeof usage?.input_tokens === "number") inputTokens = usage.input_tokens;
              if (typeof usage?.output_tokens === "number") outputTokens = usage.output_tokens;
              if (typeof usage?.cache_read_input_tokens === "number")
                cacheReadTokens = usage.cache_read_input_tokens;
              if (typeof usage?.cache_creation_input_tokens === "number")
                cacheCreationTokens = usage.cache_creation_input_tokens;
              break;
            }
            case "content_block_start": {
              const block = ev.content_block as Record<string, unknown> | undefined;
              if (block?.type === "tool_use") {
                const oaiIndex = toolCount++;
                toolIndexByBlock.set(ev.index as number, oaiIndex);
                emit({
                  tool_calls: [
                    {
                      index: oaiIndex,
                      id: block.id,
                      type: "function",
                      function: { name: block.name ?? "", arguments: "" },
                    },
                  ],
                });
              }
              break;
            }
            case "content_block_delta": {
              const delta = ev.delta as Record<string, unknown> | undefined;
              if (delta?.type === "text_delta" && typeof delta.text === "string") {
                emit({ content: delta.text });
              } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
                emit({ reasoning_content: delta.thinking });
              } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
                const oaiIndex = toolIndexByBlock.get(ev.index as number) ?? 0;
                emit({ tool_calls: [{ index: oaiIndex, function: { arguments: delta.partial_json } }] });
              }
              break;
            }
            case "message_delta": {
              const d = ev.delta as { stop_reason?: string } | undefined;
              if (d?.stop_reason) finishReason = mapStopReason(d.stop_reason);
              const usage = ev.usage as { output_tokens?: number } | undefined;
              if (typeof usage?.output_tokens === "number") outputTokens = usage.output_tokens;
              break;
            }
            default:
              break;
          }
        }
        emit({}, finishReason ?? "stop");
        // OpenAI semantics: `prompt_tokens` is the full input, cached tokens
        // included (the detail lives in `prompt_tokens_details.cached_tokens`).
        // Anthropic splits these out (`input_tokens` excludes cache), so we
        // re-add cache read + creation to get the true context size. Cursor's
        // Context Usage reads this; sending raw `input_tokens` under-counts the
        // window. The store report uses the same value so the cache rate stays
        // coherent.
        const promptTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
        const usageChunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model: opts.model,
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: outputTokens,
            total_tokens: promptTokens + outputTokens,
            prompt_tokens_details: { cached_tokens: cacheReadTokens },
          },
        };
        controller.enqueue(enc.encode(sse(usageChunk)));
        opts.report?.({
          promptTokens,
          completionTokens: outputTokens,
          cachedTokens: cacheReadTokens,
          cacheCreationTokens: cacheCreationTokens,
        });
        controller.enqueue(enc.encode(SSE_DONE));
        controller.close();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        emit({ content: `\n\n[cursor-relay] stream error: ${message}` }, "stop");
        controller.enqueue(enc.encode(SSE_DONE));
        controller.close();
      }
    },
  });
}

function mapStopReason(reason: string): string {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      return "stop";
  }
}

async function* parseAnthropicSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  for await (const block of sseBlocks(stream)) {
    const ev = parseSSEEvent(block);
    if (!ev) continue;
    try {
      yield JSON.parse(ev.data);
    } catch {
      // skip non-JSON data blocks
    }
  }
}
