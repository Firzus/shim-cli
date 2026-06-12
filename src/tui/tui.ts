import {
  BoxRenderable,
  bold,
  createCliRenderer,
  cyan,
  dim,
  green,
  type KeyEvent,
  red,
  StyledText,
  stringToStyledText,
  type TextChunk,
  TextRenderable,
  yellow,
} from "@opentui/core";
import { PORT, TUNNEL_HOSTNAME } from "../config.ts";
import { allProviders, getProvider } from "../providers/registry.ts";
import {
  type ActivityFilter,
  type ActivityRow,
  activityCounters,
  activityPage,
  type CacheTotals,
  cacheTotals,
  getPlanUsage,
  getSelection,
  pendingCount,
  type PlanWindow,
  setSelection,
} from "../store/state.ts";
import type { AuthStatus, Effort, ProviderId, ProviderModel, Selection } from "../providers/types.ts";
import { createClipboard } from "./clipboard.ts";

/** Keep the current effort if the target model supports it, else fall back to its first (or "medium"). */
export function preserveEffort(efforts: readonly Effort[], current: Effort): Effort {
  return efforts.includes(current) ? current : (efforts[0] ?? "medium");
}

/** Abbreviate a count with k/M suffixes above 1000 (e.g. 1234 → "1.2k"). */
export function abbreviateCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

/**
 * The per-request token segment for an activity row: `pt→ct` plus a
 * parenthesised cache witness — `cached X` when cache reads landed (the
 * per-request proof the breakpoints work), and `wrote Y` when the turn paid a
 * cold cache *write* (`cache_creation`). The `wrote` witness is what tells a
 * cold-write turn apart from a legitimately large prompt: both inflate
 * `prompt_tokens`, but only the cold write shows `wrote Y`. Both segments can
 * appear together (`cached X, wrote Y`). Each is omitted when its count is 0 or
 * unmeasured, to avoid `cached 0` / `wrote 0` noise. Empty when no token counts
 * were recorded (e.g. a pending row). Pure (no color) — prior art: cacheRateView.
 */
export function formatActivityTokens(row: {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  cache_creation?: number | null;
}): string {
  if (row.prompt_tokens == null && row.completion_tokens == null) return "";
  const pt = row.prompt_tokens ?? "?";
  const ct = row.completion_tokens ?? "?";
  const parts: string[] = [];
  if (row.cached_tokens != null && row.cached_tokens > 0) {
    parts.push(`cached ${abbreviateCount(row.cached_tokens)}`);
  }
  if (row.cache_creation != null && row.cache_creation > 0) {
    parts.push(`wrote ${abbreviateCount(row.cache_creation)}`);
  }
  const witness = parts.length ? ` (${parts.join(", ")})` : "";
  return ` ${pt}→${ct}tok${witness}`;
}

export type UsageLevel = "ok" | "warn" | "crit";

/**
 * Threshold band for a utilization fraction, mapped to colour by the caller.
 * `warn` at 70%, `crit` at 90% — comfortable headroom before the plan is spent.
 */
export function usageLevel(utilization: number): UsageLevel {
  if (utilization >= 0.9) return "crit";
  if (utilization >= 0.7) return "warn";
  return "ok";
}

/** Human countdown from `now` to `resetAt` (both epoch ms). Pure. */
export function formatResetCountdown(resetAt: number, now: number): string {
  const ms = resetAt - now;
  if (ms <= 0) return "now";
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "<1m";
}

const BAR_WIDTH = 10;

/** One plan-usage line, split so the mount can colour each part by its role. */
export interface PlanUsageParts {
  /** Window label, padded for vertical alignment — dim. */
  label: string;
  /** The usage bar — coloured by `usageLevel`. */
  bar: string;
  /** The percent, width-stable — coloured by `usageLevel`. */
  pct: string;
  /** The reset countdown — neutral, readable regardless of usage level. */
  reset: string;
  /** A non-"allowed" status (e.g. "rejected"), or "" — surfaced as critical. */
  flag: string;
}

/**
 * Render one plan-usage line as parts (without colour): label, `[████░░░░░░]`,
 * ` 71%`, `resets in 1h 2m`, and a status flag when the window is not
 * "allowed" — so a throttled window is visible, not just implied by colour.
 * Utilization is a 0–1 fraction; the caller colours the bar + percent by
 * `usageLevel` and keeps the label and countdown neutral. Pure.
 */
export function planUsageParts(label: string, window: PlanWindow, now: number): PlanUsageParts {
  const frac = Math.max(0, Math.min(1, window.utilization));
  const filled = Math.round(frac * BAR_WIDTH);
  return {
    label: label.padEnd(7),
    bar: `[${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}]`,
    pct: `${String(Math.round(frac * 100)).padStart(3)}%`,
    reset: `resets in ${formatResetCountdown(window.resetAt, now)}`,
    flag: window.status && window.status !== "allowed" ? window.status : "",
  };
}

/**
 * Optimistic reset: once `now` passes a window's reset boundary, force its
 * utilization to 0 before formatting, so a passed reset reads as a fresh 0%
 * window rather than a stale frozen percent. Otherwise the window is returned
 * untouched. Pure — the accepted under-report trade-off is documented in
 * ADR-0002 (plan usage is the authoritative signal, captured from headers).
 */
export function optimisticReset(window: PlanWindow, now: number): PlanWindow {
  if (now > window.resetAt) return { ...window, utilization: 0 };
  return window;
}

/** The cache-rate line, split so the mount can colour each part by its role. */
export interface CacheRateView {
  /** `cache` — dim. */
  label: string;
  /** Aggregate percent over the retained history (0% with no measured rows) — value brightness. */
  value: string;
  /** `1.2k cached / 2.7k input`, or "" with no measured rows — dim. */
  detail: string;
}

/**
 * Derive the cache-rate line from the cache totals. Per ADR-0004 the rate is
 * `Σcached / Σinput` over the whole measured retained history and cache
 * creation is never folded in. No measured rows renders 0%. Pure.
 */
export function cacheRateView(totals: CacheTotals): CacheRateView {
  const label = "cache";
  if (totals.input <= 0) return { label, value: "0%", detail: "" };
  return {
    label,
    value: `${Math.round((totals.cached / totals.input) * 100)}%`,
    detail: `${abbreviateCount(totals.cached)} cached / ${abbreviateCount(totals.input)} input`,
  };
}

