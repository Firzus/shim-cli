export interface Timeout {
  readonly signal: AbortSignal;
  clear(): void;
  abort(reason?: unknown): void;
}

/** An AbortController that auto-aborts after `ms`, with a clear label for errors. */
export function withTimeout(ms: number, label: string): Timeout {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out after ${ms}ms`)), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
    abort: (reason?: unknown) => {
      clearTimeout(timer);
      controller.abort(reason);
    },
  };
}

/** Read a response body as text without throwing, capped at `limit` chars. */
export async function safeResponseText(
  res: Response,
  opts: { limit: number; fallback: string },
): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, opts.limit) || opts.fallback;
  } catch {
    return opts.fallback;
  }
}
