import { test, expect } from "bun:test";
import {
  abbreviateCount,
  type ActivityCell,
  activityColumns,
  activityTitle,
  authDotState,
  cacheRateView,
  clipColumns,
  commitPicker,
  countersView,
  cycleFilter,
  detailLines,
  emptyState,
  followSeparator,
  formatActivityTokens,
  formatAuthMeta,
  formatElapsed,
  formatEndpoint,
  formatResetCountdown,
  hintsFor,
  initialStreamState,
  isTerminalTooSmall,
  keycapParts,
  layoutTier,
  MIN_COLS,
  MIN_ROWS,
  moveFocus,
  movePicker,
  onPoll,
  openPicker,
  optimisticReset,
  padColumns,
  pickerRows,
  planUsageParts,
  preserveEffort,
  type ProviderCatalog,
  resumeFollow,
  SIDEBAR_MIN_COLS,
  slugLabel,
  spinnerFrame,
  statusCellText,
  toggleExpanded,
  truncateDetail,
  usageLevel,
  wrapText,
} from "./tui.ts";
import type { Selection } from "../providers/types.ts";

test("abbreviateCount leaves values <= 1000 unabbreviated", () => {
  expect(abbreviateCount(0)).toBe("0");
  expect(abbreviateCount(999)).toBe("999");
  expect(abbreviateCount(1000)).toBe("1k");
});

test("abbreviateCount uses k notation above 1000", () => {
  expect(abbreviateCount(1200)).toBe("1.2k");
  expect(abbreviateCount(2700)).toBe("2.7k");
  expect(abbreviateCount(12_000)).toBe("12k");
});

test("abbreviateCount uses M notation above one million", () => {
  expect(abbreviateCount(1_000_000)).toBe("1M");
  expect(abbreviateCount(2_500_000)).toBe("2.5M");
});

test("usageLevel bands at 70% (warn) and 90% (crit)", () => {
  expect(usageLevel(0)).toBe("ok");
  expect(usageLevel(0.699)).toBe("ok");
  expect(usageLevel(0.7)).toBe("warn");
  expect(usageLevel(0.899)).toBe("warn");
  expect(usageLevel(0.9)).toBe("crit");
  expect(usageLevel(1)).toBe("crit");
});

test("formatResetCountdown renders days, hours, minutes, and edge cases", () => {
  const now = 1_000_000_000_000;
  expect(formatResetCountdown(now + 2 * 86_400_000 + 3 * 3_600_000, now)).toBe("2d 3h");
  expect(formatResetCountdown(now + 1 * 3_600_000 + 2 * 60_000, now)).toBe("1h 2m");
  expect(formatResetCountdown(now + 5 * 60_000, now)).toBe("5m");
  expect(formatResetCountdown(now + 30_000, now)).toBe("<1m");
  expect(formatResetCountdown(now, now)).toBe("now");
  expect(formatResetCountdown(now - 60_000, now)).toBe("now"); // already past
});

test("planUsageParts splits the line so only the bar and percent take level colour", () => {
  const now = 1_000_000_000_000;
  expect(
    planUsageParts("5h", { utilization: 0.71, resetAt: now + 3_600_000 + 2 * 60_000, status: "allowed" }, now),
  ).toEqual({
    label: "5h     ",
    bar: "[███████░░░]",
    pct: " 71%",
    reset: "resets in 1h 2m",
    flag: "",
  });
});

test("planUsageParts surfaces a non-allowed status as a flag so throttling is visible", () => {
  const now = 1_000_000_000_000;
  expect(planUsageParts("5h", { utilization: 1, resetAt: now + 60_000, status: "rejected" }, now)).toEqual({
    label: "5h     ",
    bar: "[██████████]",
    pct: "100%",
    reset: "resets in 1m",
    flag: "rejected",
  });
});