/** One labelled value for the traffic section — label dim, value bright. */
export interface LabelledValue {
  label: string;
  value: string;
}

/**
 * The counters line as label/value pairs: requests + errors over the retained
 * history. In-flight
 * load lives in the activity frame title, where the requests themselves appear.
 * Counts are abbreviated like the rest of the panel. Pure.
 */
export function countersView(c: { requests: number; errors: number }): LabelledValue[] {
  return [
    { label: "requests", value: abbreviateCount(c.requests) },
    { label: "errors", value: abbreviateCount(c.errors) },
  ];
}

/** Minimum terminal size the three-zone chrome needs to render legibly. */
export const MIN_COLS = 60;
export const MIN_ROWS = 10;

/**
 * Whether the terminal is too small for the full chrome — below the minimum the
 * panel degrades to a clear message instead of breaking. Pure.
 */
export function isTerminalTooSmall(cols: number, rows: number): boolean {
  return cols < MIN_COLS || rows < MIN_ROWS;
}

// --- status bar presenters (pure) --------------------------------------------

/** Semantic state of a provider auth dot, mapped to colour by the caller. */
export type AuthDotState = "ok" | "down" | "pending";

/**
 * Map an auth status (or its absence, before the first check) to a dot state.
 * `pending` is the dim "not checked yet" state; `down` carries an error the
 * caller surfaces inline. Pure.
 */
export function authDotState(auth: AuthStatus | undefined): AuthDotState {
  if (!auth) return "pending";
  return auth.ok ? "ok" : "down";
}

/** Endpoint URL + tunnel state for the meta strip. `up` when a tunnel hostname is configured. */
export interface EndpointInfo {
  url: string;
  tunnel: "up" | "off";
}

/**
 * Where Cursor should point, plus whether a tunnel fronts it. The TUI only
 * knows the configured hostname (it does not run the tunnel), so `up` means
 * "a public hostname is configured", `off` means local-only. Pure.
 */
export function formatEndpoint(tunnelHostname: string, port: number): EndpointInfo {
  if (tunnelHostname) return { url: `https://${tunnelHostname}/v1`, tunnel: "up" };
  return { url: `http://127.0.0.1:${port}/v1`, tunnel: "off" };
}

/**
 * Truncate an inline detail (e.g. a down provider's auth error) to `max`
 * characters, appending an ellipsis when cut, so a long message cannot blow out
 * the meta strip. Pure.
 */
export function truncateDetail(detail: string, max = 48): string {
  if (detail.length <= max) return detail;
  return `${detail.slice(0, max - 1)}…`;
}

/**
 * The inline label for one provider in the meta strip: just the id when the
 * provider is ok or unchecked, or `id detail` (truncated) when it is down — so
 * an auth failure is diagnosable without leaving the panel. Pure.
 */
export function formatAuthMeta(id: string, auth: AuthStatus | undefined): string {
  if (auth && !auth.ok && auth.detail) return `${id} ${truncateDetail(auth.detail)}`;
  return id;
}

// --- activity stream presenters (pure) ---------------------------------------

/** Braille spinner frames + their advance interval (ms), for in-flight liveness. */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;

/**
 * The spinner frame for a given wall-clock `now`. Deterministic — the frame is
 * a function of time, so two renders at the same instant agree and the ~100ms
 * animation tick advances it smoothly. Pure.
 */
export function spinnerFrame(now: number): string {
  const i = Math.floor(Math.max(0, now) / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[i]!;
}

/**
 * Live elapsed since a row started (`ts`), as a ticking timer: `1.5s` under a
 * minute, `2m 3s` beyond. Takes an injected `now` so it is deterministic. Pure.
 */
export function formatElapsed(ts: number, now: number): string {
  const ms = Math.max(0, now - ts);
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/**
 * The status column content: glyph + word so state is legible even when colour
 * rendering is poor — `✓ ok`, `✗ error`, a braille spinner while pending, the
 * raw word for anything else. Pure (the spinner is a function of `now`).
 */
export function statusCellText(status: string, now: number): string {
  if (status === "ok") return "✓ ok";
  if (status === "error") return "✗ error";
  if (status === "pending") return spinnerFrame(now);
  return status;
}

/** A model's display label as a compact slug for the source column (e.g. "Fable 5" → "fable-5"). Pure. */
export function slugLabel(label: string): string {
  return label.toLowerCase().replace(/\s+/g, "-");
}

/**
 * The activity frame title: a live in-flight count (with spinner) when requests
 * are pending — load shown where the requests themselves appear — and the plain
 * title when idle. Pure.
 */
export function activityTitle(inFlight: number, now: number): string {
  if (inFlight <= 0) return " activity ";
  return ` activity · ${spinnerFrame(now)} ${abbreviateCount(inFlight)} in-flight `;
}

/** The kind of an activity column, so the mount can colour each segment. */
export type ActivityCellKind = "time" | "status" | "source" | "tokens" | "note" | "duration" | "elapsed";

/** One plain-text column of an activity row, tagged for colouring. */
export interface ActivityCell {
  text: string;
  kind: ActivityCellKind;
}

/** Shape an activity presenter reads — the columns it builds from. */
interface ActivityRowInput {
  ts: number;
  status: string;
  provider: string;
  model: string;
  duration_ms: number | null;
  note: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  cache_creation: number | null;
}

/**
 * The five fixed table slots of one activity row (left→right): time, status
 * (glyph + word), source (`provider/short-label`, via the optional `labels`
 * map), witness, duration. The witness slot carries the token segment, an error
 * row's truncated note, or a pending row's ticking elapsed timer; the duration
 * slot is "" when not yet known. Every row emits all five slots (empty text
 * where there is nothing) so `padColumns` can align them into fixed-width
 * columns across rows. Colour is the caller's job; pure, and takes the
 * already-formatted `timeStr` plus an injected `now` so tests stay deterministic.
 */
export function activityColumns(
  row: ActivityRowInput,
  timeStr: string,
  now: number,
  opts: { noteMax?: number; labels?: ReadonlyMap<string, string> } = {},
): ActivityCell[] {
  const short = opts.labels?.get(row.model) ?? row.model;
  const cells: ActivityCell[] = [
    { text: timeStr, kind: "time" },
    { text: statusCellText(row.status, now), kind: "status" },
    { text: `${row.provider}/${short}`, kind: "source" },
  ];
  if (row.status === "pending") {
    cells.push({ text: formatElapsed(row.ts, now), kind: "elapsed" });
  } else if (row.status === "error" && row.note) {
    cells.push({ text: truncateDetail(row.note, opts.noteMax ?? 32), kind: "note" });
  } else {
    cells.push({ text: formatActivityTokens(row).trim(), kind: "tokens" });
  }
  cells.push({ text: row.duration_ms != null ? `${row.duration_ms}ms` : "", kind: "duration" });
  return cells;
}

/**
 * Pad each slot to its column's max width across all rows so the stream renders
 * as an aligned table: duration is right-aligned (outlier latencies jump out),
 * everything else left-aligned. Pure.
 */
export function padColumns(rows: ActivityCell[][]): ActivityCell[][] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.text.length);
    });
  }
  return rows.map((row) =>
    row.map((cell, i) => ({
      ...cell,
      text: cell.kind === "duration" ? cell.text.padStart(widths[i]!) : cell.text.padEnd(widths[i]!),
    })),
  );
}

