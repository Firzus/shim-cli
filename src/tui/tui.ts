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
  bucketedCacheSamples,
  type CacheSample,
  DEFAULT_PERIOD,
  getPlanUsage,
  getSelection,
  nextPeriod,
  pendingCount,
  type Period,
  periodSince,
  type PlanWindow,
  recentActivity,
  setSelection,
  windowedCounters,
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

/** 0–1 rate → block glyph, lowest to highest. */
const SPARK_GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

/**
 * Map a sequence of 0–1 rates to block glyphs, one per rate in order — the
 * shape of the cache behaviour over time, where a cold stretch reads as a
 * visible trough. Rates are clamped into the glyph scale. Pure.
 */
export function sparkline(rates: readonly number[]): string {
  return rates
    .map((r) => {
      const i = Math.min(SPARK_GLYPHS.length - 1, Math.max(0, Math.floor(r * SPARK_GLYPHS.length)));
      return SPARK_GLYPHS[i]!;
    })
    .join("");
}

/** The cache-rate line, split so the mount can colour each part by its role. */
export interface CacheRateView {
  /** `cache rate (all)` — dim. */
  label: string;
  /** One glyph per history bucket, oldest → newest; "" with no measured rows. */
  spark: string;
  /** All-time aggregate percent (0% with no measured rows) — value brightness. */
  value: string;
  /** `1.2k cached / 2.7k input`, or "" with no measured rows — dim. */
  detail: string;
}

/**
 * Derive the cache-rate line from the bucketed history samples (oldest →
 * newest). Both the bucketed sparkline and the aggregate percent come from the
 * same samples, so the two can never disagree; per ADR-0004 the aggregate is
 * `Σcached / Σinput` over the whole measured history and cache creation is
 * never folded in. No measured rows renders 0%. Pure.
 */
export function cacheRateView(samples: readonly CacheSample[]): CacheRateView {
  const label = "cache rate (all)";
  const cached = samples.reduce((sum, s) => sum + s.cached, 0);
  const input = samples.reduce((sum, s) => sum + s.input, 0);
  if (input <= 0) return { label, spark: "", value: "0%", detail: "" };
  return {
    label,
    spark: sparkline(samples.map((s) => (s.input > 0 ? s.cached / s.input : 0))),
    value: `${Math.round((cached / input) * 100)}%`,
    detail: `${abbreviateCount(cached)} cached / ${abbreviateCount(input)} input`,
  };
}

/** One labelled value for the traffic section — label dim, value bright. */
export interface LabelledValue {
  label: string;
  value: string;
}

/**
 * The counters line as label/value pairs: requests + errors over the selected
 * `w` period, plus the period itself under the `window` label so the `w` key's
 * target is legible. In-flight load lives in the activity frame title, where
 * the requests themselves appear. Counts are abbreviated like the rest of the
 * panel. Pure.
 */