test("planUsageParts clamps utilization into the bar and percent", () => {
  const now = 1_000_000_000_000;
  expect(planUsageParts("weekly", { utilization: 0, resetAt: now, status: "allowed" }, now)).toEqual({
    label: "weekly ",
    bar: "[░░░░░░░░░░]",
    pct: "  0%",
    reset: "resets in now",
    flag: "",
  });
  expect(planUsageParts("5h", { utilization: 1.4, resetAt: now + 60_000, status: "allowed" }, now).pct).toBe("100%");
});

test("optimisticReset forces utilization to 0 once now passes the reset boundary", () => {
  const now = 1_000_000_000_000;
  const window = { utilization: 0.71, resetAt: now - 1, status: "allowed" };
  expect(optimisticReset(window, now)).toEqual({ utilization: 0, resetAt: now - 1, status: "allowed" });
});

test("optimisticReset leaves a window untouched before and exactly at the reset", () => {
  const now = 1_000_000_000_000;
  const future = { utilization: 0.71, resetAt: now + 1, status: "allowed" };
  expect(optimisticReset(future, now)).toBe(future); // before reset: same reference, untouched
  const atBoundary = { utilization: 0.71, resetAt: now, status: "allowed" };
  expect(optimisticReset(atBoundary, now)).toBe(atBoundary); // not strictly past yet
});

test("formatActivityTokens shows the cached witness when cache reads landed", () => {
  expect(
    formatActivityTokens({ prompt_tokens: 12000, completion_tokens: 200, cached_tokens: 11500 }),
  ).toBe(" 12000→200tok (cached 11.5k)");
});

test("formatActivityTokens omits the cached segment when there are no cache reads", () => {
  expect(
    formatActivityTokens({ prompt_tokens: 500, completion_tokens: 200, cached_tokens: 0 }),
  ).toBe(" 500→200tok");
  expect(
    formatActivityTokens({ prompt_tokens: 500, completion_tokens: 200, cached_tokens: null }),
  ).toBe(" 500→200tok");
});

test("formatActivityTokens shows a 'wrote' witness on a cold-write turn, distinct from a large prompt", () => {
  // Cold write: big prompt, but the giveaway is cache_creation, not cached reads.
  expect(
    formatActivityTokens({ prompt_tokens: 12000, completion_tokens: 200, cached_tokens: 0, cache_creation: 11500 }),
  ).toBe(" 12000→200tok (wrote 11.5k)");
  // A legitimately large prompt with no cache activity shows no witness at all.
  expect(
    formatActivityTokens({ prompt_tokens: 12000, completion_tokens: 200, cached_tokens: 0, cache_creation: 0 }),
  ).toBe(" 12000→200tok");
});

test("formatActivityTokens shows cached and wrote together when both landed", () => {
  expect(
    formatActivityTokens({ prompt_tokens: 12000, completion_tokens: 200, cached_tokens: 8000, cache_creation: 3500 }),
  ).toBe(" 12000→200tok (cached 8k, wrote 3.5k)");
});

test("formatActivityTokens omits the wrote segment when cache_creation is 0, null, or absent", () => {
  expect(
    formatActivityTokens({ prompt_tokens: 500, completion_tokens: 200, cached_tokens: 0, cache_creation: null }),
  ).toBe(" 500→200tok");
  // Absent field (older row shape) behaves like null.
  expect(
    formatActivityTokens({ prompt_tokens: 500, completion_tokens: 200, cached_tokens: 0 }),
  ).toBe(" 500→200tok");
});

test("formatActivityTokens renders unknown counts as ? but still shows cached", () => {
  expect(
    formatActivityTokens({ prompt_tokens: null, completion_tokens: 200, cached_tokens: 300 }),
  ).toBe(" ?→200tok (cached 300)");
});

test("formatActivityTokens is empty when no token counts were recorded", () => {
  expect(
    formatActivityTokens({ prompt_tokens: null, completion_tokens: null, cached_tokens: null }),
  ).toBe("");
  // A pending row with no usage yet shows nothing, even if cached were somehow set.
  expect(
    formatActivityTokens({ prompt_tokens: null, completion_tokens: null, cached_tokens: 99 }),
  ).toBe("");
});