/**
 * Keep the leftmost columns that fit within `width` (joined by a `gap`-space
 * separator), dropping the rightmost columns first so a narrow terminal sheds
 * duration, then the witness, etc., rather than wrapping. Pure.
 */
export function clipColumns(cells: ActivityCell[], width: number, gap = 1): ActivityCell[] {
  const kept: ActivityCell[] = [];
  let used = 0;
  for (const cell of cells) {
    const add = (kept.length ? gap : 0) + cell.text.length;
    if (used + add > width) break;
    kept.push(cell);
    used += add;
  }
  return kept;
}

// --- input modes + footer hints (pure) ----------------------------------------

/**
 * The modal input-mode concept: while a picker is open, global keys are inert
 * and the footer hints swap to the picker's controls. The activity detail is
 * *not* modal — it expands inline and ↑↓ navigation keeps working — so it is
 * not a mode, just a per-row expanded flag tracked in the default mode.
 */
export type InputModeKind = "default" | "picker";

/** One footer hint: the trigger key and the action word it triggers. */
export interface Hint {
  key: string;
  label: string;
}

/**
 * The context the footer reflects: the input mode, plus (in default mode)
 * whether follow is paused, whether a row is focused, and the active filter —
 * so the keycaps cannot drift from what the keys actually do right now.
 */
export interface FooterContext {
  mode: InputModeKind;
  paused?: boolean;
  focused?: boolean;
  filter?: ActivityFilter;
}

/** The footer hints for the current context — one source for the whole footer. Pure. */
export function hintsFor(ctx: FooterContext): Hint[] {
  if (ctx.mode === "picker") {
    return [
      { key: "↑↓", label: "move" },
      { key: "⏎", label: "select" },
      { key: "esc", label: "cancel" },
    ];
  }
  const hints: Hint[] = [];
  if (ctx.paused) hints.push({ key: "esc", label: "resume" });
  hints.push({ key: "↑↓", label: "move" });
  if (ctx.focused) hints.push({ key: "⏎", label: "detail" });
  hints.push({ key: "f", label: `filter ${ctx.filter ?? "all"}` });
  hints.push({ key: "p", label: "provider" });
  hints.push({ key: "m", label: "model" });
  hints.push({ key: "e", label: "effort" });
  hints.push({ key: "c", label: ctx.focused ? "copy id" : "copy" });
  hints.push({ key: "q", label: "quit" });
  return hints;
}

/** Cycle the activity status filter: all → errors → pending → all. Pure. */
export function cycleFilter(filter: ActivityFilter): ActivityFilter {
  return filter === "all" ? "errors" : filter === "errors" ? "pending" : "all";
}

/**
 * The paused-follow separator text: a plain marker, or one carrying the count
 * of rows that arrived at the head while follow was paused. Pure.
 */
export function followSeparator(newCount: number): string {
  if (newCount <= 0) return "── follow paused ──";
  return `── follow paused · ${abbreviateCount(newCount)} new ──`;
}

/**
 * Split a hint into its keycap and the rest of the word: `[p]` + `rovider` when
 * the label starts with the key, `[esc]` + ` cancel` otherwise — so the mount
 * highlights the trigger and dims the remainder. Pure.
 */
export function keycapParts(hint: Hint): { cap: string; rest: string } {
  const cap = `[${hint.key}]`;
  const rest = hint.label.startsWith(hint.key) ? hint.label.slice(hint.key.length) : ` ${hint.label}`;
  return { cap, rest };
}

// --- selection pickers (pure state machine) ------------------------------------

/** Which selection a picker chooses, matching its trigger key (p/m/e). */
export type PickerKind = "provider" | "model" | "effort";

/** One selectable option: the id committed to the store + its display label. */
export interface PickerOption {
  id: string;
  label: string;
}

/** A picker's whole state: its options, the highlight, and the current choice. */
export interface PickerState {
  kind: PickerKind;
  options: PickerOption[];
  /** The highlighted row (moved by ↑↓ / repeat trigger key). */
  index: number;
  /** The row holding the current selection, marked in the list. */
  currentIndex: number;
}

/** A pure snapshot of the provider registry, so the picker machine needs no I/O. */
export interface ProviderCatalogEntry {
  id: ProviderId;
  models: readonly ProviderModel[];
}
export type ProviderCatalog = readonly ProviderCatalogEntry[];

/**
 * Open a picker for `kind`: providers by id, the active provider's models by
 * short label, or the active model's efforts — with the current choice marked
 * and highlighted. Null when there is nothing to pick (unknown selection). Pure.
 */
export function openPicker(kind: PickerKind, sel: Selection, catalog: ProviderCatalog): PickerState | null {
  let options: PickerOption[] = [];
  if (kind === "provider") {
    options = catalog.map((p) => ({ id: p.id, label: p.id }));
  } else {
    const provider = catalog.find((p) => p.id === sel.provider);
    if (kind === "model") {
      options = (provider?.models ?? []).map((m) => ({ id: m.id, label: m.label }));
    } else {
      const model = provider?.models.find((m) => m.id === sel.model);
      options = (model?.efforts ?? []).map((e) => ({ id: e, label: e }));
    }
  }
  if (!options.length) return null;
  const current = kind === "provider" ? sel.provider : kind === "model" ? sel.model : sel.effort;
  const currentIndex = Math.max(0, options.findIndex((o) => o.id === current));
  return { kind, options, index: currentIndex, currentIndex };
}

