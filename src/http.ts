/** Read a response body as text without throwing, capped at `limit` chars. */
export async function safeResponseText(
  res: { text(): Promise<string> },
  opts: { limit: number; fallback: string },
): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, opts.limit) || opts.fallback;
  } catch {
    return opts.fallback;
  }
}
