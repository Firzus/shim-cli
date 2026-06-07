/** Anthropic Messages API calls for the Claude provider (OAuth bearer path). */

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

// Mimic the Claude Code client. The OAuth path is gated on these (plus the
// identity system block, injected by the translator).
const CLAUDE_CLI_VERSION = "2.1.168";

export function buildHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
    "user-agent": `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`,
    "x-app": "cli",
    "anthropic-dangerous-direct-browser-access": "true",
    "content-type": "application/json",
  };
}

/** POST a (streaming) request to the Messages API. Caller handles retries/translation. */
export function callClaude(
  body: unknown,
  accessToken: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(MESSAGES_URL, {
    method: "POST",
    headers: buildHeaders(accessToken),
    body: JSON.stringify(body),
    signal,
  });
}
