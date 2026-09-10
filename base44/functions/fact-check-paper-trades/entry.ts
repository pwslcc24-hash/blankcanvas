import { createClientFromRequest } from "npm:@base44/sdk";
import { factCheckPaperTrade, refreshBacktestStrategyStats } from "../../shared/paper-trading.ts";

const DEFAULT_LIMIT = 40;

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
    const limit = Math.min(Math.max(Number(body?.limit) || DEFAULT_LIMIT, 1), 100);
    const offset = Math.max(Number(body?.offset) || 0, 0);
    const skipStats = body?.skipStats === true;

    const statusFilter = ["won", "lost", "open"].includes(body?.status) ? body.status : null;

    let slice: any[] = [];
    let won: any[] = [];
    let lost: any[] = [];
    let open: any[] = [];
    if (statusFilter) {
      slice = await base44.entities.PaperTrade.filter(
        { status: statusFilter },
        "-entry_at",
        limit,
        offset
      );
      if (statusFilter === "won") won = slice;
      if (statusFilter === "lost") lost = slice;
      if (statusFilter === "open") open = slice;
    } else {
      [won, lost, open] = await Promise.all([
        base44.entities.PaperTrade.filter({ status: "won" }, "-entry_at", limit, offset),
        base44.entities.PaperTrade.filter({ status: "lost" }, "-entry_at", limit, offset),
        base44.entities.PaperTrade.filter({ status: "open" }, "-entry_at", limit, offset),
      ]);
      slice = [...won, ...lost, ...open];
    }

    let checked = 0;
    let corrected = 0;
    let reopened = 0;
    let flipped = 0;
    let settled = 0;
    const examples: any[] = [];
    const strategyIds: string[] = [];

    for (const t of slice) {
      checked += 1;
      try {
        const patch = await factCheckPaperTrade(t);
        await sleep(20);
        if (!patch) continue;
        await base44.entities.PaperTrade.update(t.id, patch);
        corrected += 1;
        if (patch.status === "open" && t.status !== "open") reopened += 1;
        if (
          (patch.status === "won" || patch.status === "lost") &&
          patch.status !== t.status
        ) {
          flipped += 1;
          if (t.status === "open") settled += 1;
        }
        if (t.is_backtest) strategyIds.push(t.strategy_id);
        if (examples.length < 20) {
          examples.push({
            id: t.id,
            title: patch.market_title || t.market_title,
            outcome: patch.outcome || t.outcome,
            was: t.status,
            now: patch.status ?? t.status,
            oldPnl: t.pnl_usd,
            newPnl: patch.pnl_usd,
          });
        }
      } catch (err: any) {
        if (examples.length < 20) {
          examples.push({
            id: t.id,
            title: t.market_title,
            error: String(err?.message || err),
          });
        }
      }
    }

    if (!skipStats && strategyIds.length) {
      try {
        await refreshBacktestStrategyStats(base44, strategyIds);
      } catch {
        /* best-effort */
      }
    }

    const more = statusFilter
      ? slice.length === limit
      : won.length === limit || lost.length === limit || open.length === limit;
    const compacted = statusFilter && flipped > 0
      ? offset + Math.max(0, slice.length - flipped)
      : offset + limit;
    return Response.json({
      checked,
      corrected,
      reopened,
      flipped,
      settled,
      offset,
      status: statusFilter,
      nextOffset: more || (statusFilter && flipped > 0 && slice.length > 0)
        ? compacted
        : null,
      examples,
    });
  } catch (err: any) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 });
  }
}
