import { createClientFromRequest } from "npm:@base44/sdk";
import { alertMatchesStrategy, STRATEGY_PRESETS } from "../../shared/strategies.ts";
import { isSkilledForConsensus } from "../../shared/consensus.ts";
import { resolveTradeOutcome, simulatePaperTrade, applyPaperTradeResolution, refreshBacktestStrategyStats, resolveOpenTrade } from "../../shared/paper-trading.ts";
import { resolveDelayedEntryPrice } from "../../shared/polymarket.ts";
import { withRetry } from "../../shared/retry.ts";

const MAX_CREATES_PER_RUN = 80;
const MAX_RESOLVES_PER_RUN = 150;

async function enrichTradeFromActivity(base44: any, trade: any) {
  if (trade.market_slug) return trade;
  try {
    const activity = await base44.entities.WalletActivity.filter(
      { condition_id: trade.condition_id },
      "-occurred_at",
      1
    );
    if (activity[0]?.market_slug) {
      return { ...trade, market_slug: activity[0].market_slug };
    }
  } catch {
    /* best-effort */
  }
  return trade;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchRedeems(base44: any, skilled: any[]): Promise<any[]> {
  const redeems: any[] = [];
  for (const wallet of skilled) {
    try {
      const rows = await withRetry(() =>
        base44.entities.WalletActivity.filter(
          { wallet_address: wallet.address, event_type: "REDEEM" },
          "-occurred_at",
          30
        )
      );
      redeems.push(...rows);
    } catch {
      /* skip wallet on rate limit */
    }
    await sleep(250);
  }
  return redeems;
}

export default async function (req: Request): Promise<Response> {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    if (!user) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = new Date();
    const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();

    const wallets = await base44.entities.TrackedWallet.filter({ is_active: true });
    const skilled = wallets.filter(isSkilledForConsensus);

    let redeems: any[] = [];
    try {
      redeems = await fetchRedeems(base44, skilled);
    } catch {
      redeems = [];
    }

    const [alerts, forwardTrades, strategyRowsRaw] = await Promise.all([
      base44.entities.ConsensusAlert.filter({ status: "active" }),
      base44.entities.PaperTrade.filter({ is_backtest: false }, "-entry_at", 500),
      base44.entities.PaperStrategy.list(null, 50),
    ]);

    let strategyRows = strategyRowsRaw;
    const existingIds = new Set(strategyRows.map((s: any) => s.strategy_id));
    for (const preset of STRATEGY_PRESETS) {
      if (existingIds.has(preset.strategy_id)) continue;
      try {
        const created = await base44.entities.PaperStrategy.create({
          strategy_id: preset.strategy_id,
          name: preset.name,
          params_json: JSON.stringify(preset.params),
          is_active: true,
        });
        strategyRows = [...strategyRows, created];
        existingIds.add(preset.strategy_id);
      } catch {
        /* next run will retry */
      }
    }

    const recentAlerts = alerts.filter((a: any) => a.detected_at >= since);
    const existingKeys = new Set(forwardTrades.map((t: any) => t.trade_key));
    const inactive = new Set(
      strategyRows.filter((s: any) => s.is_active === false).map((s: any) => s.strategy_id)
    );

    const openTradesAll = await base44.entities.PaperTrade.filter({ status: "open" }, "-entry_at", MAX_RESOLVES_PER_RUN);

    let entered = 0;
    let resolved = 0;
    let skippedRateLimit = false;

    for (const preset of STRATEGY_PRESETS) {
      if (inactive.has(preset.strategy_id)) continue;

      for (const alert of recentAlerts) {
        if (entered >= MAX_CREATES_PER_RUN) break;
        if (!alertMatchesStrategy(alert, preset.params)) continue;

        const tradeKey = `${preset.strategy_id}|${alert.signal_key}`;
        if (existingKeys.has(tradeKey)) continue;

        let participants: any[] = [];
        try {
          participants = JSON.parse(alert.participants_json || "[]");
        } catch {
          participants = [];
        }

        const cluster = {
          signal_key: alert.signal_key,
          condition_id: alert.condition_id,
          market_title: alert.market_title,
          market_slug: alert.market_slug,
          outcome: alert.outcome,
          outcome_index: alert.outcome_index,
          first_buy_at: alert.first_buy_at || alert.detected_at,
          last_buy_at: alert.last_buy_at || alert.detected_at,
          wallet_count: alert.wallet_count,
          participants,
          vwap_entry_price: alert.vwap_entry_price,
          total_usdc: alert.total_usdc,
        };

        const entryMs =
          new Date(cluster.last_buy_at).getTime() + preset.params.delaySec * 1000;
        const resolution = resolveTradeOutcome(
          cluster.condition_id,
          cluster.outcome_index ?? 0,
          entryMs,
          redeems
        );

        let entryPrice: number | undefined;
        try {
          entryPrice = await resolveDelayedEntryPrice(
            cluster,
            preset.params.delaySec,
            preset.params.slippage
          );
        } catch {
          /* fall back to VWAP inside simulatePaperTrade */
        }

        const trade = simulatePaperTrade(
          cluster,
          preset.strategy_id,
          preset.params,
          resolution,
          entryPrice
        );
        try {
          await base44.entities.PaperTrade.create({
            ...trade,
            strategy_id: preset.strategy_id,
            is_backtest: false,
            pnl_usd: trade.pnl_usd ?? null,
            exit_at: trade.exit_at ?? null,
            exit_price: trade.exit_price ?? null,
          });
          existingKeys.add(tradeKey);
          entered += 1;
          await sleep(80);
        } catch (err: any) {
          if (/rate limit/i.test(String(err?.message || err))) {
            skippedRateLimit = true;
            break;
          }
          throw err;
        }
      }

      if (skippedRateLimit) break;
    }

    const backtestStrategyIds: string[] = [];
    for (const t of openTradesAll) {
      if (skippedRateLimit) break;
      const trade = await enrichTradeFromActivity(base44, t);
      const resolution = await resolveOpenTrade(trade, redeems);
      if (resolution.status === "open") continue;

      const patch = applyPaperTradeResolution(trade, resolution);
      if (!patch) continue;

      try {
        await base44.entities.PaperTrade.update(t.id, {
          ...patch,
          ...(trade.market_slug && !t.market_slug ? { market_slug: trade.market_slug } : {}),
        });
        resolved += 1;
        if (t.is_backtest) backtestStrategyIds.push(t.strategy_id);
        await sleep(100);
      } catch (err: any) {
        if (/rate limit/i.test(String(err?.message || err))) {
          skippedRateLimit = true;
          break;
        }
        throw err;
      }
    }

    if (backtestStrategyIds.length && !skippedRateLimit) {
      try {
        await refreshBacktestStrategyStats(base44, backtestStrategyIds);
      } catch {
        /* stats refresh is best-effort */
      }
    }

    return Response.json({
      alertsChecked: recentAlerts.length,
      entered,
      resolved,
      partial: skippedRateLimit,
      message: skippedRateLimit
        ? "Partial run — hit rate limit, will continue next cron"
        : undefined,
    });
  } catch (err: any) {
    const message = String(err?.message || err);
    const rateLimited = /rate limit/i.test(message);
    return Response.json(
      {
        error: rateLimited
          ? "Rate limit exceeded — partial progress saved, retry next run"
          : message,
        rateLimited,
      },
      { status: rateLimited ? 429 : 500 }
    );
  }
}
