import pc from "picocolors";
import { PORT, TUNNEL_HOSTNAME } from "../config.ts";
import { allProviders, getProvider } from "../providers/registry.ts";
import { getSelection, recentActivity, setSelection } from "../store/state.ts";
import type { AuthStatus, Effort, ProviderId, Selection } from "../providers/types.ts";

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
        const tok =
          r.prompt_tokens != null || r.completion_tokens != null
            ? pc.dim(` ${r.prompt_tokens ?? "?"}→${r.completion_tokens ?? "?"}tok`)
            : "";
        const dur = r.duration_ms != null ? pc.dim(` ${r.duration_ms}ms`) : "";
        const status = r.status === "ok" ? pc.green(r.status) : r.status === "error" ? pc.red(r.status) : pc.yellow(r.status);
        lines.push(`    ${pc.dim(t)} ${r.provider}/${r.model} ${status}${tok}${dur}`);
      }
    }
    lines.push("");
    lines.push(pc.dim("  p provider · m model · e effort · q quit"));

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
