import pc from "picocolors";
import { PORT, TUNNEL_HOSTNAME } from "../config.ts";
import { allProviders, getProvider } from "../providers/registry.ts";
import {
  cacheTotals,
  DEFAULT_PERIOD,
  getPlanUsage,
  getSelection,
  nextPeriod,
  type Period,
  periodSince,
  type PlanWindow,
  recentActivity,
  setSelection,
} from "../store/state.ts";
import type { AuthStatus, Effort, ProviderId, Selection } from "../providers/types.ts";

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
 * Render the cache-rate line body (without color) for the active period.
 * Returns the dim dash form when there is no usable input data in the window.
 */
export function formatCacheRate(totals: { cached: number; input: number }, period: Period): string {
  if (totals.input <= 0) return `cache rate (${period})  —`;
  const pct = Math.round((totals.cached / totals.input) * 100);
  return `cache rate (${period})  ${pct}%  (${abbreviateCount(totals.cached)} cached / ${abbreviateCount(totals.input)} input)`;
}

/**
 * Live control panel. Reads selection + activity from the shared store and
 * writes the selection back when you cycle it — that store is the control
 * channel to the background service.
 *
 *   p cycle provider · m cycle model · e cycle effort · q quit
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

  const render = (): void => {
    const lines: string[] = [];
    lines.push(pc.bold(pc.cyan("  shim ")) + pc.dim("· multi-provider proxy for Cursor"));
    const base = TUNNEL_HOSTNAME ? `https://${TUNNEL_HOSTNAME}/v1` : pc.yellow(`http://127.0.0.1:${PORT}/v1 (no tunnel)`);
    lines.push(pc.dim(`  endpoint  `) + base);
    lines.push("");

    lines.push(pc.bold("  Active selection"));
    lines.push(
      `    provider ${pc.green(sel.provider)}   model ${pc.green(sel.model)}   effort ${pc.green(sel.effort)}`,
    );
    lines.push("");

    lines.push(pc.bold("  Providers"));
    for (const p of providers) {
      const a = authCache.get(p.id);
      const badge = a ? (a.ok ? pc.green("● ok") : pc.red("● " + a.detail)) : pc.dim("…");
      lines.push(`    ${p.id.padEnd(8)} ${badge}`);
    }
    lines.push("");

    lines.push(pc.bold("  Recent activity"));
    const rows = recentActivity(8);
    if (!rows.length) {
      lines.push(pc.dim("    (none yet)"));
    } else {
      for (const r of rows) {
        const t = new Date(r.ts).toLocaleTimeString();
        const seg = formatActivityTokens(r);
        const tok = seg ? pc.dim(seg) : "";
        const dur = r.duration_ms != null ? pc.dim(` ${r.duration_ms}ms`) : "";
        const status = r.status === "ok" ? pc.green(r.status) : r.status === "error" ? pc.red(r.status) : pc.yellow(r.status);
        lines.push(`    ${pc.dim(t)} ${r.provider}/${r.model} ${status}${tok}${dur}`);
      }
    }
    lines.push("");

    lines.push(pc.bold("  Cache"));
    lines.push(pc.dim(`    ${formatCacheRate(cacheTotals(periodSince(period, Date.now())), period)}`));
    lines.push("");

    lines.push(pc.bold("  Plan usage") + pc.dim(" (claude)"));
    const usage = getPlanUsage("claude");
    if (!usage) {
      lines.push(pc.dim("    (no data yet)"));
    } else {
      const now = Date.now();
      const bar = (label: string, w: PlanWindow): string => {
        const lvl = usageLevel(w.utilization);
        const colour = lvl === "crit" ? pc.red : lvl === "warn" ? pc.yellow : pc.green;
        return `    ${colour(formatPlanUsage(label, w, now))}`;
      };
      lines.push(bar("5h", usage.fiveHour));
      lines.push(bar("weekly", usage.weekly));
    }
    lines.push("");
    lines.push(pc.dim("  p provider · m model · e effort · w window · q quit"));

    process.stdout.write("\x1b[2J\x1b[H" + lines.join("\n") + "\n");
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
    const effort: Effort = first.efforts.includes(sel.effort) ? sel.effort : (first.efforts[0] ?? "medium");
    commit({ provider: nextId, model: first.id, effort });
  };

  const cycleModel = (): void => {
    const models = getProvider(sel.provider).models();
    const i = models.findIndex((m) => m.id === sel.model);
    const next = models[(i + 1) % models.length];
    if (!next) return;
    const effort: Effort = next.efforts.includes(sel.effort) ? sel.effort : (next.efforts[0] ?? "medium");
    commit({ ...sel, model: next.id, effort });
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

  let timer: ReturnType<typeof setInterval> | undefined;

  const stdin = process.stdin;
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  const quit = (): void => {
    if (timer) clearInterval(timer);
    stdin.setRawMode?.(false);
    process.stdout.write("\n");
    process.exit(0);
  };

  stdin.on("data", (key: string) => {
    switch (key) {
      case "p":
        cycleProvider();
        break;
      case "m":
        cycleModel();
        break;
      case "e":
        cycleEffort();
        break;
      case "w":
        cyclePeriod();
        break;
      case "q":
      case "": // Ctrl-C
        quit();
        break;
    }
  });

  await refreshAuth();
  render();
  timer = setInterval(() => {
    sel = getSelection();
    void refreshAuth().then(render);
  }, 2000);
}