// --- cache rate + counters -----------------------------------------------------

test("cacheRateView derives the aggregate percent and detail from the all-time totals", () => {
  const view = cacheRateView({ cached: 170, input: 300 });
  expect(view.label).toBe("cache");
  expect(view.value).toBe("57%"); // 170 / 300
  expect(view.detail).toBe("170 cached / 300 input");
});

test("cacheRateView abbreviates the detail counts like the rest of the panel", () => {
  const view = cacheRateView({ cached: 1200, input: 2700 });
  expect(view.value).toBe("44%");
  expect(view.detail).toBe("1.2k cached / 2.7k input");
});

test("cacheRateView renders 0% with no measured input", () => {
  expect(cacheRateView({ cached: 0, input: 0 })).toEqual({
    label: "cache",
    value: "0%",
    detail: "",
  });
});

test("countersView renders requests and errors as label/value pairs (no window)", () => {
  expect(countersView({ requests: 128, errors: 3 })).toEqual([
    { label: "requests", value: "128" },
    { label: "errors", value: "3" },
  ]);
});

test("countersView abbreviates large counts like the rest of the panel", () => {
  expect(countersView({ requests: 12_000, errors: 0 })).toEqual([
    { label: "requests", value: "12k" },
    { label: "errors", value: "0" },
  ]);
});

test("isTerminalTooSmall guards below the minimum on either axis", () => {
  expect(isTerminalTooSmall(MIN_COLS, MIN_ROWS)).toBe(false); // exactly at the minimum is fine
  expect(isTerminalTooSmall(MIN_COLS - 1, MIN_ROWS)).toBe(true); // too narrow
  expect(isTerminalTooSmall(MIN_COLS, MIN_ROWS - 1)).toBe(true); // too short
  expect(isTerminalTooSmall(120, 40)).toBe(false); // roomy
});

// --- status bar presenters ---------------------------------------------------

test("authDotState maps absence to pending, ok to ok, and not-ok to down", () => {
  expect(authDotState(undefined)).toBe("pending");
  expect(authDotState({ ok: true, detail: "max plan" })).toBe("ok");
  expect(authDotState({ ok: false, detail: "credentials not found" })).toBe("down");
});

test("formatEndpoint prefers the public tunnel hostname when configured", () => {
  expect(formatEndpoint("proxy.example.com", 8787)).toEqual({
    url: "https://proxy.example.com/v1",
    tunnel: "up",
  });
});

test("formatEndpoint falls back to the local address with tunnel off", () => {
  expect(formatEndpoint("", 8787)).toEqual({ url: "http://127.0.0.1:8787/v1", tunnel: "off" });
});

test("truncateDetail leaves short details intact and ellipsizes long ones", () => {
  expect(truncateDetail("credentials not found")).toBe("credentials not found");
  expect(truncateDetail("0123456789", 5)).toBe("0123…");
  expect(truncateDetail("01234", 5)).toBe("01234"); // exactly at the limit, untouched
});

test("formatAuthMeta shows just the id when ok, unchecked, or detail-less", () => {
  expect(formatAuthMeta("claude", { ok: true, detail: "max plan" })).toBe("claude");
  expect(formatAuthMeta("codex", undefined)).toBe("codex");
  expect(formatAuthMeta("claude", { ok: false, detail: "" })).toBe("claude");
});

test("formatAuthMeta surfaces a down provider's error detail inline, truncated", () => {
  expect(formatAuthMeta("claude", { ok: false, detail: "token expired" })).toBe(
    "claude token expired",
  );
  const long = "x".repeat(60);
  expect(formatAuthMeta("claude", { ok: false, detail: long })).toBe(`claude ${truncateDetail(long)}`);
});

// --- activity stream presenters ----------------------------------------------

