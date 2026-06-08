# 1. Claude prompt-cache breakpoints

Date: 2026-06-08

## Status

Accepted

## Context

The Claude provider translates OpenAI Chat Completions requests into Anthropic
Messages requests (`src/providers/claude/translate.ts`). Anthropic prompt
caching is **opt-in**: a request only benefits from caching if it carries
explicit `cache_control` markers on content blocks. Without markers, every turn
re-bills the full prompt (Claude Code identity + Cursor's system prompt + tool
definitions + entire conversation history) as fresh input.

The translator read back `cache_read_input_tokens` / `cache_creation_input_tokens`
from responses (to drive the TUI cache rate) but never wrote a single
`cache_control` marker on the request. As a result the observed cache rate was
structurally near 0%, inflating subscription/plan usage on long Cursor sessions
where the stable prefix (identity + system + tools) is large and resent verbatim
each turn.

Anthropic constraints that shaped the decision:

- At most **4** `cache_control` breakpoints per request.
- Caching requires an **exact prefix match** against a prior request; request
  translation must be deterministic.
- A cached prefix must be **≥ 1024 tokens** (Sonnet/Opus) or the breakpoint is
  silently ignored — no error, no cache.
- The default 5-minute (`ephemeral`) TTL is cheapest to write and is **refreshed
  on every cache read**, so a continuously active session stays warm.
- Cursor is stateless and replays full conversation history each turn.

## Decision

Inject `cache_control: { type: "ephemeral" }` (5-minute TTL) in
`buildAnthropicRequest`, spending the full 4-breakpoint budget. The placement is
ported from the predecessor tool (`Firzus/shim`,
`anthropic/translation/claude-code-body.ts`), which ran this scheme in
production:

1. **Tools** — sort `tools[]` alphabetically by name, then mark the **last**
   entry. The sort is load-bearing: Cursor/MCP can emit tools in varying order
   between turns, and without a stable order the tools prefix changes byte-for-
   byte every request and **never** caches.
2. **System** — last block of `system[]` (identity + Cursor system prompt).
3. **Conversation (×2)** — anchor on **user** messages only, which are the stable
   turn boundaries:
   - the **first** user message (fixed anchor — caches the immutable head of a
     long conversation, the savings that compound most), and
   - the **second-to-last** user message (rolling anchor — the position next
     turn's prefix still matches exactly, guaranteeing a cache read).
   The **last** message is deliberately **never** marked: it is new every turn,
   so marking it forces a cache *write* with no matching read. Cache reads
   already refresh the 5-minute TTL on the whole prefix, so explicit "pre-warm"
   of the last message buys nothing.

Placement is **defensive**: a marker is only emitted where its target exists
(no `tools` → skip; fewer than 2 user messages → fewer conversation markers), so
the request never exceeds 4 markers and never references a missing block.

Decisions made:

- **User-message anchoring (first + second-to-last)**, not last+second-to-last of
  any role. Chosen over the initial theoretical plan because the predecessor
  tool proved it, and the "pre-warm the last message" intuition was wrong (it
  only adds write cost; reads already refresh the TTL).
- **Alphabetical tool sort** before marking, to keep the tools prefix
  deterministic across turns.
- **5-minute TTL**, not 1-hour extended. Active sessions reuse within minutes;
  the 1-hour tier doubles write cost and only helps across long idle gaps.
- **No token-size guard** on conversation markers. Sub-1024 prefixes are ignored
  by Anthropic at no cost, so always placing them is simpler and self-correcting
  as history grows.
- **Claude-only.** The Codex provider uses OpenAI's Responses API, which caches
  automatically without markers.
- **Verification** via unit tests pinning marker placement plus the existing TUI
  cache-rate readout; no new telemetry.

## Consequences

- Long sessions should see the cache rate climb from ~0% to the typical 60–90%
  range for agentic workloads, cutting billed input tokens substantially.
- `buildAnthropicRequest` must stay **deterministic** — any non-determinism in
  block ordering, tool batching, or text extraction breaks exact-prefix matching
  and silently kills cache hits. The concrete known threat is **tool ordering**
  (handled by the alphabetical sort); tests must guard this.
- The marker-placement logic is coupled to Anthropic's 4-breakpoint cap and the
  message-array shape produced by the translator; changes to either must keep the
  budget and targeting in sync.
- The first turn of a session will not hit cache (nothing to match yet); savings
  begin on the second turn onward.
