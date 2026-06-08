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
  CACHE_RATE_SAMPLE,
  cacheTotalsRecent,
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
import type { AuthStatus, Effort, ProviderId, Selection } from "../providers/types.ts";

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
 * `(cached X)` witness when cache reads landed on that request — the
 * per-request proof the breakpoints work, independent of the aggregate rate.
 * Empty when no token counts were recorded (e.g. a pending row); the cached
 * segment is omitted when there are no cache reads, to avoid `cached 0` noise.
 * Pure (no color) — prior art: formatCacheRate.
 */
export function formatActivityTokens(row: {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
}): string {
  if (row.prompt_tokens == null && row.completion_tokens == null) return "";
  const pt = row.prompt_tokens ?? "?";
  const ct = row.completion_tokens ?? "?";
  const cached =
    row.cached_tokens != null && row.cached_tokens > 0
      ? ` (cached ${abbreviateCount(row.cached_tokens)})`
      : "";
  return ` ${pt}→${ct}tok${cached}`;
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

/**
 * Render one plan-usage bar (without colour): `5h     [████░░░░░░]  71%  resets in 1h 2m`.
 * Utilization is a 0–1 fraction; the caller colours by `usageLevel`. A status
 * other than "allowed" (e.g. "rejected") is appended so a throttled window is
 * visible, not just implied by the colour. Pure.
 */
export function formatPlanUsage(label: string, window: PlanWindow, now: number): string {
  const frac = Math.max(0, Math.min(1, window.utilization));
  const filled = Math.round(frac * BAR_WIDTH);
  const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
  const pct = Math.round(frac * 100);
  const flag = window.status && window.status !== "allowed" ? `  ${window.status}` : "";
  return `${label.padEnd(7)}[${bar}] ${String(pct).padStart(3)}%  resets in ${formatResetCountdown(window.resetAt, now)}${flag}`;
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

/**
 * Render the cache-rate line body (without color) over the last `sample`
 * measured requests. Returns the dim dash form when there is no usable input.
 */
export function formatCacheRate(totals: { cached: number; input: number }, sample: number): string {
  if (totals.input <= 0) return `cache rate (last ${sample})  —`;
  const pct = Math.round((totals.cached / totals.input) * 100);
  return `cache rate (last ${sample})  ${pct}%  (${abbreviateCount(totals.cached)} cached / ${abbreviateCount(totals.input)} input)`;
}

/**
 * The counters line for the metrics panel: requests + errors over the selected
 * `w` period, plus the live in-flight count (point-in-time, not windowed). The
 * period label is shown so the `w` key's target is legible now that it scopes
 * the counters only. Counts are abbreviated like the rest of the panel. Pure.
 */
export function formatCounters(
  c: { requests: number; errors: number; inFlight: number },
  period: Period,
): string {
  return `requests ${abbreviateCount(c.requests)}  ·  errors ${abbreviateCount(c.errors)}  ·  in-flight ${abbreviateCount(c.inFlight)}  (${period})`;
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
}

/**
 * Ordered, plain-text columns for one activity row (left→right):
 * `time · status · provider/model · in→out (cached) · duration`. A pending row
 * is live: its status slot animates a spinner (driven by `now`) and its tail
 * slot shows a ticking elapsed timer in place of the duration. On a finalized
 * row the 4th slot carries the token witness, or — on an error row with a note —
 * the note (truncated) so a failure is diagnosable inline; empty slots are
 * omitted. Colour is the caller's job; pure, and takes the already-formatted
 * `timeStr` plus an injected `now` so tests stay deterministic.
 */
export function activityColumns(row: ActivityRowInput, timeStr: string, now: number, noteMax = 32): ActivityCell[] {
  const source = { text: `${row.provider}/${row.model}`, kind: "source" as const };
  if (row.status === "pending") {
    return [
      { text: timeStr, kind: "time" },
      { text: spinnerFrame(now), kind: "status" },
      source,
      { text: formatElapsed(row.ts, now), kind: "elapsed" },
    ];
  }
  const cells: ActivityCell[] = [{ text: timeStr, kind: "time" }, { text: row.status, kind: "status" }, source];
  if (row.status === "error" && row.note) {
    cells.push({ text: truncateDetail(row.note, noteMax), kind: "note" });
  } else {
    const tokens = formatActivityTokens(row).trim();
    if (tokens) cells.push({ text: tokens, kind: "tokens" });
  }
  if (row.duration_ms != null) cells.push({ text: `${row.duration_ms}ms`, kind: "duration" });
  return cells;
}

/**
 * Keep the leftmost columns that fit within `width` (joined by a single space),
 * dropping the rightmost columns first so a narrow terminal sheds duration, then
 * the token/note witness, etc., rather than wrapping. Pure.
 */
export function clipColumns(cells: ActivityCell[], width: number): ActivityCell[] {
  const kept: ActivityCell[] = [];
  let used = 0;
  for (const cell of cells) {
    const add = (kept.length ? 1 : 0) + cell.text.length;
    if (used + add > width) break;
    kept.push(cell);
    used += add;
  }
  return kept;
}

// --- OpenTUI mount -----------------------------------------------------------
//
// The mount layer below is intentionally thin and untested: it builds the
// chrome (three zones) once and pushes fresh StyledText into the Text
// renderables on each cadence. All formatting decisions live in the pure
// presenters above; the native core owns differential rendering (no flicker)
// and the Yoga flexbox layout (the chrome structure).

/** Single cyan accent for the chrome (border + title). Semantic status colors stay green/red/yellow. */
const ACCENT = "#22d3ee";

/** Cadences, decoupled so auth checks and animation do not piggyback the data poll. */
const DATA_POLL_MS = 400;
const RENDER_TICK_MS = 100;
const AUTH_REFRESH_MS = 5000;

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

/** Colour one activity cell by its kind; formatting already happened in the presenter. */
function colourCell(cell: ActivityCell): TextChunk {
  switch (cell.kind) {
    case "status":
      return cell.text === "ok" ? green(cell.text) : cell.text === "error" ? red(cell.text) : yellow(cell.text);
    case "note":
      return red(cell.text);
    case "elapsed":
      return yellow(cell.text);
    default:
      return dim(cell.text);
  }
}

/**
 * One activity row as a styled line: build the plain columns, clip them to the
 * available width (rightmost-first), then colour each surviving cell. `now`
 * drives the spinner + live elapsed on a pending row.
 */
function activityLine(row: ReturnType<typeof recentActivity>[number], width: number, now: number): StyledText {
  const timeStr = new Date(row.ts).toLocaleTimeString();
  const cells = clipColumns(activityColumns(row, timeStr, now), width);
  const chunks: TextChunk[] = [];
  cells.forEach((cell, i) => {
    if (i > 0) chunks.push(SPACE);
    chunks.push(colourCell(cell));
  });
  return new StyledText(chunks);
}

/**
 * Live control panel. Reads selection + activity from the shared store and
 * writes the selection back when you cycle it — that store is the control
 * channel to the background service.
 *
 *   p cycle provider · m cycle model · e cycle effort · w window · q quit
 */
export async function runTui(): Promise<void> {
  const providers = allProviders();
  const providerIds = providers.map((p) => p.id);
  let sel = getSelection();
  let period: Period = DEFAULT_PERIOD;
  const authCache = new Map<ProviderId, AuthStatus>();

  const refreshAuth = async (): Promise<void> => {
    for (const p of providers) {
      try {
        authCache.set(p.id, await p.authStatus());
      } catch (err) {
        authCache.set(p.id, { ok: false, detail: err instanceof Error ? err.message : String(err) });
      }
    }
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

  const metrics = new BoxRenderable(renderer, {
    id: "metrics",
    border: true,
    borderStyle: "single",
    borderColor: ACCENT,
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
  });
  // Two sub-areas side by side: plan usage on the left (slice 6), windowed cache
  // rate + counters on the right; the keybind hints sit on the last line.
  const metricsRow = new BoxRenderable(renderer, { id: "metricsRow", flexDirection: "row" });
  const metricsLeft = new BoxRenderable(renderer, { id: "metricsLeft", flexGrow: 1 });
  const metricsRight = new BoxRenderable(renderer, { id: "metricsRight", flexGrow: 1 });
  const planText = new TextRenderable(renderer, { id: "plan", content: "" });
  const rightText = new TextRenderable(renderer, { id: "right", content: "" });
  metricsLeft.add(planText);
  metricsRight.add(rightText);
  metricsRow.add(metricsLeft);
  metricsRow.add(metricsRight);
  const hintsText = new TextRenderable(renderer, { id: "hints", content: "" });
  metrics.add(metricsRow);
  metrics.add(hintsText);

  app.add(statusBar);
  app.add(stream);
  app.add(metrics);
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

  // Rows are read on the data poll and cached so the ~100ms animation tick can
  // re-render the spinner + live elapsed of in-flight rows without re-hitting
  // the store. The inner content area excludes the border (2 rows / 2 cols) and
  // the horizontal padding (2 cols); fall back to a small size before first layout.
  let cachedRows: ReturnType<typeof recentActivity> = [];
  const streamInner = (): { h: number; w: number } => ({
    h: stream.height > 2 ? stream.height - 2 : 8,
    w: stream.width > 4 ? stream.width - 4 : 40,
  });
  const renderStream = (innerWidth: number, now: number): void => {
    streamText.content = cachedRows.length
      ? joinLines(cachedRows.map((r) => activityLine(r, innerWidth, now)))
      : new StyledText([dim("(no activity yet)")]);
  };

  // Collapse the plan-usage sub-area (width 0, hidden) when the active provider
  // has no plan usage, so the cache-rate + counters sub-area reclaims the space;
  // guarded so the layout only reflows on an actual state change.
  let planCollapsed = false;
  const setPlanCollapsed = (collapsed: boolean): void => {
    if (collapsed === planCollapsed) return;
    planCollapsed = collapsed;
    metricsLeft.visible = !collapsed;
    metricsLeft.flexGrow = collapsed ? 0 : 1;
    metricsLeft.width = collapsed ? 0 : "auto";
  };

  // --- render: data → props ------------------------------------------------
  const render = (): void => {
    const now = Date.now();

    // min-size guard: below the threshold, hide the chrome and show one centered
    // message; the overlay is absolute so the app's layout is untouched.
    if (isTerminalTooSmall(renderer.terminalWidth, renderer.terminalHeight)) {
      app.visible = false;
      guard.visible = true;
      guardText.content = new StyledText([yellow(`terminal too small — need at least ${MIN_COLS}×${MIN_ROWS}`)]);
      renderer.requestRender();
      return;
    }
    app.visible = true;
    guard.visible = false;

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

    // tier 2: dim meta strip — endpoint, tunnel state, and per-provider auth
    // dots; a down provider surfaces its error detail inline.
    const endpoint = formatEndpoint(TUNNEL_HOSTNAME, PORT);
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
    metaText.content = new StyledText(metaChunks);

    // center: activity stream (newest first), auto-filling the pane — read and
    // cache the rows, then render them with the current `now`.
    const inner = streamInner();
    cachedRows = recentActivity(inner.h);
    renderStream(inner.w, now);

    // bottom-left: plan usage, scoped to the active provider. A provider that
    // does not capture plan usage (e.g. codex) collapses the block so the right
    // sub-area reclaims the space; a capable provider with no snapshot yet shows
    // "no data yet"; otherwise two bars, each optimistically reset once its
    // window's reset boundary has passed.
    const provider = getProvider(sel.provider);
    if (!provider.reportsPlanUsage) {
      setPlanCollapsed(true);
    } else {
      setPlanCollapsed(false);
      const usage = getPlanUsage(sel.provider);
      if (!usage) {
        planText.content = new StyledText([dim(`plan usage (${sel.provider})  (no data yet)`)]);
      } else {
        const bar = (label: string, raw: PlanWindow): StyledText => {
          const w = optimisticReset(raw, now);
          const lvl = usageLevel(w.utilization);
          const color = lvl === "crit" ? red : lvl === "warn" ? yellow : green;
          return new StyledText([color(formatPlanUsage(label, w, now))]);
        };
        planText.content = joinLines([bar("5h", usage.fiveHour), bar("weekly", usage.weekly)]);
      }
    }

    // bottom-right: live cache rate + counters. The cache rate is scoped to the
    // last N measured requests (converges within one response); the `w` period
    // scopes only the request/error counters. In-flight is live.
    const since = periodSince(period, now);
    const counters = { ...windowedCounters(since), inFlight: pendingCount() };
    // One source for the sample size so the totals and the label can't drift.
    const sample = CACHE_RATE_SAMPLE;
    rightText.content = joinLines([
      new StyledText([dim(formatCacheRate(cacheTotalsRecent(sample), sample))]),
      new StyledText([dim(formatCounters(counters, period))]),
    ]);

    hintsText.content = new StyledText([dim("p provider · m model · e effort · w window · q quit")]);

    renderer.requestRender();
  };

  const commit = (next: Selection): void => {
    sel = next;
    setSelection(sel);
    render();
  };

  const cycleProvider = (): void => {
    const i = providerIds.indexOf(sel.provider);
    const nextId = providerIds[(i + 1) % providerIds.length] as ProviderId;
    const first = getProvider(nextId).models()[0];
    if (!first) return;
    commit({ provider: nextId, model: first.id, effort: preserveEffort(first.efforts, sel.effort) });
  };

  const cycleModel = (): void => {
    const models = getProvider(sel.provider).models();
    const i = models.findIndex((m) => m.id === sel.model);
    const next = models[(i + 1) % models.length];
    if (!next) return;
    commit({ ...sel, model: next.id, effort: preserveEffort(next.efforts, sel.effort) });
  };

  const cycleEffort = (): void => {
    const model = getProvider(sel.provider).models().find((m) => m.id === sel.model);
    const efforts = model?.efforts ?? [];
    if (!efforts.length) return;
    const i = efforts.indexOf(sel.effort);
    commit({ ...sel, effort: efforts[(i + 1) % efforts.length] as Effort });
  };

  const cyclePeriod = (): void => {
    period = nextPeriod(period);
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

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.ctrl && key.name === "c") return quit();
    switch (key.name) {
      case "p":
        return cycleProvider();
      case "m":
        return cycleModel();
      case "e":
        return cycleEffort();
      case "w":
        return cyclePeriod();
      case "q":
        return quit();
    }
  });

  // Reflow immediately on terminal resize (Yoga relayouts the flex zones; this
  // re-derives the size-dependent content — stream auto-fill/clip and the
  // min-size guard — without waiting for the next poll).
  renderer.on("resize", () => render());

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
  // Auth refresh runs on a slower, decoupled cadence so authStatus() is not
  // invoked several times a second.
  authTimer = setInterval(() => {
    void refreshAuth();
  }, AUTH_REFRESH_MS);
}