const FROZEN = 1_000_000_000_000;
const baseRow = {
  ts: FROZEN,
  status: "ok",
  provider: "claude",
  model: "claude-sonnet-4-6",
  duration_ms: 1234 as number | null,
  note: null as string | null,
  prompt_tokens: 12000 as number | null,
  completion_tokens: 200 as number | null,
  cached_tokens: 11500 as number | null,
  cache_creation: null as number | null,
};
const LABELS = new Map([["claude-sonnet-4-6", "sonnet-4.6"]]);

test("spinnerFrame is a deterministic function of now and wraps over the frames", () => {
  expect(spinnerFrame(0)).toBe("⠋");
  expect(spinnerFrame(80)).toBe("⠙");
  expect(spinnerFrame(80 * 9)).toBe("⠏");
  expect(spinnerFrame(80 * 10)).toBe("⠋"); // wraps back to the first frame
  expect(spinnerFrame(-50)).toBe("⠋"); // clamped, never negative-indexes
});

test("formatElapsed ticks in seconds under a minute and m/s beyond", () => {
  expect(formatElapsed(FROZEN, FROZEN)).toBe("0.0s");
  expect(formatElapsed(FROZEN - 1500, FROZEN)).toBe("1.5s");
  expect(formatElapsed(FROZEN - 65_000, FROZEN)).toBe("1m 5s");
  expect(formatElapsed(FROZEN + 1000, FROZEN)).toBe("0.0s"); // future ts clamps to 0
});

test("statusCellText pairs a glyph with the word so state survives poor colour", () => {
  expect(statusCellText("ok", FROZEN)).toBe("✓ ok");
  expect(statusCellText("error", FROZEN)).toBe("✗ error");
  expect(statusCellText("pending", FROZEN)).toBe(spinnerFrame(FROZEN));
  expect(statusCellText("timeout", FROZEN)).toBe("timeout"); // unknown statuses pass through
});

test("slugLabel compacts a display label for the source column", () => {
  expect(slugLabel("Fable 5")).toBe("fable-5");
  expect(slugLabel("GPT-5.4 mini")).toBe("gpt-5.4-mini");
});

test("activityTitle shows a live in-flight count while pending and hides it when idle", () => {
  expect(activityTitle(0, FROZEN)).toBe(" activity ");
  expect(activityTitle(1, FROZEN)).toBe(` activity · ${spinnerFrame(FROZEN)} 1 in-flight `);
  expect(activityTitle(12, FROZEN)).toBe(` activity · ${spinnerFrame(FROZEN)} 12 in-flight `);
});

test("activityColumns emits the five fixed slots for an ok row, with the model's short label", () => {
  expect(activityColumns(baseRow, "12:00:00", FROZEN, { labels: LABELS })).toEqual([
    { text: "12:00:00", kind: "time" },
    { text: "✓ ok", kind: "status" },
    { text: "claude/sonnet-4.6", kind: "source" },
    { text: "12000→200tok (cached 11.5k)", kind: "tokens" },
    { text: "1234ms", kind: "duration" },
  ]);
});

test("activityColumns falls back to the raw model id when no label is known", () => {
  const cells = activityColumns(baseRow, "12:00:00", FROZEN);
  expect(cells[2]).toEqual({ text: "claude/claude-sonnet-4-6", kind: "source" });
});

test("activityColumns makes a pending row live: spinner status + elapsed, empty duration", () => {
  const pending = { ...baseRow, ts: FROZEN - 2300, status: "pending", prompt_tokens: null, completion_tokens: null, cached_tokens: null, duration_ms: null };
  expect(activityColumns(pending, "12:00:00", FROZEN, { labels: LABELS })).toEqual([
    { text: "12:00:00", kind: "time" },
    { text: spinnerFrame(FROZEN), kind: "status" },
    { text: "claude/sonnet-4.6", kind: "source" },
    { text: "2.3s", kind: "elapsed" },
    { text: "", kind: "duration" },
  ]);
});

