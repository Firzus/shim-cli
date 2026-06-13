# 7. Codex prompt-cache controls and signals

Status: Accepted.

## Context

The Codex provider calls the ChatGPT Codex backend with an OpenAI Responses
payload, then converts the stream back to OpenAI Chat Completions chunks for
Cursor. OpenAI Prompt Caching is automatic for long prompts and reports cache
reads as `cached_tokens`, but Responses does not expose an Anthropic-style
`cache_creation_input_tokens` counter.

OpenAI's prompt-caching guide also documents request-level controls:
`prompt_cache_key` influences cache routing for requests that share common
prefixes, and `prompt_cache_retention` can request extended cache retention
where the selected model supports it.

## Decision

For Codex requests, cursor-relay sends:

- `prompt_cache_key` scoped to the conversation. If the caller supplies a valid
  key, it is preserved. Otherwise cursor-relay derives a short stable key from
  the upstream model and the first user turn, which is the only immutable
  conversation identity Cursor exposes through Chat Completions.
- `prompt_cache_retention: "24h"`, requesting extended retention for eligible
  Responses models.

The same conversation key is used as the Codex upstream session/conversation id
so the private Codex backend sees stable request continuity across turns, rather
than a fresh random session for every proxied request.

The Codex provider also sorts function tools by name before sending them to
Responses, matching the Claude provider's prefix-stability rule.

If the private ChatGPT Codex backend rejects `prompt_cache_retention`, the
provider retries without retention but keeps `prompt_cache_key`. Only an
explicit `prompt_cache_key` rejection removes the key. The retry preserves
compatibility while keeping the cache-optimized path as intact as possible.

## Consequences

- Codex rows can report `cached_tokens` and participate in the cache rate.
- Codex rows do not report `cache_creation`; the TUI must not invent a `wrote`
  witness for Codex.
- The OpenAI-compatible usage chunk includes
  `prompt_tokens_details.cached_tokens`, so cache reads are visible both to the
  store and to clients that inspect usage.
