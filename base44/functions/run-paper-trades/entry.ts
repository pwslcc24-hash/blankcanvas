import { createClientFromRequest } from "npm:@base44/sdk";
import { alertMatchesStrategy, STRATEGY_PRESETS } from "../../shared/strategies.ts";
import { isSkilledForConsensus } from "../../shared/consensus.ts";
import { resolveTradeOutcome, simulatePaperTrade } from "../../shared/paper-trading.ts";
import { withRetry } from "../../shared/retry.ts";

const MAX_CREATES_PER_RUN = 40;

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

    const [alerts, forwardTrades, strategyRows] = await Promise.all([
      base44.entities.ConsensusAlert.filter({ status: "active" }),
      base44.entities.PaperTrade.filter({ is_backtest: false }, "-entry_at", 500),
      base44.entities.PaperStrategy.list(null, 50),
    ]);

    const recentAlerts = alerts.filter((a: any) => a.detected_at >= since);
    const existingKeys = new Set(forwardTrades.map((t: any) => t.trade_key));
    const inactive = new Set(
      strategyRows.filter((s: any) => s.is_active === false).map((s: any) => s.strategy_id)
    );
    const openByStrategy = new Map<string, any[]>();
    for (const t of forwardTrades) {
      if (t.status !== "open") continue;
      if (!openByStrategy.has(t.strategy_id)) openByStrategy.set(t.strategy_id, []);
      openByStrategy.get(t.strategy_id)!.push(t);
    }

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
          participants: [],
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

        const trade = simulatePaperTrade(cluster, preset.strategy_id, preset.params, resolution);
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

      const openTrades = openByStrategy.get(preset.strategy_id) || [];
      for (const t of openTrades) {
        const entryMs = new Date(t.entry_at).getTime();
        const resolution = resolveTradeOutcome(
          t.condition_id,
          t.outcome_index ?? 0,
          entryMs,
          redeems
        );
        if (resolution.status === "open") continue;

        const exitPrice = resolution.exit_price ?? 0;
        const proceeds = (t.shares || 0) * exitPrice;
        const pnl = Math.round((proceeds - (t.stake_usd || 0)) * 100) / 100;

        try {
          await base44.entities.PaperTrade.update(t.id, {
            status: resolution.status,
            exit_at: resolution.exit_at,
            exit_price: exitPrice,
            pnl_usd: pnl,
          });
          resolved += 1;
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