/** Move the highlight by `delta`, wrapping — repeat-trigger advance is `+1`. Pure. */
export function movePicker(state: PickerState, delta: number): PickerState {
  const n = state.options.length;
  return { ...state, index: (((state.index + delta) % n) + n) % n };
}

/**
 * The committed selection for a picker's highlighted option. A provider change
 * lands on the provider's first model; provider/model changes preserve the
 * current effort when the target supports it (else fall back), so switching
 * backends never silently changes reasoning depth. Committing the already-
 * current provider is a no-op (the model is not reset). Pure — the caller
 * writes the result through the store.
 */
export function commitPicker(state: PickerState, sel: Selection, catalog: ProviderCatalog): Selection {
  const chosen = state.options[state.index]!;
  if (state.kind === "effort") return { ...sel, effort: chosen.id as Effort };
  if (state.kind === "model") {
    const provider = catalog.find((p) => p.id === sel.provider);
    const model = provider?.models.find((m) => m.id === chosen.id);
    return { ...sel, model: chosen.id, effort: preserveEffort(model?.efforts ?? [], sel.effort) };
  }
  if (chosen.id === sel.provider) return sel;
  const provider = catalog.find((p) => p.id === chosen.id);
  const first = provider?.models[0];
  if (!first) return sel;
  return { provider: chosen.id as ProviderId, model: first.id, effort: preserveEffort(first.efforts, sel.effort) };
}

/**
 * The picker overlay's rows: `▸` on the highlight, `●` on the current choice,
 * so the operator sees both where they are and what is active. Pure — the mount
 * colours the active row.
 */
export function pickerRows(state: PickerState): Array<{ text: string; active: boolean }> {
  return state.options.map((o, i) => ({
    text: `${i === state.index ? "▸" : " "} ${i === state.currentIndex ? "●" : " "} ${o.label}`,
    active: i === state.index,
  }));
}

// --- inline row detail (pure) --------------------------------------------------

