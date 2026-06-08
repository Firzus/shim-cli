# Context — Glossary

Canonical vocabulary for `shim-cli`. Terms here are the names we use in code, issues, and discussion. Avoid the listed synonyms.

## Terms

### Cache breakpoint
A single `cache_control: { type: "ephemeral" }` marker placed on a content block (or tool definition) in an Anthropic Messages request. Everything from the start of the request up to and including a breakpoint forms a cacheable prefix. Anthropic allows at most **4** breakpoints per request.

- Use: "cache breakpoint", "breakpoint".
- Avoid: "cache point", "cache anchor", "cache tag".

### Conversation breakpoint
A cache breakpoint placed on conversation history (as opposed to the stable `system`/`tools` prefix). Anchored on **user** messages only, which are the stable turn boundaries. Two are used: a **fixed anchor** on the first user message (caches the immutable head of the conversation) and a **rolling anchor** on the second-to-last user message (the position next turn's prefix still matches). The last message is never marked.

- Use: "conversation breakpoint", "fixed anchor", "rolling anchor".
- Avoid: "history cache", "message cache", "pre-warm".

### Cache rate
The session-level ratio `cached_tokens / prompt_tokens` shown in the TUI. `cached_tokens` is Anthropic's `cache_read_input_tokens`; `prompt_tokens` is the normalized full input (raw input + cache read + cache creation).

- Use: "cache rate".
- Avoid: "hit rate", "cache ratio".

### Prefix (cacheable prefix)
The exact byte sequence from the start of a request up to a cache breakpoint. Anthropic reuses a cache entry only on an exact prefix match against a prior request, so request translation must be deterministic.

- Use: "prefix", "cacheable prefix".
- Avoid: "cache key".
