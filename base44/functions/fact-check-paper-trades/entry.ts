import { createClientFromRequest } from "npm:@base44/sdk";
import { factCheckPaperTrade, refreshBacktestStrategyStats } from "../../shared/paper-trading.ts";

const DEFAULT_LIMIT = 100;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const limit = Math.min(Math.max(Number(body?.limit) || DEFAULT_LIMIT, 1), 250);

    const [won, lost] = await Promise.all([
      base44.entities.PaperTrade.filter({ status: "won" }, "-exit_at", Math.ceil(limit / 2)),
      base44.entities.PaperTrade.filter({ status: "lost" }, "-exit_at", Math.ceil(limit / 2)),
    ]);
    const slice = [...won, ...lost];

    let checked = 0;
    let corrected = 0;
    let reopened = 0;
    let flipped = 0;
    const examples: any[] = [];
    const strategyIds: string[] = [];

    for (const t of slice) {
      checked += 1;
      const patch = await factCheckPaperTrade(t);
      await sleep(50);
      if (!patch) continue;
      await base44.entities.PaperTrade.update(t.id, patch);
      corrected += 1;
      if (patch.status === "open") reopened += 1;
      if ((patch.status === "won" || patch.status === "lost") && patch.status !== t.status) {
        flipped += 1;
      }
      if (t.is_backtest) strategyIds.push(t.strategy_id);
      if (examples.length < 15) {
        examples.push({
          id: t.id,
          title: patch.market_title || t.market_title,
          outcome: patch.outcome || t.outcome,
          was: t.status,
          now: patch.status,
          oldPnl: t.pnl_usd,
          newPnl: patch.pnl_usd,
        });
      }
    }

    if (strategyIds.length) {
      try {
        await refreshBacktestStrategyStats(base44, strategyIds);
      } catch {
        /* best-effort */
      }
    }

    return Response.json({
      checked,
      corrected,
      reopened,
      flipped,
      examples,
    });
  } catch (err: any) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