/**
 * Word-wrap `text` to `width` columns, hard-breaking words longer than a line
 * and preserving explicit newlines. Always returns at least one line. Pure.
 */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = "";
    for (let word of raw.split(/\s+/).filter(Boolean)) {
      while (word.length > width) {
        if (line) {
          lines.push(line);
          line = "";
        }
        lines.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines.length ? lines : [""];
}

/** Shape the inline-detail presenter reads from a focused activity row. */
interface DetailRowInput {
  status: string;
  effort: string;
  duration_ms: number | null;
  note: string | null;
  request_id: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  cache_creation: number | null;
}

/** Format a token count for the detail block, or "—" when unmeasured. Pure. */
function detailToken(n: number | null): string {
  return n == null ? "—" : String(n);
}

/**
 * Assemble the inline detail block shown under a focused activity row when it
 * is expanded (⏎). A meta line (request_id, effort, duration), then either the
 * full error note wrapped to `width` (for an error row) or the full token
 * breakdown (prompt / completion / cached / wrote). The note is truncated with
 * a `…` line only when it exceeds `maxNoteLines` (a short terminal). Replaces
 * the old modal error-detail overlay; pure, so it stays unit-tested.
 */
export function detailLines(
  row: DetailRowInput,
  width: number,
  maxNoteLines = Number.POSITIVE_INFINITY,
): string[] {
  const duration = row.duration_ms != null ? `  ·  ${row.duration_ms}ms` : "";
  const meta = `request_id ${row.request_id}  ·  effort ${row.effort}${duration}`;
  if (row.status === "error") {
    const note = wrapText(row.note ?? "(no note recorded)", width);
    const clipped = note.length > maxNoteLines ? [...note.slice(0, Math.max(1, maxNoteLines - 1)), "…"] : note;
    return [meta, ...clipped];
  }
  const tokens =
    `prompt ${detailToken(row.prompt_tokens)}  ·  completion ${detailToken(row.completion_tokens)}` +
    `  ·  cached ${detailToken(row.cached_tokens)}  ·  wrote ${detailToken(row.cache_creation)}`;
  return [meta, tokens];
}

// --- focus + follow (pure state machine) ---------------------------------------

/**
 * The activity stream's navigation state. `focus` is the index into the loaded
 * rows (newest-first) of the focused row, or null when nothing is focused
 * (fresh start / empty stream). `expanded` is whether the focused row's inline
 * detail is open. `following` is true while the stream auto-scrolls with new
 * rows (focus pinned at the head); navigating away pauses it. `newWhilePaused`
 * counts rows that arrived at the head since follow paused, for the separator.
 */
export interface StreamState {
  focus: number | null;
  expanded: boolean;
  following: boolean;
  newWhilePaused: number;
}

/** The initial stream state: following the head, nothing focused or expanded. Pure. */
export function initialStreamState(): StreamState {
  return { focus: null, expanded: false, following: true, newWhilePaused: 0 };
}

/**
 * Move the focus by `delta` within a stream of `rowCount` rows (newest-first,
 * so index 0 is the head). The first move from "nothing focused" lands on the
 * head. Focus clamps at both ends (no wrap — the ends are meaningful: the head
 * is "now", the tail is "scroll for more"). Moving away from the head pauses
 * follow; returning to the head (index 0) resumes it and clears the new-row
 * counter. Collapses any open detail when the focus actually moves. Pure.
 */
export function moveFocus(state: StreamState, delta: number, rowCount: number): StreamState {
  if (rowCount <= 0) return { ...state, focus: null, expanded: false };
  // The first move from "nothing focused" lands on the head, regardless of
  // direction — there is nowhere above the head to go.
  const next = state.focus == null ? 0 : Math.max(0, Math.min(rowCount - 1, state.focus + delta));
  const moved = next !== state.focus;
  const following = next === 0;
  return {
    focus: next,
    expanded: moved ? false : state.expanded,
    following,
    newWhilePaused: following ? 0 : state.newWhilePaused,
  };
}

/** Toggle the focused row's inline detail. A no-op when nothing is focused. Pure. */
export function toggleExpanded(state: StreamState): StreamState {
  if (state.focus == null) return state;
  return { ...state, expanded: !state.expanded };
}

/**
 * Resume following from a paused state (the `esc` action): pin focus back to
 * the head, clear the new-row counter, and collapse any open detail. Pure.
 */
export function resumeFollow(state: StreamState): StreamState {
  return { focus: 0, expanded: false, following: true, newWhilePaused: 0 };
}

/**
 * Fold a fresh data poll into the stream state. `added` is how many new rows
 * appeared at the head since the last poll. While following, the focus stays at
 * the head and the view shifts with the new rows (nothing to track). While
 * paused, the focus must stay on the *same* row even as rows shift down, so it
 * advances by `added`; the new rows are counted for the separator. Pure — the
 * caller supplies `added` (computed from row ids across polls).
 */
export function onPoll(state: StreamState, added: number, rowCount: number): StreamState {
  if (state.following || state.focus == null) return state;
  if (added <= 0) return state;
  const focus = Math.min(rowCount - 1, state.focus + added);
  return { ...state, focus, newWhilePaused: state.newWhilePaused + added };
}

// --- layout tier (pure) --------------------------------------------------------

/** The responsive layout tier, chosen by terminal width alone. */
export type LayoutTier = "wide" | "compact";

/** Width at or above which the right sidebar is shown; below it folds to a compact header. */
export const SIDEBAR_MIN_COLS = 100;

/** Choose the layout tier from the terminal width. Pure. */
export function layoutTier(cols: number): LayoutTier {
  return cols >= SIDEBAR_MIN_COLS ? "wide" : "compact";
}

// --- empty state (pure) ----------------------------------------------------------

/** The actionable empty-state content: what to do next instead of a bare placeholder. */
export interface EmptyState {
  headline: string;
  /** The endpoint Cursor should point at — the same URL as the meta strip. */
  url: string;
  hint: string;
}

/** The onboarding content for an empty activity pane. Pure. */
export function emptyState(url: string): EmptyState {
  return {
    headline: "no activity yet — point Cursor at",
    url,
    hint: "press [c] to copy the endpoint",
  };
}

// --- OpenTUI mount -----------------------------------------------------------
//
// The mount layer below is intentionally thin and untested: it builds the
// chrome once and pushes fresh StyledText into the Text renderables on each
// cadence. All formatting decisions live in the pure presenters above; the
// native core owns differential rendering (no flicker) and the Yoga flexbox
// layout (the chrome structure).
//
// Colour roles (quiet chrome): borders and titles are dim grey so the eye lands
// on data, not frames. Accent cyan is reserved for three roles only — the
// active selection values, the focused activity row, and the footer keycaps.
// green/yellow/red are strictly semantic; status is never conveyed by colour
// alone (glyphs carry it).

/** Cyan accent — reserved for the selection, the focused row, and the keycaps. */
const ACCENT = "#22d3ee";

/** Dim grey for the quiet chrome: frame borders and titles. */
const CHROME = "#3a414d";

/** Default-brightness chunk for values — the data the operator's eye lands on. */
function value(text: string): TextChunk {
  return stringToStyledText(text).chunks[0] ?? stringToStyledText(" ").chunks[0]!;
}

/** Semantic level → colour, the single mapping for ok/warn/crit. */
const LEVEL_COLOR = { ok: green, warn: yellow, crit: red } as const;

/** Cadences, decoupled so auth checks and animation do not piggyback the data poll. */
const DATA_POLL_MS = 400;
const RENDER_TICK_MS = 100;
const AUTH_REFRESH_MS = 5000;

/** How long the meta-strip flash (e.g. `copied ✓`) stays before clearing itself. */
const FLASH_MS = 1500;

/** Spaces between activity table columns. */
const COL_GAP = 2;

/** A single space as a default-styled chunk, for inline gaps between styled segments. */
const SPACE: TextChunk = stringToStyledText(" ").chunks[0]!;

/** Join per-line StyledText fragments into one multi-line StyledText for a Text renderable. */
function joinLines(lines: StyledText[]): StyledText {
  const chunks: TextChunk[] = [];
  lines.forEach((line, i) => {
    if (i > 0) chunks.push(...stringToStyledText("\n").chunks);
    chunks.push(...line.chunks);
  });
  return new StyledText(chunks);
}

/**
 * Colour one activity cell by its kind; formatting already happened in the
 * presenter. Status keeps glyph+word semantics (green/red, spinner yellow);
 * the token witness and duration are values (default brightness); time and
 * source are labels (dim). Cells arrive padded, so match on the trimmed text.
 *
 * A focused row is rendered in accent cyan throughout — the one place (besides
 * the selection and keycaps) that earns the accent — so the focus reads at a
 * glance without relying on colour to carry *status* (the glyph still does).
 */
function colourCell(cell: ActivityCell, focused: boolean): TextChunk {
  if (focused) return cyan(cell.text);
  switch (cell.kind) {
    case "status": {
      const word = cell.text.trim();
      return word === "✓ ok" ? green(cell.text) : word === "✗ error" ? red(cell.text) : yellow(cell.text);
    }
    case "note":
      return red(cell.text);
    case "elapsed":
      return yellow(cell.text);
    case "tokens":
    case "duration":
      return value(cell.text);
    default:
      return dim(cell.text);
  }
}

/** Render one plan-usage snapshot as two bars, or a neutral state, into lines. */
function planLines(provider: ReturnType<typeof getProvider>, providerId: string, now: number): StyledText[] {
  if (!provider.reportsPlanUsage) return [new StyledText([dim("n/a — no plan usage")])];
  const usage = getPlanUsage(providerId);
  if (!usage) return [new StyledText([dim("(no data yet)")])];
  const bar = (label: string, raw: PlanWindow): StyledText => {
    const w = optimisticReset(raw, now);
    const parts = planUsageParts(label, w, now);
    const chunks: TextChunk[] = [
      dim(parts.label),
      LEVEL_COLOR[usageLevel(w.utilization)](`${parts.bar} ${parts.pct}`),
    ];
    if (parts.flag) chunks.push(red(`  ${parts.flag}`));
    return new StyledText(chunks);
  };
  const resetLine = (label: string, raw: PlanWindow): StyledText =>
    new StyledText([dim(`${label}${planUsageParts(label, optimisticReset(raw, now), now).reset}`)]);
  return [
    bar("5h", usage.fiveHour),
    resetLine("       ", usage.fiveHour),
    bar("weekly", usage.weekly),
    resetLine("       ", usage.weekly),
  ];
}

/**
 * Live control panel. Reads selection + activity from the shared store and
 * writes the selection back when you commit a picker — that store is the
 * control channel to the background service.
 *
 *   ↑↓ move · ⏎ detail · f filter · p/m/e select · c copy · q quit
 */
export async function runTui(): Promise<void> {
  const providers = allProviders();
  const catalog: ProviderCatalog = providers.map((p) => ({ id: p.id, models: p.models() }));
  const modelLabels = new Map<string, string>();
  for (const entry of catalog) for (const m of entry.models) modelLabels.set(m.id, slugLabel(m.label));
  let sel = getSelection();
  const authCache = new Map<ProviderId, AuthStatus>();
  const clipboard = createClipboard();

  let filter: ActivityFilter = "all";
  let streamState = initialStreamState();

  const refreshAuth = async (): Promise<void> => {
    await Promise.all(
      providers.map(async (p) => {
        try {
          authCache.set(p.id, await p.authStatus());
        } catch (err) {
          authCache.set(p.id, { ok: false, detail: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
  };

  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });

  // --- chrome: two columns, built once -------------------------------------
  const app = new BoxRenderable(renderer, {
    id: "app",
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });

  // Top strip: the brand + active selection (compact header carries the
  // condensed metrics in the narrow tier).
  const header = new BoxRenderable(renderer, {
    id: "header",
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const selText = new TextRenderable(renderer, { id: "sel", content: "" });
  const compactText = new TextRenderable(renderer, { id: "compact", content: "" });
  header.add(selText);
  header.add(compactText);

  // Body: activity stream (left, grows) + sidebar (right, fixed width). The
  // sidebar collapses to width 0 in the compact tier.
  const body = new BoxRenderable(renderer, { id: "body", flexGrow: 1, flexDirection: "row" });
  const stream = new BoxRenderable(renderer, {
    id: "stream",
    flexGrow: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: CHROME,
    title: " activity ",
    titleColor: CHROME,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const streamText = new TextRenderable(renderer, { id: "streamText", content: "" });
  stream.add(streamText);

  const sidebar = new BoxRenderable(renderer, { id: "sidebar", width: 34, flexDirection: "column", marginLeft: 1 });
  const statusFrame = new BoxRenderable(renderer, {
    id: "statusFrame",
    border: true,
    borderStyle: "single",
    borderColor: CHROME,
    title: " status ",
    titleColor: CHROME,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const statusText = new TextRenderable(renderer, { id: "statusText", content: "" });
  statusFrame.add(statusText);
  const planFrame = new BoxRenderable(renderer, {
    id: "planFrame",
    border: true,
    borderStyle: "single",
    borderColor: CHROME,
    title: " plan ",
    titleColor: CHROME,
    paddingLeft: 1,
    paddingRight: 1,
    marginTop: 1,
  });
  const planText = new TextRenderable(renderer, { id: "plan", content: "" });
  planFrame.add(planText);
  const trafficFrame = new BoxRenderable(renderer, {
    id: "trafficFrame",
    border: true,
    borderStyle: "single",
    borderColor: CHROME,
    title: " traffic ",
    titleColor: CHROME,
    paddingLeft: 1,
    paddingRight: 1,
    marginTop: 1,
  });
  const trafficText = new TextRenderable(renderer, { id: "traffic", content: "" });
  trafficFrame.add(trafficText);
  const providersFrame = new BoxRenderable(renderer, {
    id: "providersFrame",
    border: true,
    borderStyle: "single",
    borderColor: CHROME,
    title: " providers ",
    titleColor: CHROME,
    paddingLeft: 1,
    paddingRight: 1,
    marginTop: 1,
  });
  const providersText = new TextRenderable(renderer, { id: "providersText", content: "" });
  providersFrame.add(providersText);
  sidebar.add(statusFrame);
  sidebar.add(planFrame);
  sidebar.add(trafficFrame);
  sidebar.add(providersFrame);
  body.add(stream);
  body.add(sidebar);

  const hintsBar = new BoxRenderable(renderer, { id: "hintsBar", paddingLeft: 1, paddingRight: 1 });
  const hintsText = new TextRenderable(renderer, { id: "hints", content: "" });
  hintsBar.add(hintsText);

  app.add(header);
  app.add(body);
  app.add(hintsBar);
  renderer.root.add(app);

  // Min-size guard: an absolute overlay (out of the app's flow) shown when the
  // terminal is too small, so the panel degrades to a clear message rather than
  // rendering a broken layout.
  const guard = new BoxRenderable(renderer, {
    id: "guard",
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    justifyContent: "center",
    alignItems: "center",
    visible: false,
  });
  const guardText = new TextRenderable(renderer, { id: "guardText", content: "" });
  guard.add(guardText);
  renderer.root.add(guard);

  // Modal overlay: a single centered absolute box (same mechanic as the
  // min-size guard) used only by the pickers now — the activity detail is
  // inline, not modal.
  const overlayWrap = new BoxRenderable(renderer, {
    id: "overlayWrap",
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    justifyContent: "center",
    alignItems: "center",
    visible: false,
  });
  const overlayBox = new BoxRenderable(renderer, {
    id: "overlayBox",
    border: true,
    borderStyle: "rounded",
    borderColor: ACCENT,
    titleColor: ACCENT,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const overlayText = new TextRenderable(renderer, { id: "overlayText", content: "" });
  overlayBox.add(overlayText);
  overlayWrap.add(overlayBox);
  renderer.root.add(overlayWrap);

  // --- input mode: picker (the only modal) -----------------------------------
  type Mode = { kind: "default" } | { kind: "picker"; state: PickerState };
  let mode: Mode = { kind: "default" };

  const footerContext = (): FooterContext =>
    mode.kind === "picker"
      ? { mode: "picker" }
      : { mode: "default", paused: !streamState.following, focused: streamState.focus != null, filter };

  const renderHints = (): void => {
    const chunks: TextChunk[] = [];
    hintsFor(footerContext()).forEach((hint, i) => {
      if (i > 0) chunks.push(SPACE, SPACE);
      const { cap, rest } = keycapParts(hint);
      chunks.push(cyan(cap));
      if (rest) chunks.push(dim(rest));
    });
    hintsText.content = new StyledText(chunks);
  };

  const renderOverlay = (): void => {
    if (mode.kind !== "picker") {
      overlayWrap.visible = false;
      return;
    }
    overlayWrap.visible = true;
    overlayBox.title = ` ${mode.state.kind} `;
    overlayText.content = joinLines(
      pickerRows(mode.state).map((r) => new StyledText([r.active ? bold(cyan(r.text)) : value(r.text)])),
    );
  };

  const setMode = (next: Mode): void => {
    mode = next;
    renderHints();
    renderOverlay();
    renderer.requestRender();
  };

  // Brief flash (e.g. copy confirmation); the data poll clears it on the first
  // render after it expires.
  let flash: { text: string; level: "ok" | "warn"; until: number } | null = null;
  const showFlash = (text: string, level: "ok" | "warn"): void => {
    flash = { text, level, until: Date.now() + FLASH_MS };
    render();
  };

  // Rows are read on the data poll and cached so the ~100ms animation tick can
  // re-render the spinner + live elapsed of in-flight rows without re-hitting
  // the store. The inner content area excludes the border (2 rows / 2 cols) and
  // the horizontal padding (2 cols); fall back to a small size before first layout.
  let cachedRows: ActivityRow[] = [];
  let inFlight = 0;
  let topRowId: number | null = null;
  const streamInner = (): { h: number; w: number } => ({
    h: stream.height > 2 ? stream.height - 2 : 8,
    w: stream.width > 4 ? stream.width - 4 : 40,
  });

  /** The focused row, if any, from the cached page. */
  const focusedRow = (): ActivityRow | undefined =>
    streamState.focus != null ? cachedRows[streamState.focus] : undefined;

  const renderStream = (innerWidth: number, now: number): void => {
    stream.title = activityTitle(inFlight, now);
    if (!cachedRows.length) {
      const empty = emptyState(endpoint.url);
      streamText.content = joinLines([
        new StyledText([dim(empty.headline)]),
        new StyledText([value(empty.url)]),
        new StyledText([dim(empty.hint)]),
      ]);
      return;
    }
    const padded = padColumns(
      cachedRows.map((r) => activityColumns(r, new Date(r.ts).toLocaleTimeString(), now, { labels: modelLabels })),
    );
    const lines: StyledText[] = [];
    padded.forEach((cells, i) => {
      const focused = i === streamState.focus;
      const marker = focused ? cyan("▸ ") : dim("  ");
      const kept = clipColumns(cells, innerWidth - 2, COL_GAP);
      const chunks: TextChunk[] = [marker];
      kept.forEach((cell, j) => {
        if (j > 0) chunks.push(value(" ".repeat(COL_GAP)));
        chunks.push(colourCell(cell, focused));
      });
      lines.push(new StyledText(chunks));
      // Inline detail under the focused row when expanded.
      if (focused && streamState.expanded) {
        const row = cachedRows[i]!;
        for (const dl of detailLines(row, Math.max(20, innerWidth - 6))) {
          lines.push(new StyledText([dim("    "), value(dl)]));
        }
      }
    });
    // Paused-follow separator at the foot of the stream.
    if (!streamState.following) {
      lines.push(new StyledText([yellow(followSeparator(streamState.newWhilePaused))]));
    }
    streamText.content = joinLines(lines);
  };

  // Collapse the sidebar (width 0, hidden) in the compact tier; guarded so the
  // layout only reflows on an actual tier change.
  let currentTier: LayoutTier | null = null;
  const setTier = (tier: LayoutTier): void => {
    if (tier === currentTier) return;
    currentTier = tier;
    const wide = tier === "wide";
    sidebar.visible = wide;
    sidebar.width = wide ? 34 : 0;
    sidebar.marginLeft = wide ? 1 : 0;
    compactText.visible = !wide;
  };

  // The endpoint is fixed at startup (config is immutable at runtime).
  const endpoint = formatEndpoint(TUNNEL_HOSTNAME, PORT);
  renderHints();

  // --- render: data → props ------------------------------------------------
  const render = (): void => {
    const now = Date.now();

    if (isTerminalTooSmall(renderer.terminalWidth, renderer.terminalHeight)) {
      app.visible = false;
      overlayWrap.visible = false;
      guard.visible = true;
      guardText.content = new StyledText([yellow(`terminal too small — need at least ${MIN_COLS}×${MIN_ROWS}`)]);
      renderer.requestRender();
      return;
    }
    app.visible = true;
    guard.visible = false;
    overlayWrap.visible = mode.kind === "picker";

    const tier = layoutTier(renderer.terminalWidth);
    setTier(tier);

    // header: active selection, the control anchor (accent values, dim labels).
    selText.content = new StyledText([
      bold(cyan("cursor-relay")),
      dim("  provider "),
      bold(cyan(sel.provider)),
      dim("  model "),
      bold(cyan(sel.model)),
      dim("  effort "),
      bold(cyan(sel.effort)),
    ]);

    const provider = getProvider(sel.provider);
    const rate = cacheRateView(cacheTotals());
    const counters = activityCounters();

    // compact tier: a single dense metrics line under the selection, standing in
    // for the (hidden) sidebar.
    if (tier === "compact") {
      const usage = provider.reportsPlanUsage ? getPlanUsage(sel.provider) : null;
      const compactChunks: TextChunk[] = [];
      if (usage) {
        const five = planUsageParts("5h", optimisticReset(usage.fiveHour, now), now);
        const week = planUsageParts("wk", optimisticReset(usage.weekly, now), now);
        compactChunks.push(
          dim("5h "),
          LEVEL_COLOR[usageLevel(usage.fiveHour.utilization)](five.pct.trim()),
          dim("  wk "),
          LEVEL_COLOR[usageLevel(usage.weekly.utilization)](week.pct.trim()),
          dim("  ·  "),
        );
      }
      compactChunks.push(dim("cache "), value(rate.value), dim("  req "), value(abbreviateCount(counters.requests)));
      compactChunks.push(dim("  err "), counters.errors > 0 ? red(abbreviateCount(counters.errors)) : value("0"));
      compactText.content = new StyledText(compactChunks);
    }

    // stream: keyset page scoped to the active filter, auto-filling the pane.
    const inner = streamInner();
    const page = activityPage(inner.h, undefined, filter);
    const newTopId = page[0]?.id ?? null;
    const added = topRowId != null && newTopId != null && newTopId > topRowId
      ? page.filter((r) => r.id > topRowId!).length
      : 0;
    topRowId = newTopId;
    cachedRows = page;
    inFlight = pendingCount();
    streamState = onPoll(streamState, added, cachedRows.length);
    // Clamp focus if the page shrank (e.g. filter change).
    if (streamState.focus != null && streamState.focus >= cachedRows.length) {
      streamState = { ...streamState, focus: cachedRows.length ? cachedRows.length - 1 : null };
    }
    renderStream(inner.w, now);

    // sidebar — status (selection echoed compactly), plan, traffic, providers.
    statusText.content = joinLines([
      new StyledText([dim("provider  "), bold(cyan(sel.provider))]),
      new StyledText([dim("model     "), bold(cyan(sel.model))]),
      new StyledText([dim("effort    "), bold(cyan(sel.effort))]),
    ]);

    planFrame.title = ` plan · ${sel.provider} `;
    planText.content = joinLines(planLines(provider, sel.provider, now));

    const rateChunks: TextChunk[] = [dim(`${rate.label}  `), value(rate.value)];
    const counterChunks: TextChunk[] = [];
    countersView(counters).forEach((part, i) => {
      if (i > 0) counterChunks.push(dim("  ·  "));
      counterChunks.push(dim(`${part.label} `));
      counterChunks.push(part.label === "errors" && counters.errors > 0 ? red(part.value) : value(part.value));
    });
    const trafficLines = [new StyledText(rateChunks)];
    if (rate.detail) trafficLines.push(new StyledText([dim(rate.detail)]));
    trafficLines.push(new StyledText(counterChunks));
    trafficText.content = joinLines(trafficLines);

    const provChunks: TextChunk[] = [];
    providers.forEach((p, i) => {
      if (i > 0) provChunks.push(SPACE, SPACE);
      const a = authCache.get(p.id);
      const state = authDotState(a);
      const dot = state === "ok" ? green("●") : state === "down" ? red("●") : dim("●");
      provChunks.push(dot, dim(` ${p.id}`));
    });
    const metaLine = new StyledText([
      dim(`${endpoint.url}  `),
      endpoint.tunnel === "up" ? green("tunnel up") : yellow("no tunnel"),
    ]);
    const provLines = [new StyledText(provChunks), metaLine];
    if (flash && now <= flash.until) {
      provLines.push(new StyledText([(flash.level === "ok" ? green : yellow)(flash.text)]));
    } else {
      flash = null;
    }
    providersText.content = joinLines(provLines);

    renderer.requestRender();
  };

  const commit = (next: Selection): void => {
    sel = next;
    setSelection(sel);
    render();
  };

  const openPickerFor = (kind: PickerKind): void => {
    const state = openPicker(kind, sel, catalog);
    if (!state) return;
    setMode({ kind: "picker", state });
  };

  // `c` copies the focused row's request_id when a row is focused, else the
  // endpoint — the context-sensitive copy.
  const copyContext = async (): Promise<void> => {
    const row = focusedRow();
    if (row) {
      const ok = await clipboard.copy(row.request_id);
      return showFlash(ok ? "request_id copied ✓" : "copy failed — no clipboard", ok ? "ok" : "warn");
    }
    const ok = await clipboard.copy(endpoint.url);
    showFlash(ok ? "copied ✓" : "copy failed — no clipboard", ok ? "ok" : "warn");
  };

  const navigate = (delta: number): void => {
    streamState = moveFocus(streamState, delta, cachedRows.length);
    renderHints();
    render();
  };

  let dataTimer: ReturnType<typeof setInterval> | undefined;
  let renderTimer: ReturnType<typeof setInterval> | undefined;
  let authTimer: ReturnType<typeof setInterval> | undefined;

  const quit = (): void => {
    if (dataTimer) clearInterval(dataTimer);
    if (renderTimer) clearInterval(renderTimer);
    if (authTimer) clearInterval(authTimer);
    renderer.destroy();
    process.exit(0);
  };

  /** Trigger key per picker kind — pressing it again advances the highlight. */
  const TRIGGER: Record<PickerKind, string> = { provider: "p", model: "m", effort: "e" };

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.ctrl && key.name === "c") return quit();

    // Picker is the only modal: global keys are inert while it is open.
    if (mode.kind === "picker") {
      const state = mode.state;
      switch (key.name) {
        case "up":
          return setMode({ kind: "picker", state: movePicker(state, -1) });
        case "down":
          return setMode({ kind: "picker", state: movePicker(state, 1) });
        case "return":
          commit(commitPicker(state, sel, catalog));
          return setMode({ kind: "default" });
        case "escape":
          return setMode({ kind: "default" });
        default:
          if (key.name === TRIGGER[state.kind]) {
            return setMode({ kind: "picker", state: movePicker(state, 1) });
          }
          return;
      }
    }

    switch (key.name) {
      case "up":
        return navigate(-1);
      case "down":
        return navigate(1);
      case "return":
        streamState = toggleExpanded(streamState);
        return render();
      case "escape":
        if (!streamState.following) {
          streamState = resumeFollow(streamState);
          renderHints();
          return render();
        }
        return;
      case "f":
        filter = cycleFilter(filter);
        streamState = initialStreamState();
        renderHints();
        return render();
      case "p":
        return openPickerFor("provider");
      case "m":
        return openPickerFor("model");
      case "e":
        return openPickerFor("effort");
      case "c":
        return void copyContext();
      case "q":
        return quit();
    }
  });

  // Reflow immediately on terminal resize.
  renderer.on("resize", () => {
    render();
    renderOverlay();
  });

  await refreshAuth();
  render();
  // Data poll re-reads the store and updates every zone's props.
  dataTimer = setInterval(() => {
    sel = getSelection();
    render();
  }, DATA_POLL_MS);
  // Animation tick advances the spinner + live elapsed of in-flight rows only,
  // re-rendering the stream from the cached rows (no store read) and only while
  // something is actually pending — so a quiet panel does no work.
  renderTimer = setInterval(() => {
    if (!cachedRows.some((r) => r.status === "pending")) return;
    renderStream(streamInner().w, Date.now());
    renderer.requestRender();
  }, RENDER_TICK_MS);
  // Auth refresh runs on a slower, decoupled cadence.
  authTimer = setInterval(() => {
    void refreshAuth();
  }, AUTH_REFRESH_MS);
}