export function countersView(c: { requests: number; errors: number }, period: Period): LabelledValue[] {
  return [
    { label: "requests", value: abbreviateCount(c.requests) },
    { label: "errors", value: abbreviateCount(c.errors) },
    { label: "window", value: period },
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
 * The single modal input-mode concept: while a picker or the error detail is
 * open, global keys are inert and the footer hints swap to the modal's
 * controls. The hints presenter takes this kind, so the footer cannot drift
 * from the actual key handling.
 */
export type InputModeKind = "default" | "picker" | "error-detail";

/** One footer hint: the trigger key and the action word it triggers. */
export interface Hint {
  key: string;
  label: string;
}

/** The footer hints for an input mode — one source for the whole footer. Pure. */
export function hintsFor(mode: InputModeKind): Hint[] {
  switch (mode) {
    case "picker":
      return [
        { key: "↑↓", label: "move" },
        { key: "⏎", label: "select" },
        { key: "esc", label: "cancel" },
      ];
    case "error-detail":
      return [{ key: "esc", label: "close" }];
    default:
      return [
        { key: "p", label: "provider" },
        { key: "m", label: "model" },
        { key: "e", label: "effort" },
        { key: "w", label: "window" },
        { key: "c", label: "copy" },
        { key: "q", label: "quit" },
      ];
  }
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

// --- error detail overlay (pure) -----------------------------------------------

/** The most recent error row in a newest-first window, if any. Pure. */
export function latestError<T extends { status: string }>(rows: readonly T[]): T | undefined {
  return rows.find((r) => r.status === "error");
}

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

/**
 * Assemble the error-detail overlay content: a header line (time, source,
 * duration), the request_id, then the full note wrapped to `width` — truncated
 * with a `…` line only when it exceeds `maxNoteLines` (a short terminal). Pure.
 */
export function errorDetailLines(
  row: {
    ts: number;
    provider: string;
    model: string;
    duration_ms: number | null;
    note: string | null;
    request_id: string;
  },
  timeStr: string,
  width: number,
  maxNoteLines = Number.POSITIVE_INFINITY,
): string[] {
  const duration = row.duration_ms != null ? `  ${row.duration_ms}ms` : "";
  const note = wrapText(row.note ?? "(no note recorded)", width);
  const clipped = note.length > maxNoteLines ? [...note.slice(0, Math.max(1, maxNoteLines - 1)), "…"] : note;
  return [`${timeStr}  ${row.provider}/${row.model}${duration}`, `request_id ${row.request_id}`, "", ...clipped];
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
// chrome (three zones) once and pushes fresh StyledText into the Text
// renderables on each cadence. All formatting decisions live in the pure
// presenters above; the native core owns differential rendering (no flicker)
// and the Yoga flexbox layout (the chrome structure).
//
// Colour roles, defined once: accent cyan for chrome and the active selection,
// green/yellow/red strictly semantic, dim reserved for labels, default
// brightness for values. Status is never conveyed by colour alone (glyphs).

/** Single cyan accent for the chrome (border + title + keycaps). */
const ACCENT = "#22d3ee";

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
 */
function colourCell(cell: ActivityCell): TextChunk {
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

/**
 * Live control panel. Reads selection + activity from the shared store and
 * writes the selection back when you commit a picker — that store is the
 * control channel to the background service.
 *
 *   p provider · m model · e effort · w window · c copy · q quit · ⏎ error detail
 */
export async function runTui(): Promise<void> {
  const providers = allProviders();
  const catalog: ProviderCatalog = providers.map((p) => ({ id: p.id, models: p.models() }));
  const modelLabels = new Map<string, string>();
  for (const entry of catalog) for (const m of entry.models) modelLabels.set(m.id, slugLabel(m.label));
  let sel = getSelection();
  let period: Period = DEFAULT_PERIOD;
  const authCache = new Map<ProviderId, AuthStatus>();
  const clipboard = createClipboard();

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

  // --- chrome: three zones, built once -------------------------------------
  const app = new BoxRenderable(renderer, {
    id: "app",
    width: "100%",
    height: "100%",
    flexDirection: "column",
  });

  const statusBar = new BoxRenderable(renderer, {
    id: "status",
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
  });
  const selText = new TextRenderable(renderer, { id: "sel", content: "" });
  const metaText = new TextRenderable(renderer, { id: "meta", content: "" });
  statusBar.add(selText);
  statusBar.add(metaText);

  const stream = new BoxRenderable(renderer, {
    id: "stream",
    flexGrow: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: ACCENT,
    title: " activity ",
    titleColor: ACCENT,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const streamText = new TextRenderable(renderer, { id: "streamText", content: "" });
  stream.add(streamText);

  // Two titled frames side by side: plan usage (scoped to the active provider)
  // on the left, traffic (cache rate + counters) on the right — so the operator
  // knows which numbers belong to which concern.
  const metricsRow = new BoxRenderable(renderer, { id: "metricsRow", flexDirection: "row" });
  const planFrame = new BoxRenderable(renderer, {
    id: "planFrame",
    flexGrow: 1,
    border: true,
    borderStyle: "single",
    borderColor: ACCENT,
    title: " plan ",
    titleColor: ACCENT,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const trafficFrame = new BoxRenderable(renderer, {
    id: "trafficFrame",
    flexGrow: 1,
    border: true,
    borderStyle: "single",
    borderColor: ACCENT,
    title: " traffic ",
    titleColor: ACCENT,
    paddingLeft: 1,
    paddingRight: 1,
  });
  const planText = new TextRenderable(renderer, { id: "plan", content: "" });
  const trafficText = new TextRenderable(renderer, { id: "traffic", content: "" });
  planFrame.add(planText);
  trafficFrame.add(trafficText);
  metricsRow.add(planFrame);
  metricsRow.add(trafficFrame);

  const hintsBar = new BoxRenderable(renderer, { id: "hintsBar", paddingLeft: 1, paddingRight: 1 });
  const hintsText = new TextRenderable(renderer, { id: "hints", content: "" });
  hintsBar.add(hintsText);

  app.add(statusBar);
  app.add(stream);
  app.add(metricsRow);
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
  // min-size guard) shared by the pickers and the error detail.
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

  // --- modal input mode ------------------------------------------------------
  type Mode =
    | { kind: "default" }
    | { kind: "picker"; state: PickerState }
    | { kind: "error-detail"; row: ReturnType<typeof recentActivity>[number] };
  let mode: Mode = { kind: "default" };

  const renderHints = (): void => {
    const chunks: TextChunk[] = [];
    hintsFor(mode.kind).forEach((hint, i) => {
      if (i > 0) chunks.push(SPACE, SPACE);
      const { cap, rest } = keycapParts(hint);
      chunks.push(cyan(cap));
      if (rest) chunks.push(dim(rest));
    });
    hintsText.content = new StyledText(chunks);
  };

  const renderOverlay = (): void => {
    if (mode.kind === "default") {
      overlayWrap.visible = false;
      return;
    }
    overlayWrap.visible = true;
    if (mode.kind === "picker") {
      overlayBox.title = ` ${mode.state.kind} `;
      overlayText.content = joinLines(
        pickerRows(mode.state).map((r) => new StyledText([r.active ? bold(cyan(r.text)) : value(r.text)])),
      );
    } else {
      overlayBox.title = " error ";
      const width = Math.min(56, Math.max(20, renderer.terminalWidth - 8));
      const maxNoteLines = Math.max(1, renderer.terminalHeight - 8);
      const lines = errorDetailLines(
        mode.row,
        new Date(mode.row.ts).toLocaleTimeString(),
        width,
        maxNoteLines,
      );
      overlayText.content = joinLines(
        lines.map((line, i) => new StyledText([i === 0 ? dim(line || " ") : value(line || " ")])),
      );
    }
  };

  const setMode = (next: Mode): void => {
    mode = next;
    renderHints();
    renderOverlay();
    renderer.requestRender();
  };

  // Brief meta-strip flash (e.g. copy confirmation); the data poll clears it
  // on the first render after it expires.
  let flash: { text: string; level: "ok" | "warn"; until: number } | null = null;
  const showFlash = (text: string, level: "ok" | "warn"): void => {
    flash = { text, level, until: Date.now() + FLASH_MS };
    render();
  };

  // Rows are read on the data poll and cached so the ~100ms animation tick can
  // re-render the spinner + live elapsed of in-flight rows without re-hitting
  // the store. The inner content area excludes the border (2 rows / 2 cols) and
  // the horizontal padding (2 cols); fall back to a small size before first layout.
  let cachedRows: ReturnType<typeof recentActivity> = [];
  let inFlight = 0;
  const streamInner = (): { h: number; w: number } => ({
    h: stream.height > 2 ? stream.height - 2 : 8,
    w: stream.width > 4 ? stream.width - 4 : 40,
  });
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
      cachedRows.map((r) =>
        activityColumns(r, new Date(r.ts).toLocaleTimeString(), now, { labels: modelLabels }),
      ),
    );
    streamText.content = joinLines(
      padded.map((cells) => {
        const kept = clipColumns(cells, innerWidth, COL_GAP);
        const chunks: TextChunk[] = [];
        kept.forEach((cell, i) => {
          if (i > 0) chunks.push(value(" ".repeat(COL_GAP)));
          chunks.push(colourCell(cell));
        });
        return new StyledText(chunks);
      }),
    );
  };

  // Collapse the plan frame (width 0, hidden) when the active provider has no
  // plan usage, so the traffic frame reclaims the space; guarded so the layout
  // only reflows on an actual state change.
  let planCollapsed = false;
  const setPlanCollapsed = (collapsed: boolean): void => {
    if (collapsed === planCollapsed) return;
    planCollapsed = collapsed;
    planFrame.visible = !collapsed;
    planFrame.flexGrow = collapsed ? 0 : 1;
    planFrame.width = collapsed ? 0 : "auto";
  };

  // The endpoint is fixed at startup (config is immutable at runtime).
  const endpoint = formatEndpoint(TUNNEL_HOSTNAME, PORT);
  renderHints();

  // --- render: data → props ------------------------------------------------
  const render = (): void => {
    const now = Date.now();

    // min-size guard: below the threshold, hide the chrome and show one centered
    // message; the overlay is absolute so the app's layout is untouched.
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
    overlayWrap.visible = mode.kind !== "default";

    // tier 1: active selection, highlighted as the control anchor (bold accent
    // values, dim labels) so the operator always knows which backend serves traffic.
    selText.content = new StyledText([
      bold(cyan("shim")),
      dim("  provider "),
      bold(cyan(sel.provider)),
      dim("  model "),
      bold(cyan(sel.model)),
      dim("  effort "),
      bold(cyan(sel.effort)),
    ]);

    // tier 2: dim meta strip — endpoint, tunnel state, per-provider auth dots,
    // and the transient flash (e.g. `copied ✓`); a down provider surfaces its
    // error detail inline.
    const metaChunks: TextChunk[] = [
      dim(`${endpoint.url}  `),
      endpoint.tunnel === "up" ? green("tunnel up") : yellow("no tunnel"),
    ];
    for (const p of providers) {
      const a = authCache.get(p.id);
      const state = authDotState(a);
      const dot = state === "ok" ? green("●") : state === "down" ? red("●") : dim("●");
      metaChunks.push(SPACE, SPACE, dot, dim(` ${formatAuthMeta(p.id, a)}`));
    }
    if (flash && now <= flash.until) {
      metaChunks.push(SPACE, SPACE, (flash.level === "ok" ? green : yellow)(flash.text));
    } else {
      flash = null;
    }
    metaText.content = new StyledText(metaChunks);

    // center: activity stream (newest first), auto-filling the pane — read and
    // cache the rows + in-flight count, then render them with the current `now`.
    const inner = streamInner();
    cachedRows = recentActivity(inner.h);
    inFlight = pendingCount();
    renderStream(inner.w, now);

    // bottom-left: plan usage, scoped to (and titled with) the active provider.
    // A provider that does not capture plan usage (e.g. codex) collapses the
    // frame; a capable provider with no snapshot yet shows "no data yet";
    // otherwise two bars, each optimistically reset once its window's reset
    // boundary has passed. Level colour applies to the bar + percent only, so
    // the countdown stays readable regardless of usage level.
    const provider = getProvider(sel.provider);
    if (!provider.reportsPlanUsage) {
      setPlanCollapsed(true);
    } else {
      setPlanCollapsed(false);
      planFrame.title = ` plan · ${sel.provider} `;
      const usage = getPlanUsage(sel.provider);
      if (!usage) {
        planText.content = new StyledText([dim("(no data yet)")]);
      } else {
        const bar = (label: string, raw: PlanWindow): StyledText => {
          const w = optimisticReset(raw, now);
          const parts = planUsageParts(label, w, now);
          const chunks: TextChunk[] = [
            dim(parts.label),
            LEVEL_COLOR[usageLevel(w.utilization)](`${parts.bar} ${parts.pct}`),
            value(`  ${parts.reset}`),
          ];
          if (parts.flag) chunks.push(red(`  ${parts.flag}`));
          return new StyledText(chunks);
        };
        planText.content = joinLines([bar("5h", usage.fiveHour), bar("weekly", usage.weekly)]);
      }
    }

    // bottom-right: traffic — cache rate (bucketed all-time sparkline +
    // aggregate, both derived from the same SQL read) and the windowed counters.
    const rate = cacheRateView(bucketedCacheSamples());
    const rateChunks: TextChunk[] = [dim(`${rate.label}  `)];
    if (rate.spark) rateChunks.push(value(rate.spark), value("  "));
    rateChunks.push(value(rate.value));
    if (rate.detail) rateChunks.push(dim(`  (${rate.detail})`));

    const counters = windowedCounters(periodSince(period, now));
    const counterChunks: TextChunk[] = [];
    countersView(counters, period).forEach((part, i) => {
      if (i > 0) counterChunks.push(dim("  ·  "));
      counterChunks.push(dim(`${part.label} `));
      counterChunks.push(part.label === "errors" && counters.errors > 0 ? red(part.value) : value(part.value));
    });
    trafficText.content = joinLines([new StyledText(rateChunks), new StyledText(counterChunks)]);

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

  const copyEndpoint = async (): Promise<void> => {
    const ok = await clipboard.copy(endpoint.url);
    showFlash(ok ? "copied ✓" : "copy failed — no clipboard", ok ? "ok" : "warn");
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

    // Modal input modes: global keys are inert while an overlay is open.
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
          // Repeat-trigger advance: the old fast-cycling muscle memory.
          if (key.name === TRIGGER[state.kind]) {
            return setMode({ kind: "picker", state: movePicker(state, 1) });
          }
          return;
      }
    }
    if (mode.kind === "error-detail") {
      if (key.name === "escape" || key.name === "return") return setMode({ kind: "default" });
      return;
    }

    switch (key.name) {
      case "p":
        return openPickerFor("provider");
      case "m":
        return openPickerFor("model");
      case "e":
        return openPickerFor("effort");
      case "w":
        period = nextPeriod(period);
        return render();
      case "c":
        return void copyEndpoint();
      case "q":
        return quit();
      case "return": {
        const row = latestError(cachedRows);
        if (!row) return showFlash("no recent error", "warn");
        return setMode({ kind: "error-detail", row });
      }
    }
  });

  // Reflow immediately on terminal resize (Yoga relayouts the flex zones; this
  // re-derives the size-dependent content — stream auto-fill/clip, the modal
  // overlay, and the min-size guard — without waiting for the next poll).
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
  // Animation tick advances the spinner + live elapsed of in-flight rows (and
  // the in-flight frame title) only, re-rendering the stream from the cached
  // rows (no store read) and only while something is actually pending — so a
  // quiet panel does no work.
  renderTimer = setInterval(() => {
    if (!cachedRows.some((r) => r.status === "pending")) return;
    renderStream(streamInner().w, Date.now());
    renderer.requestRender();
  }, RENDER_TICK_MS);
  // Auth refresh runs on a slower, decoupled cadence so authStatus() is not
  // invoked several times a second.
  authTimer = setInterval(() => {
    void refreshAuth();
  }, AUTH_REFRESH_MS);
}
