/**
 * Frozen provider contract. The server normalizes nothing provider-specific:
 * it resolves the active Selection from the store, then hands the raw OpenAI
 * request body + selection to a Provider, which owns its own translation,
 * upstream call, and OpenAI-SSE output. This keeps Codex (Responses API) and
 * Claude (Messages API) fully decoupled behind one interface.
 */

export type ProviderId = "claude" | "codex";

export type Effort = "low" | "medium" | "high" | "xhigh";

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh"] as const;

/** The single mutable piece of state, shared via the store between TUI and service. */
export interface Selection {
  provider: ProviderId;
  model: string;
  effort: Effort;
}

export interface ProviderModel {
  /** Concrete upstream model id, e.g. "claude-opus-4-8" or "gpt-5.4". */
  id: string;
  /** Short display label for the selector. */
  label: string;
  /** Efforts this model supports, in ascending order, for the TUI selector. */
  efforts: readonly Effort[];
}

export interface AuthStatus {
  ok: boolean;
  /** Human-readable detail, e.g. "max plan · expires in 124m" or "credentials not found". */
  detail: string;
  /** Epoch ms when the current token expires, if known. */
  expiresAt?: number;
}

export interface UsageWindow {
  /** e.g. "5h" or "weekly". */
  label: string;
  usedPct: number;
  /** Epoch ms when this window resets, if known. */
  resetAt?: number;
}

/** Per-request context handed to a provider. */
export interface ChatContext {
  selection: Selection;
  /** Raw OpenAI-compatible request body as sent by Cursor (messages[] or input[]). */
  body: Record<string, unknown>;
  requestId: string;
  /** Aborted when the client disconnects. */
  signal: AbortSignal;
  /** Provider reports token usage here for activity logging (may be called once at end). */
  report(usage: {
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
    cacheCreationTokens?: number;
  }): void;
}

export interface Provider {
  readonly id: ProviderId;
  /**
   * Whether this provider captures real plan-usage snapshots (from upstream
   * rate-limit headers) into the store. The TUI scopes its plan-usage block to
   * the active provider and uses this to tell "no data yet" (capable, not yet
   * captured) from "n/a" (not capable, e.g. codex has no rate-limit headers).
   */
  readonly reportsPlanUsage: boolean;
  /** Concrete models this provider can serve, for the TUI selector. */
  models(): readonly ProviderModel[];
  /** Current auth state of the underlying credential source. */
  authStatus(): Promise<AuthStatus>;
  /** Plan usage windows for the dashboard, or [] if unavailable. */
  usage(): Promise<UsageWindow[]>;
  /**
   * Produce an OpenAI `chat.completion.chunk` SSE byte stream for Cursor,
   * terminated by `data: [DONE]`. The provider performs all translation.
   */
  chat(ctx: ChatContext): Promise<ReadableStream<Uint8Array>>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body = "",
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