test("activityColumns puts a truncated note in the witness slot for an error row", () => {
  const err = { ...baseRow, status: "error", note: "upstream 529 overloaded", prompt_tokens: null, completion_tokens: null, duration_ms: null };
  expect(activityColumns(err, "12:00:00", FROZEN)).toEqual([
    { text: "12:00:00", kind: "time" },
    { text: "✗ error", kind: "status" },
    { text: "claude/claude-sonnet-4-6", kind: "source" },
    { text: "upstream 529 overloaded", kind: "note" },
    { text: "", kind: "duration" },
  ]);
  const long = { ...err, note: "x".repeat(50) };
  const cells = activityColumns(long, "12:00:00", FROZEN, { noteMax: 32 });
  expect(cells[3]).toEqual({ text: truncateDetail("x".repeat(50), 32), kind: "note" });
});

test("activityColumns keeps the witness slot present (empty) when nothing was measured", () => {
  const bare = { ...baseRow, prompt_tokens: null, completion_tokens: null, cached_tokens: null };
  const cells = activityColumns(bare, "12:00:00", FROZEN);
  expect(cells[3]).toEqual({ text: "", kind: "tokens" });
  expect(cells[4]).toEqual({ text: "1234ms", kind: "duration" });
});

test("padColumns aligns each column to its max width, right-aligning duration", () => {
  const rows: ActivityCell[][] = [
    [
      { text: "12:00:00", kind: "time" },
      { text: "✓ ok", kind: "status" },
      { text: "42ms", kind: "duration" },
    ],
    [
      { text: "9:00:00", kind: "time" },
      { text: "✗ error", kind: "status" },
      { text: "1234ms", kind: "duration" },
    ],
  ];
  expect(padColumns(rows)).toEqual([
    [
      { text: "12:00:00", kind: "time" },
      { text: "✓ ok   ", kind: "status" },
      { text: "  42ms", kind: "duration" }, // right-aligned: outliers jump out
    ],
    [
      { text: "9:00:00 ", kind: "time" },
      { text: "✗ error", kind: "status" },
      { text: "1234ms", kind: "duration" },
    ],
  ]);
});

test("padColumns is a no-op on an empty stream", () => {
  expect(padColumns([])).toEqual([]);
});

test("clipColumns drops the rightmost columns first as width shrinks", () => {
  const cells: ActivityCell[] = [
    { text: "AAAA", kind: "time" }, // 4
    { text: "BB", kind: "status" }, // +1+2 = 7
    { text: "CCC", kind: "source" }, // +1+3 = 11
    { text: "DD", kind: "duration" }, // +1+2 = 14
  ];
  expect(clipColumns(cells, 14).map((c) => c.kind)).toEqual(["time", "status", "source", "duration"]);
  expect(clipColumns(cells, 13).map((c) => c.kind)).toEqual(["time", "status", "source"]); // duration drops
  expect(clipColumns(cells, 10).map((c) => c.kind)).toEqual(["time", "status"]); // source drops
  expect(clipColumns(cells, 6).map((c) => c.kind)).toEqual(["time"]); // status drops
  expect(clipColumns(cells, 3)).toEqual([]); // even time does not fit
});

test("clipColumns accounts for a wider column gap", () => {
  const cells: ActivityCell[] = [
    { text: "AAAA", kind: "time" }, // 4
    { text: "BB", kind: "status" }, // +2+2 = 8 with gap 2
  ];
  expect(clipColumns(cells, 8, 2).map((c) => c.kind)).toEqual(["time", "status"]);
  expect(clipColumns(cells, 7, 2).map((c) => c.kind)).toEqual(["time"]); // gap counted
});

// --- footer hints --------------------------------------------------------------

test("hintsFor lists the global keys in default mode, with move and filter", () => {
  expect(hintsFor({ mode: "default", filter: "all" }).map((h) => h.key)).toEqual([
    "↑↓",
    "f",
    "p",
    "m",
    "e",
    "c",
    "q",
  ]);
});

