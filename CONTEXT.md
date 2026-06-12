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
The ratio `SUM(cached_tokens) / SUM(prompt_tokens)` over **all measured requests** in the activity database — the whole retained history, bounded by the 7-day [[retention]] — shown in the TUI as a single percent plus a `X cached / Y input` detail (no sparkline, per ADR-0005). `cached_tokens` is Anthropic's `cache_read_input_tokens`; `prompt_tokens` is the normalized full input (raw input + cache read + cache creation). Only **measured** requests count — a request whose cache tokens were never reported is excluded, not treated as a 0% miss. The aggregation runs in SQL (the TUI polls). It measures cache *efficiency* — distinct from [[plan-usage]], which measures quota *consumption*. The request/error **counters** share the same scope (per ADR-0005, the `w` period was removed).

- Use: "cache rate".
- Avoid: "hit rate", "cache ratio", "live cache rate" (the rate is a long-run figure; the live signal is the per-row `cached`/`wrote` witnesses), "windowed cache rate" (the panel has no time window; the 7-day bound is retention, not a query window).

### Cold cache write
A turn that *writes* the prompt cache rather than reading it: Anthropic reports `cache_creation_input_tokens` (persisted as the activity column `cache_creation`), distinct from the `cache_read_input_tokens` of a warm read. Both inflate `prompt_tokens`, so a cold write is otherwise indistinguishable from a legitimately large prompt and dips the [[cache-rate]] with no visible cause — the TUI surfaces it as a `wrote N` witness on the activity row to make the dip legible. `cache_creation` is shown **alongside** the cache rate, never folded into it: the rate stays `cache_read / prompt_tokens` per ADR-0004.

- Use: "cold cache write", "cache creation", "wrote witness".
- Avoid: "cache miss" (a cold write populates the cache; it is not a wasted read), folding creation into the cache rate.

### Plan usage
Real subscription-quota consumption, read from Anthropic's `anthropic-ratelimit-unified-{5h,7d}-*` response headers (not self-computed): two windows, **5h** and **weekly**, each with a `utilization` percent and a reset time. The authoritative "how much of my plan have I burned" signal; caching shows up here as slower utilization growth.

- Use: "plan usage".
- Avoid: "cache rate" (different concept — efficiency vs consumption), "quota meter".

### Retention
The storage bound on the activity database: rows older than **7 days** are deleted (`purgeExpiredActivity`, run by the service at startup and hourly — the TUI never purges). It bounds what is *stored*, not what is *queried*: the [[cache-rate]] and counter queries stay unwindowed whole-table scans (ADR-0006). Distinct from a UI time window (removed by ADR-0005) and from quota windows ([[plan-usage]]'s 5h/weekly).

- Use: "retention", "7-day retention".
- Avoid: "time window", "TTL", "history limit".

### Prefix (cacheable prefix)
The exact byte sequence from the start of a request up to a cache breakpoint. Anthropic reuses a cache entry only on an exact prefix match against a prior request, so request translation must be deterministic.

- Use: "prefix", "cacheable prefix".
- Avoid: "cache key".
