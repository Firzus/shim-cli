/** ChatGPT Codex Responses API calls for the Codex provider. */

const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const ORIGINATOR = "codex_cli_rs";
const VERSION = "0.150.0";
const USER_AGENT = `codex_cli_rs/${VERSION} (cursor-relay)`;

export function buildHeaders(
  accessToken: string,
  accountId: string,
  sessionId: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Chatgpt-Account-Id": accountId,
    Originator: ORIGINATOR,
    Version: VERSION,
    Session_id: sessionId,
    Conversation_id: sessionId,
    "session-id": sessionId,
    "thread-id": sessionId,
    "x-client-request-id": sessionId,
    "User-Agent": USER_AGENT,
    Accept: "text/event-stream",
    "content-type": "application/json",
  };
}

/** POST a (streaming) request to the Codex Responses endpoint. */
export function callCodex(
  body: unknown,
  auth: { accessToken: string; accountId: string },
  sessionId: string,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(RESPONSES_URL, {
    method: "POST",
    headers: buildHeaders(auth.accessToken, auth.accountId, sessionId),
    body: JSON.stringify(body),
    signal,
  });
}