test("hintsFor adds the detail key and 'copy id' when a row is focused", () => {
  const hints = hintsFor({ mode: "default", focused: true, filter: "errors" });
  expect(hints.find((h) => h.key === "⏎")).toEqual({ key: "⏎", label: "detail" });
  expect(hints.find((h) => h.key === "c")).toEqual({ key: "c", label: "copy id" });
  expect(hints.find((h) => h.key === "f")).toEqual({ key: "f", label: "filter errors" });
});

test("hintsFor surfaces the resume key when follow is paused", () => {
  const hints = hintsFor({ mode: "default", paused: true, filter: "all" });
  expect(hints[0]).toEqual({ key: "esc", label: "resume" });
});

test("hintsFor swaps to the modal controls while a picker is open", () => {
  expect(hintsFor({ mode: "picker" })).toEqual([
    { key: "↑↓", label: "move" },
    { key: "⏎", label: "select" },
    { key: "esc", label: "cancel" },
  ]);
});

test("cycleFilter rotates all → errors → pending → all", () => {
  expect(cycleFilter("all")).toBe("errors");
  expect(cycleFilter("errors")).toBe("pending");
  expect(cycleFilter("pending")).toBe("all");
});

test("followSeparator carries the new-row count, or a plain marker at zero", () => {
  expect(followSeparator(0)).toBe("── follow paused ──");
  expect(followSeparator(38)).toBe("── follow paused · 38 new ──");
  expect(followSeparator(1200)).toBe("── follow paused · 1.2k new ──");
});

test("keycapParts splits a hint into its highlighted keycap and dim remainder", () => {
  expect(keycapParts({ key: "p", label: "provider" })).toEqual({ cap: "[p]", rest: "rovider" });
  expect(keycapParts({ key: "esc", label: "cancel" })).toEqual({ cap: "[esc]", rest: " cancel" });
  expect(keycapParts({ key: "⏎", label: "select" })).toEqual({ cap: "[⏎]", rest: " select" });
});

// --- selection pickers ----------------------------------------------------------

const CATALOG: ProviderCatalog = [
  {
    id: "claude",
    models: [
      { id: "claude-fable-5", label: "Fable 5", efforts: ["low", "medium", "high", "xhigh"] },
      { id: "claude-opus-4-8", label: "Opus 4.8", efforts: ["low", "medium", "high", "xhigh"] },
    ],
  },
  {
    id: "codex",
    models: [{ id: "gpt-5.5", label: "GPT-5.5", efforts: ["low", "high"] }],
  },
];
const SEL: Selection = { provider: "claude", model: "claude-opus-4-8", effort: "medium" };

test("openPicker lists providers with the current one marked and highlighted", () => {
  const picker = openPicker("provider", SEL, CATALOG)!;
  expect(picker.options).toEqual([
    { id: "claude", label: "claude" },
    { id: "codex", label: "codex" },
  ]);
  expect(picker.index).toBe(0);
  expect(picker.currentIndex).toBe(0);
});

test("openPicker lists the active provider's models by short label", () => {
  const picker = openPicker("model", SEL, CATALOG)!;
  expect(picker.options).toEqual([
    { id: "claude-fable-5", label: "Fable 5" },
    { id: "claude-opus-4-8", label: "Opus 4.8" },
  ]);
  expect(picker.currentIndex).toBe(1); // the active model is marked
  expect(picker.index).toBe(1);
});

test("openPicker lists the active model's efforts", () => {
  const picker = openPicker("effort", SEL, CATALOG)!;
  expect(picker.options.map((o) => o.id)).toEqual(["low", "medium", "high", "xhigh"]);
  expect(picker.currentIndex).toBe(1);
});

test("openPicker is null when there is nothing to pick", () => {
  const stale: Selection = { provider: "claude", model: "removed-model", effort: "medium" };
  expect(openPicker("effort", stale, CATALOG)).toBeNull();
  expect(openPicker("model", SEL, [])).toBeNull();
});

test("movePicker moves the highlight and wraps both ways", () => {
  const picker = openPicker("provider", SEL, CATALOG)!;
  expect(movePicker(picker, 1).index).toBe(1);
  expect(movePicker(movePicker(picker, 1), 1).index).toBe(0); // wraps forward
  expect(movePicker(picker, -1).index).toBe(1); // wraps backward
});

