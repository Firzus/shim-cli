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
The ratio `cached_tokens / prompt_tokens` over the **last N requests** (a request-count window, not a time window), shown in the TUI. `cached_tokens` is Anthropic's `cache_read_input_tokens`; `prompt_tokens` is the normalized full input (raw input + cache read + cache creation). Only **measured** requests count — a request whose cache tokens were never reported is excluded, not treated as a 0% miss. A request-count window converges within a single Cursor response (one response is a burst of proxy requests) and is immune to stale history lingering in a time window. It measures cache *efficiency* — distinct from [[plan-usage]], which measures quota *consumption*. Distinct also from the request/error **counters**, which remain time-windowed (the `w` period).

- Use: "cache rate", "live cache rate".
- Avoid: "hit rate", "cache ratio", "windowed cache rate" (the cache rate is request-count scoped; only the counters are time-windowed).

### Cold cache write
A turn that *writes* the prompt cache rather than reading it: Anthropic reports `cache_creation_input_tokens` (persisted as the activity column `cache_creation`), distinct from the `cache_read_input_tokens` of a warm read. Both inflate `prompt_tokens`, so a cold write is otherwise indistinguishable from a legitimately large prompt and dips the live [[cache-rate]] with no visible cause — the TUI surfaces it as a `wrote N` witness on the activity row to make the dip legible. `cache_creation` is shown **alongside** the cache rate, never folded into it: the rate stays `cache_read / prompt_tokens` per ADR-0003.

- Use: "cold cache write", "cache creation", "wrote witness".
- Avoid: "cache miss" (a cold write populates the cache; it is not a wasted read), folding creation into the cache rate.

### Plan usage
Real subscription-quota consumption, read from Anthropic's `anthropic-ratelimit-unified-{5h,7d}-*` response headers (not self-computed): two windows, **5h** and **weekly**, each with a `utilization` percent and a reset time. The authoritative "how much of my plan have I burned" signal; caching shows up here as slower utilization growth.

- Use: "plan usage".
- Avoid: "cache rate" (different concept — efficiency vs consumption), "quota meter".

### Prefix (cacheable prefix)
The exact byte sequence from the start of a request up to a cache breakpoint. Anthropic reuses a cache entry only on an exact prefix match against a prior request, so request translation must be deterministic.

- Use: "prefix", "cacheable prefix".
- Avoid: "cache key".