test("repeat-trigger advance is a +1 move, so fast-cycling muscle memory still works", () => {
  let picker = openPicker("model", SEL, CATALOG)!;
  picker = movePicker(picker, 1); // second press of `m` while open
  expect(picker.index).toBe(0); // wrapped past the end
  expect(picker.currentIndex).toBe(1); // the current marker never moves
});

test("commitPicker on a model preserves the effort when the target supports it", () => {
  const picker = movePicker(openPicker("model", SEL, CATALOG)!, -1); // highlight Fable 5
  expect(commitPicker(picker, SEL, CATALOG)).toEqual({
    provider: "claude",
    model: "claude-fable-5",
    effort: "medium", // supported → preserved
  });
});

test("commitPicker on a provider lands on its first model and falls back the effort if unsupported", () => {
  const picker = movePicker(openPicker("provider", SEL, CATALOG)!, 1); // highlight codex
  expect(commitPicker(picker, SEL, CATALOG)).toEqual({
    provider: "codex",
    model: "gpt-5.5",
    effort: "low", // "medium" unsupported by gpt-5.5 → falls back to its first
  });
});

test("commitPicker on the already-current provider is a no-op (model untouched)", () => {
  const picker = openPicker("provider", SEL, CATALOG)!; // highlight stays on claude
  expect(commitPicker(picker, SEL, CATALOG)).toEqual(SEL);
});

test("commitPicker on an effort sets it directly", () => {
  const picker = movePicker(openPicker("effort", SEL, CATALOG)!, 1); // highlight "high"
  expect(commitPicker(picker, SEL, CATALOG)).toEqual({ ...SEL, effort: "high" });
});

test("preserveEffort keeps a supported effort and falls back to the first otherwise", () => {
  expect(preserveEffort(["low", "medium", "high"], "medium")).toBe("medium");
  expect(preserveEffort(["low", "high"], "medium")).toBe("low");
  expect(preserveEffort([], "medium")).toBe("medium");
});

test("pickerRows marks the highlight and the current choice independently", () => {
  const picker = movePicker(openPicker("model", SEL, CATALOG)!, -1);
  expect(pickerRows(picker)).toEqual([
    { text: "▸   Fable 5", active: true },
    { text: "  ● Opus 4.8", active: false },
  ]);
});

// --- inline row detail -----------------------------------------------------------

test("wrapText wraps on word boundaries and hard-breaks oversized words", () => {
  expect(wrapText("upstream 529 overloaded", 12)).toEqual(["upstream 529", "overloaded"]);
  expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  expect(wrapText("", 10)).toEqual([""]);
  expect(wrapText("a\nb", 10)).toEqual(["a", "b"]); // explicit newlines preserved
});

const detailRow = {
  status: "ok",
  effort: "medium",
  duration_ms: 842 as number | null,
  note: null as string | null,
  request_id: "req-abc123",
  prompt_tokens: 8142 as number | null,
  completion_tokens: 412 as number | null,
  cached_tokens: 7920 as number | null,
  cache_creation: 0 as number | null,
};

test("detailLines shows the meta line and full token breakdown for an ok row", () => {
  expect(detailLines(detailRow, 60)).toEqual([
    "request_id req-abc123  ·  effort medium  ·  842ms",
    "prompt 8142  ·  completion 412  ·  cached 7920  ·  wrote 0",
  ]);
});

test("detailLines renders unmeasured token counts as em dashes", () => {
  const bare = { ...detailRow, prompt_tokens: null, completion_tokens: null, cached_tokens: null, cache_creation: null };
  expect(detailLines(bare, 60)[1]).toBe("prompt —  ·  completion —  ·  cached —  ·  wrote —");
});

test("detailLines wraps the full error note instead of the token breakdown", () => {
  const err = { ...detailRow, status: "error", note: "upstream 529 overloaded, retry later", duration_ms: null };
  expect(detailLines(err, 20)).toEqual([
    "request_id req-abc123  ·  effort medium",
    "upstream 529",
    "overloaded, retry",
    "later",
  ]);
});

test("detailLines truncates a long error note with an ellipsis line on a short terminal", () => {
  const err = { ...detailRow, status: "error", note: "one two three four five six", duration_ms: null };
  const lines = detailLines(err, 5, 3);
  expect(lines.slice(1)).toEqual(["one", "two", "…"]); // 2 note lines + ellipsis
});

// --- focus + follow state machine ------------------------------------------------

test("initialStreamState follows the head with nothing focused", () => {
  expect(initialStreamState()).toEqual({ focus: null, expanded: false, following: true, newWhilePaused: 0 });
});

test("moveFocus lands on the head from nothing, then clamps without wrapping", () => {
  let s = initialStreamState();
  s = moveFocus(s, 1, 5); // first move → head (index 0)
  expect(s.focus).toBe(0);
  expect(s.following).toBe(true); // still at the head
  s = moveFocus(s, 1, 5); // away from head
  expect(s.focus).toBe(1);
  expect(s.following).toBe(false); // follow paused
  s = moveFocus(s, -5, 5); // clamps at the head, resumes follow
  expect(s.focus).toBe(0);
  expect(s.following).toBe(true);
  s = moveFocus(s, 99, 5); // clamps at the tail
  expect(s.focus).toBe(4);
});

test("moveFocus collapses an open detail when the focus actually moves", () => {
  let s = moveFocus(initialStreamState(), 1, 5); // focus head
  s = toggleExpanded(s);
  expect(s.expanded).toBe(true);
  s = moveFocus(s, 1, 5);
  expect(s.expanded).toBe(false);
});

test("moveFocus clears focus on an empty stream", () => {
  expect(moveFocus(initialStreamState(), 1, 0)).toMatchObject({ focus: null, expanded: false });
});

test("toggleExpanded flips the focused detail and no-ops with nothing focused", () => {
  expect(toggleExpanded(initialStreamState()).expanded).toBe(false); // no focus → unchanged
  const focused = moveFocus(initialStreamState(), 1, 3);
  expect(toggleExpanded(focused).expanded).toBe(true);
  expect(toggleExpanded(toggleExpanded(focused)).expanded).toBe(false);
});

test("resumeFollow pins the head, clears the counter, and collapses detail", () => {
  const paused = { focus: 4, expanded: true, following: false, newWhilePaused: 12 };
  expect(resumeFollow(paused)).toEqual({ focus: 0, expanded: false, following: true, newWhilePaused: 0 });
});

test("onPoll keeps the focused row stable and counts new rows while paused", () => {
  const paused = { focus: 2, expanded: false, following: false, newWhilePaused: 0 };
  const after = onPoll(paused, 3, 20); // 3 rows arrived at the head
  expect(after.focus).toBe(5); // shifted down by 3 to stay on the same row
  expect(after.newWhilePaused).toBe(3);
});

test("onPoll is a no-op while following or with nothing focused", () => {
  const following = initialStreamState();
  expect(onPoll(following, 5, 20)).toBe(following);
});

// --- layout tier -----------------------------------------------------------------

test("layoutTier switches to the sidebar at the threshold width", () => {
  expect(layoutTier(SIDEBAR_MIN_COLS)).toBe("wide");
  expect(layoutTier(SIDEBAR_MIN_COLS - 1)).toBe("compact");
  expect(layoutTier(140)).toBe("wide");
  expect(layoutTier(60)).toBe("compact");
});

// --- empty state -----------------------------------------------------------------

test("emptyState tells a newcomer the next step: the endpoint and how to copy it", () => {
  expect(emptyState("http://127.0.0.1:8787/v1")).toEqual({
    headline: "no activity yet — point Cursor at",
    url: "http://127.0.0.1:8787/v1",
    hint: "press [c] to copy the endpoint",
  });
});
